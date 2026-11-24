// The pool command, run by a person from a trusted machine with CODEX_POOL_TOKEN:
//
//   node dist/pool.js [--repo owner/repo] init
//   node dist/pool.js [--repo owner/repo] seed <account> <session> <auth.json>
//   node dist/pool.js [--repo owner/repo] check
//   node dist/pool.js [--repo owner/repo] recover [--force SESSION]
import { readFileSync } from "node:fs";
import { check, init, recoverPool, seed, type PoolDeps } from "./command.js";
import { poolGitHub } from "./github.js";
import { sealBox } from "./seal.js";
import { gitHubPoolStore } from "./store.js";

const USAGE = `usage: pool [--repo owner/repo] <command>
  init
  seed <account> <session> <auth.json>
  check
  recover [--force SESSION]
Needs CODEX_POOL_TOKEN. The repo defaults to GITHUB_REPOSITORY.`;

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const args = [...argv];
  let repo = env.GITHUB_REPOSITORY;
  const repoAt = args.indexOf("--repo");
  if (repoAt >= 0) {
    repo = args[repoAt + 1];
    args.splice(repoAt, 2);
  }
  const [command, ...rest] = args;
  if (!command) {
    out(USAGE);
    return 2;
  }
  const token = env.CODEX_POOL_TOKEN;
  if (!token) throw new Error("CODEX_POOL_TOKEN isn't set");
  const [owner, name] = (repo ?? "").split("/");
  if (!owner || !name) throw new Error("name the repo with --repo owner/repo");
  const deps: PoolDeps = { github: poolGitHub(token, owner, name), store: gitHubPoolStore(token, owner, name), seal: sealBox };

  switch (command) {
    case "init": {
      const result = await init(deps);
      out(result.stateBranchCreated ? "created the state branch" : "state branch exists");
      out(result.transportKeyCreated ? "made the transport key pair" : "transport key pair exists, kept");
      return 0;
    }
    case "seed": {
      const [account, session, file] = rest;
      if (!account || !session || !file || rest.length > 3) {
        out(USAGE);
        return 2;
      }
      const { secret } = await seed(deps, account, session, readFileSync(file, "utf8"));
      out(`stored ${secret} and added "${account}" to the pool`);
      return 0;
    }
    case "check": {
      const logins = await check(deps.store);
      if (logins.length === 0) out("the pool is empty");
      for (const l of logins) {
        out([l.alias, `session ${l.sessionId}`, l.state, l.owner, l.reason].filter(Boolean).join("  "));
      }
      return 0;
    }
    case "recover": {
      const forceAt = rest.indexOf("--force");
      const force = forceAt >= 0 ? rest[forceAt + 1] : undefined;
      if (forceAt >= 0 && !force) {
        out(USAGE);
        return 2;
      }
      const result = await recoverPool(deps, force);
      if (result.forced) out(`quarantined "${result.forced}" by hand`);
      for (const alias of result.quarantined) out(`quarantined "${alias}": its owner run ended without releasing it`);
      for (const f of result.lookupFailed) out(`kept "${f.alias}" reserved: couldn't look up run ${f.owner.runId} (${f.error})`);
      if (!result.forced && result.quarantined.length === 0 && result.lookupFailed.length === 0) out("nothing to recover");
      return result.lookupFailed.length > 0 ? 1 : 0;
    }
    default:
      out(USAGE);
      return 2;
  }
}
