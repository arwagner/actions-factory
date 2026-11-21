import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** Never reach an agent, whatever the step's environment holds (§9). */
export const WITHHELD = ["GITHUB_TOKEN", "GH_TOKEN", "FACTORY_TOKEN", "FACTORY_CHECK_ENV", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];

/** The step's environment minus every GitHub and factory token, plus `extra`. */
export function agentEnv(extra: Record<string, string> = {}, drop: string[] = []): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [...WITHHELD, ...drop]) delete env[name];
  return { ...env, ...extra };
}

/**
 * Runs a CLI in its own process group, so a timeout also stops the tools it started. Collects stdout; stderr
 * goes to the job log.
 */
export function runCli(
  binary: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number },
): Promise<{ code: number; stdout: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
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

/** Installs a pinned npm CLI once into the runner's agent cache, which the workflow caches by version. Returns its binary. */
export async function installPinned(agent: string, pkg: string, version: string, bin: string): Promise<string> {
  const root = process.env.FACTORY_AGENT_CACHE ?? join(homedir(), ".factory-agents");
  const dir = join(root, agent, version);
  const binary = join(dir, "node_modules", ".bin", bin);
  if (!existsSync(binary)) {
    mkdirSync(dir, { recursive: true });
    await promisify(execFile)("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund", `${pkg}@${version}`]);
  }
  return binary;
}

/** Each line of NDJSON output that parses, skipping warnings and partial lines. */
export function jsonLines(ndjson: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of ndjson.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Not JSON after all.
    }
  }
  return events;
}

/**
 * The plan from an agent's final message, for CLIs without a schema flag or runs that can't write files: the
 * message's JSON object, with any code fence around it. Undefined if there's none.
 */
export function planFromMessage(message: string | undefined): unknown {
  if (!message) return undefined;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(message);
  const text = fenced ? fenced[1] : message;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Told to an agent that can't write files in this run, after the factory's prompt. */
export const READ_ONLY_PLAN =
  "\n\nThis run can't write files. Don't write the plan file: end with the plan JSON as your final message, and nothing else.\n";
