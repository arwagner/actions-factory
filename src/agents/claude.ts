import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { scrubValues } from "./scrub.js";
import type { Adapter, AdapterOutput } from "./types.js";

/** Pinned per factory release; nothing installs "latest" at run time (§6). */
export const CLAUDE_CODE_VERSION = "2.1.319";

const CREDENTIALS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/** Never reach the agent, whatever the step's environment holds (§9). */
const WITHHELD = ["GITHUB_TOKEN", "GH_TOKEN", "FACTORY_TOKEN", "FACTORY_CHECK_ENV", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];

export interface ClaudeOptions {
  /** Returns the path of the `claude` binary, installing the pinned version if needed. */
  install?: () => Promise<string>;
  /** Where the CLI looks for user-level skills. */
  skillsDir?: string;
}

/** Claude Code, headless: `claude -p`, stream-json transcript, the plan as `--json-schema` structured output. */
export function claudeAdapter(options: ClaudeOptions = {}): Adapter {
  const install = options.install ?? installPinned;
  const skillsDir = options.skillsDir ?? join(homedir(), ".claude", "skills");
  return {
    name: "claude",
    credentials: CREDENTIALS,
    async ping() {
      const env = { ...process.env };
      for (const name of WITHHELD) delete env[name];
      const secrets = CREDENTIALS.map((name) => process.env[name]).filter((v): v is string => Boolean(v));
      const { code, stdout, timedOut } = await runCli(await install(), ["-p", "--output-format", "json", "--max-turns", "1"], {
        cwd: mkdtempSync(join(tmpdir(), "factory-doctor-")),
        env,
        stdin: "Reply with the single word OK.",
        timeoutMs: 3 * 60_000,
      });
      if (timedOut) return { ok: false, detail: "Claude Code didn't answer within 3 minutes" };
      let result: { is_error?: boolean; result?: string; total_cost_usd?: number } | undefined;
      try {
        result = JSON.parse(stdout.trim().split("\n").pop() ?? "");
      } catch {
        result = undefined;
      }
      const said = scrubValues(String(result?.result ?? stdout).trim(), secrets).slice(0, 300);
      if (code !== 0 || !result || result.is_error) return { ok: false, detail: `Claude Code ${CLAUDE_CODE_VERSION} failed: ${said || `exit ${code}`}` };
      return { ok: true, detail: `Claude Code ${CLAUDE_CODE_VERSION} answered a test prompt` };
    },
    async run(input) {
      for (const [name, path] of Object.entries(input.skills)) {
        mkdirSync(skillsDir, { recursive: true });
        cpSync(path, join(skillsDir, name), { recursive: true });
      }
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", readFileSync(input.planSchemaFile, "utf8")];
      args.push("--permission-mode", "bypassPermissions");
      if (input.permission === "read-only") args.push("--restricted", "--disallowedTools", "Edit", "Write", "NotebookEdit");
      if (input.model) args.push("--model", input.model);

      const env = { ...process.env };
      for (const name of WITHHELD) delete env[name];
      const secrets = CREDENTIALS.map((name) => process.env[name]).filter((v): v is string => Boolean(v));

      const { code, stdout, timedOut } = await runCli(await install(), args, {
        cwd: input.checkout,
        env,
        stdin: readFileSync(input.promptFile, "utf8"),
        timeoutMs: input.timeoutMinutes * 60_000,
      });
      writeFileSync(input.transcriptFile, scrubValues(stdout, secrets));

      const result = lastResult(stdout);
      if (result?.structured_output !== undefined) writeFileSync(input.planFile, JSON.stringify(result.structured_output, null, 2));
      const usage = result
        ? { inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens, costUsd: result.total_cost_usd }
        : undefined;
      const status: AdapterOutput["status"] = timedOut ? "timed-out" : code !== 0 || !result || result.is_error ? "failed" : "ok";
      return { status, usage };
    },
  };
}

interface ResultEvent {
  type: "result";
  is_error?: boolean;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function lastResult(ndjson: string): ResultEvent | undefined {
  const lines = ndjson.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string };
      if (event.type === "result") return event as ResultEvent;
    } catch {
      // Not every line is JSON (warnings, partial output); skip them.
    }
  }
  return undefined;
}

function runCli(
  binary: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number },
): Promise<{ code: number; stdout: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout also stops the tools the CLI started.
    const child = spawn(binary, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "inherit"], detached: true });
    let stdout = "";
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, timedOut });
    });
    child.stdin.end(opts.stdin);
  });
}

/** Installs the pinned CLI once per runner tool cache; the workflow caches that folder by version. */
async function installPinned(): Promise<string> {
  const root = process.env.FACTORY_AGENT_CACHE ?? join(homedir(), ".factory-agents");
  const dir = join(root, "claude", CLAUDE_CODE_VERSION);
  const binary = join(dir, "node_modules", ".bin", "claude");
  if (!existsSync(binary)) {
    mkdirSync(dir, { recursive: true });
    await promisify(execFile)("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`]);
  }
  return binary;
}
