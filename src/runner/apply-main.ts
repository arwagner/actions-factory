import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitFetcher } from "../config/fetch.js";
import { loadConfig } from "../config/load.js";
import { gitHubApi } from "../router/github.js";
import type { Decision } from "../router/route.js";
import { type ApplyTask, applyRun } from "./apply.js";
import { bundledWork } from "./bundle.js";
import type { HandoffMeta } from "./handoff.js";
import { renderApplySummary } from "./summary.js";

/** The apply job's entrypoint: wires `applyRun` to the Actions environment. */
async function main(): Promise<void> {
  const env = (name: string) => process.env[name] || undefined;
  const required = (name: string) => {
    const value = env(name);
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const decision = JSON.parse(required("DECISION")) as Decision;
  if (decision.kind !== "run") return;
  const [owner, repo] = required("GITHUB_REPOSITORY").split("/");
  const token = required("FACTORY_TOKEN");
  // The work happens in the workspace: a pull request's head for PR tasks. The config always comes from the base
  // (FACTORY_CONFIG_ROOT for PR tasks), so a PR can't change the rules it runs under.
  const checkout = required("GITHUB_WORKSPACE");
  const base = env("FACTORY_CONFIG_ROOT") ?? checkout;
  const handoff = required("HANDOFF_DIR");

  const loaded = await loadConfig({
    clientRoot: base,
    factoryRoot: required("FACTORY_ROOT"),
    fetchRepo: gitFetcher({ cacheDir: join(required("RUNNER_TEMP"), "factory-templates"), token }),
  });
  if (!loaded.ok) throw new Error("the factory config no longer validates");
  const task = (loaded.config.tasks as Record<string, ApplyTask & { planSchema?: string }>)[decision.task];

  const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
  const meta: HandoffMeta = readJson(join(handoff, "meta.json")) ?? { agentStatus: "failed", checksPassed: false };
  const server = env("GITHUB_SERVER_URL") ?? "https://github.com";
  const runUrl = `${server}/${owner}/${repo}/actions/runs/${required("GITHUB_RUN_ID")}`;

  const result = await applyRun({
    taskName: decision.task,
    task,
    subject: decision.subject,
    batchNumbers: meta.batchNumbers,
    planSchema: task.planSchema ? readJson(task.planSchema) : undefined,
    plan: readJson(join(handoff, "plan.json")),
    agentStatus: meta.agentStatus,
    agentError: meta.agentError,
    checksPassed: meta.checksPassed,
    git: bundledWork({ checkout, bundle: join(handoff, "work.bundle"), remote: `${server}/${owner}/${repo}`, token }),
    api: gitHubApi(token, owner, repo, env("GITHUB_API_URL")),
    runId: required("GITHUB_RUN_ID"),
    runUrl,
    assignee: loaded.config.assignee as string | undefined,
    prsGetFactoryReview: Object.values(loaded.config.tasks as Record<string, ApplyTask>).some(
      (t) => t.subject === "pr" && t.label !== undefined && !t.writes.merge,
    ),
    runHook: (path, hookEnv) => runHook(path, { ...hookEnv, FACTORY_TOKEN: token, GH_TOKEN: token }, checkout),
  });
  appendFileSync(required("GITHUB_STEP_SUMMARY"), `${renderApplySummary({ taskName: decision.task, result, meta, runUrl })}\n`);
  if (!result.ok) {
    console.log(`::error title=actions-factory::${escape(result.reason)}`);
    process.exitCode = 1;
  }
}

/** Runs a hook script: `.sh` with bash, `.js`/`.mjs` with node, anything else directly. */
function runHook(path: string, hookEnv: Record<string, string>, cwd: string): Promise<void> {
  const [command, args] = path.endsWith(".sh") ? ["bash", [path]] : /\.m?js$/.test(path) ? ["node", [path]] : [path, []];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...hookEnv }, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the after hook exited with ${code}`))));
  });
}

function escape(message: string): string {
  return message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

main().catch((error: unknown) => {
  console.log(`::error title=actions-factory apply::${escape(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
