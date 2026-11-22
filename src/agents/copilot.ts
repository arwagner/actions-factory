import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentEnv, installPinned, jsonLines, planFromMessage, READ_ONLY_PLAN, runCli } from "./cli.js";
import { scrubValues } from "./scrub.js";
import type { Adapter, AdapterOutput } from "./types.js";

/** Pinned per factory release; nothing installs "latest" at run time (§6). */
export const COPILOT_VERSION = "1.0.107";

const CREDENTIALS = ["COPILOT_GITHUB_TOKEN"];

export interface CopilotOptions {
  /** Returns the path of the `copilot` binary, installing the pinned version if needed. */
  install?: () => Promise<string>;
}

/** The flags every Copilot run shares: headless, JSONL, no GitHub MCP server, no prompts, no self-update. */
const BASE = ["--output-format", "json", "--no-auto-update", "--no-ask-user", "--disable-builtin-mcps", "--secret-env-vars", "COPILOT_GITHUB_TOKEN"];

/**
 * Copilot CLI, headless: `copilot -p`. It authenticates with `COPILOT_GITHUB_TOKEN` alone (a token with only
 * Copilot Requests); every other GitHub token is withheld, and the built-in GitHub MCP server is off. Its own
 * home in a temp folder holds the task's skills. Reports tokens where its events carry them; no dollars.
 */
export function copilotAdapter(options: CopilotOptions = {}): Adapter {
  const install = options.install ?? (() => installPinned("copilot", "@github/copilot", COPILOT_VERSION, "copilot"));
  const secrets = () => CREDENTIALS.map((n) => process.env[n]).filter((v): v is string => Boolean(v));

  return {
    name: "copilot",
    credentials: CREDENTIALS,
    async install() {
      await install();
    },
    async run(input) {
      const binary = await install();
      const home = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "factory-copilot-"));
      try {
        for (const [name, path] of Object.entries(input.skills)) cpSync(path, join(home, "skills", name), { recursive: true });
        const prompt = readFileSync(input.promptFile, "utf8") + (input.permission === "read-only" ? READ_ONLY_PLAN : "");
        const args = ["-p", prompt, ...BASE, "--allow-all-tools", "--add-dir", dirname(input.planFile)];
        // Read-only removes the file-writing tool. (Copilot has no OS sandbox; the apply job also refuses pushes
        // from a task that may not push.)
        if (input.permission === "read-only") args.push("--deny-tool", "write");
        if (input.model) args.push("--model", input.model);

        const { code, stdout, timedOut } = await runCli(binary, args, {
          cwd: input.checkout,
          env: agentEnv({ COPILOT_HOME: home }),
          stdin: "",
          timeoutMs: input.timeoutMinutes * 60_000,
        });
        writeFileSync(input.transcriptFile, scrubValues(stdout, secrets()));

        const events = jsonLines(stdout);
        if (!existsSync(input.planFile)) {
          const plan = planFromMessage(lastMessage(events));
          if (plan !== undefined) writeFileSync(input.planFile, JSON.stringify(plan, null, 2));
        }
        const status: AdapterOutput["status"] = timedOut ? "timed-out" : code !== 0 ? "failed" : "ok";
        return { status, usage: usage(events) };
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    async ping() {
      const binary = await install();
      const home = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "factory-copilot-"));
      try {
        const { code, stdout, timedOut } = await runCli(binary, ["-p", "Reply with the single word OK.", ...BASE], {
          cwd: home,
          env: agentEnv({ COPILOT_HOME: home }),
          stdin: "",
          timeoutMs: 3 * 60_000,
        });
        if (timedOut) return { ok: false, detail: "Copilot didn't answer within 3 minutes" };
        if (code === 0) return { ok: true, detail: `Copilot CLI ${COPILOT_VERSION} answered a test prompt` };
        const said = scrubValues(stdout.trim().split("\n").slice(-3).join(" "), secrets()).slice(0, 300);
        return { ok: false, detail: `Copilot CLI ${COPILOT_VERSION} failed: ${said || `exit ${code}`}` };
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

/** The agent's last message, from `assistant.message` events. */
function lastMessage(events: Array<Record<string, unknown>>): string | undefined {
  const messages = events.filter((e) => e.type === "assistant.message");
  const data = messages.at(-1)?.data as { content?: unknown } | undefined;
  return typeof data?.content === "string" ? data.content : undefined;
}

/** Summed over `assistant.usage` events. */
function usage(events: Array<Record<string, unknown>>): AdapterOutput["usage"] {
  let input: number | undefined;
  let output: number | undefined;
  for (const e of events) {
    if (e.type !== "assistant.usage") continue;
    const d = e.data as { inputTokens?: number; outputTokens?: number } | undefined;
    if (typeof d?.inputTokens === "number") input = (input ?? 0) + d.inputTokens;
    if (typeof d?.outputTokens === "number") output = (output ?? 0) + d.outputTokens;
  }
  return input === undefined && output === undefined ? undefined : { inputTokens: input, outputTokens: output };
}
