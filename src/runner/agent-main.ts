import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../agents/index.js";
import { gitFetcher } from "../config/fetch.js";
import { loadConfig } from "../config/load.js";
import { gitHubApi } from "../router/github.js";
import type { Decision } from "../router/route.js";
import { type AgentJobIO, type AgentTask, handoff, prepare, runChecks, runTurn } from "./agent-job.js";
import { doctorAgent } from "./doctor-agent.js";

/** The agent job's entrypoint: `agent.js prepare | turn <n> | checks <n> | handoff`, or `agent.js doctor` in the doctor's agent job. */
async function main(): Promise<void> {
  const env = (name: string) => process.env[name] || undefined;
  const required = (name: string) => {
    const value = env(name);
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const [step, n] = process.argv.slice(2);
  if (step === "install") {
    // The tick's cache-warming job: install the pinned CLI, which that job then saves to the cache.
    await ADAPTERS[required("AGENT")]?.install?.();
    return;
  }
  if (step === "doctor") {
    const ok = await doctorAgent({
      agent: required("AGENT"),
      adapters: ADAPTERS,
      env: process.env,
      summary: (markdown) => appendFileSync(required("GITHUB_STEP_SUMMARY"), `${markdown}\n`),
    });
    if (!ok) process.exitCode = 1;
    return;
  }
  const decision = JSON.parse(required("DECISION")) as Decision;
  if (decision.kind !== "run") return;
  const [owner, repo] = required("GITHUB_REPOSITORY").split("/");
  // The work happens in the workspace: a pull request's head for PR tasks. The config always comes from the base
  // (FACTORY_CONFIG_ROOT for PR tasks), so a PR can't change the rules it runs under.
  const checkout = required("GITHUB_WORKSPACE");
  const base = env("FACTORY_CONFIG_ROOT") ?? checkout;
  const temp = required("RUNNER_TEMP");

  const loaded = await loadConfig({
    clientRoot: base,
    factoryRoot: required("FACTORY_ROOT"),
    fetchRepo: gitFetcher({ cacheDir: join(temp, "factory-templates") }),
  });
  if (!loaded.ok) throw new Error("the factory config no longer validates");
  const config = loaded.config;
  const raw = (config.tasks as Record<string, Record<string, unknown>>)[decision.task];
  const instructions = [config.instructions, raw.instructions].filter((s): s is string => typeof s === "string").join("\n\n");
  const task: AgentTask = {
    ...(raw as unknown as AgentTask),
    name: decision.task,
    agent: (raw.agent ?? config.agent) as string,
    model: (raw.model ?? config.model) as string | undefined,
    instructions: instructions || undefined,
    checks: config.checks as string[],
  };

  const io: AgentJobIO = {
    workDir: join(temp, "factory"),
    checkout,
    task,
    subject: decision.subject,
    api: () => gitHubApi(required("GITHUB_TOKEN"), owner, repo, env("GITHUB_API_URL")),
    adapters: ADAPTERS,
    uploadTranscript: env("FACTORY_REPO_PRIVATE") === "true",
    runCommand: (command, values) => runStreaming("bash", ["-c", command], checkout, values),
    runHook: async (path, hookEnv) => {
      const [command, args] = path.endsWith(".sh") ? ["bash", [path]] : /\.m?js$/.test(path) ? ["node", [path]] : [path, []];
      const { code } = await runStreaming(command, args, checkout, hookEnv);
      if (code !== 0) throw new Error(`the before hook exited with ${code}`);
    },
    log: (line) => console.log(line),
    env: process.env,
  };

  switch (step) {
    case "prepare":
      return prepare(io);
    case "turn":
      return runTurn(io, Number(n));
    case "checks":
      return runChecks(io, Number(n), env("FACTORY_CHECK_ENV"));
    case "handoff":
      return handoff(io);
    default:
      throw new Error(`unknown step ${step}`);
  }
}

/** Runs a command with extra env, streaming output to the log and keeping a copy. */
function runStreaming(command: string, args: string[], cwd: string, extra: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer, to: NodeJS.WriteStream) => {
      output += chunk.toString();
      to.write(chunk);
    };
    child.stdout.on("data", (c: Buffer) => keep(c, process.stdout));
    child.stderr.on("data", (c: Buffer) => keep(c, process.stderr));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error title=actions-factory agent::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
  process.exit(1);
});
