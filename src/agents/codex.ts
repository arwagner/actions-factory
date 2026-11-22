import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentEnv, installPinned, jsonLines, planFromMessage, READ_ONLY_PLAN, runCli } from "./cli.js";
import { scrubValues } from "./scrub.js";
import type { Adapter, AdapterOutput } from "./types.js";

/** Pinned per factory release; nothing installs "latest" at run time (§6). */
export const CODEX_VERSION = "0.167.0";

const CREDENTIALS = ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"];

export interface CodexOptions {
  /** Returns the path of the `codex` binary, installing the pinned version if needed. */
  install?: () => Promise<string>;
}

/**
 * Codex, headless: `codex exec --json`. Its own home in a temp folder holds the login and the task's skills.
 * An API key reaches it as `CODEX_API_KEY` (what `exec` reads); a Business/Enterprise access token is logged in
 * with `codex login --with-access-token`. No ChatGPT `auth.json` is ever used (§6). Reports tokens, not dollars.
 */
export function codexAdapter(options: CodexOptions = {}): Adapter {
  const install = options.install ?? (() => installPinned("codex", "@openai/codex", CODEX_VERSION, "codex"));

  /** A fresh `CODEX_HOME`, logged in, and the environment that goes with it. */
  async function session(binary: string): Promise<{ home: string; env: NodeJS.ProcessEnv; secrets: string[] }> {
    const home = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "factory-codex-"));
    const apiKey = process.env.OPENAI_API_KEY;
    const accessToken = process.env.CODEX_ACCESS_TOKEN;
    const secrets = [apiKey, accessToken].filter((v): v is string => Boolean(v));
    // One credential only: Codex warns when several auth variables are set.
    const env = agentEnv({ CODEX_HOME: home, ...(apiKey ? { CODEX_API_KEY: apiKey } : {}) }, CREDENTIALS);
    if (!apiKey && accessToken) await login(binary, env, accessToken);
    return { home, env, secrets };
  }

  return {
    name: "codex",
    credentials: CREDENTIALS,
    async install() {
      await install();
    },
    async run(input) {
      const binary = await install();
      const { home, env, secrets } = await session(binary);
      try {
        for (const [name, path] of Object.entries(input.skills)) cpSync(path, join(home, "skills", name), { recursive: true });
        const lastMessage = join(home, "last-message.txt");
        const args = ["exec", "--json", "--skip-git-repo-check", "-o", lastMessage];
        // Read-only is enforced by Codex's sandbox. Editing runs unsandboxed: the runner is the sandbox, as for Claude.
        if (input.permission === "read-only") args.push("--sandbox", "read-only");
        else args.push("--dangerously-bypass-approvals-and-sandbox", "--add-dir", dirname(input.planFile));
        if (input.model) args.push("--model", input.model);
        args.push("-");

        const prompt = readFileSync(input.promptFile, "utf8") + (input.permission === "read-only" ? READ_ONLY_PLAN : "");
        const { code, stdout, timedOut } = await runCli(binary, args, { cwd: input.checkout, env, stdin: prompt, timeoutMs: input.timeoutMinutes * 60_000 });
        writeFileSync(input.transcriptFile, scrubValues(stdout, secrets));

        if (!existsSync(input.planFile)) {
          const plan = planFromMessage(existsSync(lastMessage) ? readFileSync(lastMessage, "utf8") : undefined);
          if (plan !== undefined) writeFileSync(input.planFile, JSON.stringify(plan, null, 2));
        }
        const events = jsonLines(stdout);
        const failed = events.some((e) => e.type === "turn.failed");
        const status: AdapterOutput["status"] = timedOut ? "timed-out" : code !== 0 || failed ? "failed" : "ok";
        return { status, usage: usage(events) };
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    async ping() {
      const binary = await install();
      const { home, env, secrets } = await session(binary);
      try {
        const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"];
        const { code, stdout, timedOut } = await runCli(binary, args, { cwd: home, env, stdin: "Reply with the single word OK.", timeoutMs: 3 * 60_000 });
        if (timedOut) return { ok: false, detail: "Codex didn't answer within 3 minutes" };
        const events = jsonLines(stdout);
        if (code === 0 && events.some((e) => e.type === "turn.completed")) return { ok: true, detail: `Codex ${CODEX_VERSION} answered a test prompt` };
        const error = [...events].reverse().find((e) => typeof e.message === "string")?.message as string | undefined;
        return { ok: false, detail: `Codex ${CODEX_VERSION} failed: ${scrubValues(error ?? `exit ${code}`, secrets).slice(0, 300)}` };
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

function login(binary: string, env: NodeJS.ProcessEnv, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ["login", "--with-access-token"], { env }, (error) =>
      error ? reject(new Error("codex login --with-access-token failed; check CODEX_ACCESS_TOKEN")) : resolve(),
    );
    child.stdin?.end(token);
  });
}

/** Summed over `turn.completed` events. Codex reports tokens only. */
function usage(events: Array<Record<string, unknown>>): AdapterOutput["usage"] {
  let input: number | undefined;
  let output: number | undefined;
  for (const e of events) {
    if (e.type !== "turn.completed") continue;
    const u = e.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (u?.input_tokens !== undefined) input = (input ?? 0) + u.input_tokens;
    if (u?.output_tokens !== undefined) output = (output ?? 0) + u.output_tokens;
  }
  return input === undefined && output === undefined ? undefined : { inputTokens: input, outputTokens: output };
}
