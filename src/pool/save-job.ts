import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { poolGitHub } from "./github.js";
import { POOL_SEALED_FILE, type PoolHandoff } from "./lease-run.js";
import { openBox, sealBox } from "./seal.js";
import { gitHubPoolStore } from "./store.js";
import { saveBack, type SaveBackDeps, type SaveOutcome } from "./save-back.js";

/**
 * The saving job's entrypoint (`apply.js pool-save`). Runs only factory code, never the agent's: it opens the
 * sealed handoff with the transport private key, then saves back or quarantines each login this run holds.
 * Returns the outcomes; the caller fails the job if any login was quarantined, so a person looks.
 */
export async function savePool(env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<SaveOutcome[]> {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const [owner, repo] = required("GITHUB_REPOSITORY").split("/");
  const apiUrl = env.GITHUB_API_URL || undefined;
  const deps: SaveBackDeps = {
    github: poolGitHub(required("CODEX_POOL_TOKEN"), owner!, repo!, apiUrl),
    store: gitHubPoolStore(required("FACTORY_TOKEN"), owner!, repo!, apiUrl),
    seal: sealBox,
    owner: { runId: required("GITHUB_RUN_ID"), attempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1) },
    handoff: undefined,
    secrets: env,
  };
  const file = join(required("POOL_HANDOFF_DIR"), POOL_SEALED_FILE);
  if (existsSync(file)) {
    try {
      deps.handoff = JSON.parse(await openBox(readFileSync(file, "utf8"), required("CODEX_POOL_TRANSPORT_PRIVATE_KEY"))) as PoolHandoff;
    } catch {
      out("::warning::the sealed handoff didn't open: every login this run holds will be quarantined");
    }
  }
  const outcomes = await saveBack(deps);
  for (const o of outcomes) out(`${o.alias}: ${o.result}${o.reason ? ` (${o.reason})` : ""}`);
  if (outcomes.length === 0) out("this run holds no Codex login");
  return outcomes;
}
