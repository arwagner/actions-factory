import type { Check } from "../router/doctor.js";
import { loginStatuses, POOL_ENVIRONMENT } from "./command.js";
import type { PoolGitHub } from "./github.js";
import type { PoolStore } from "./pool.js";
import { poolAlias } from "./summary.js";

interface PoolDoctorIO {
  store: Pick<PoolStore, "read">;
  github: Pick<PoolGitHub, "environment" | "hasBranchRule">;
  writer?: Pick<PoolGitHub, "probeEnvironmentSecretWrite">;
  /** Another sign the pool was configured, such as the transport public key. */
  configured: boolean;
}

/** Returns no checks for clients with no sign of an opt-in pool. Does not touch a login. */
export async function poolDoctorChecks({ store, github, writer, configured }: PoolDoctorIO): Promise<Check[] | undefined> {
  const [env, state] = await Promise.allSettled([github.environment(POOL_ENVIRONMENT), store.read()]);
  const environment = env.status === "fulfilled" ? env.value : undefined;
  const snapshot = state.status === "fulfilled" ? state.value : undefined;
  if (!configured && !writer && !environment && !snapshot?.token) return undefined;

  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fix: string) => {
    checks.push({ name: `Codex pool: ${name}`, ok, detail, ...(ok ? {} : { fix }) });
  };
  add("environment", Boolean(environment), environment ? "exists" : env.status === "rejected" ? "could not read it" : "missing",
    "Create the `codex-pool` environment and allow the workflow to read it.");
  if (environment) {
    const protectedByRule = environment.selectedBranches && await github.hasBranchRule(POOL_ENVIRONMENT).catch(() => false);
    add("branch rules", protectedByRule, protectedByRule ? "selected branches, with a branch rule" : "no verified branch rule",
      "Choose Selected branches and tags and add a branch rule for the trusted client branch. Check Actions read access if a rule exists.");
  }

  add("state branch", Boolean(snapshot?.token), snapshot?.token ? "exists" : state.status === "rejected" ? "could not read it" : "missing",
    "Check that `FACTORY_TOKEN` can read Contents and run `node dist/pool.js init` to create the branch if missing.");
  const status = writer && environment ? await writer.probeEnvironmentSecretWrite(POOL_ENVIRONMENT).catch(() => 0) : undefined;
  add("save-back token", status === 422,
    !writer ? "not set" : !environment ? "set, but no environment to check" : status === 422 ? "can write environment secrets" : status ? `GitHub answered ${status}` : "no answer from GitHub",
    "Set or replace the repository secret `CODEX_POOL_TOKEN` with a client-scoped token with Environments write. Recheck after the environment exists.");

  if (snapshot?.token) {
    const logins = loginStatuses(snapshot.state);
    if (logins.length === 0) add("logins", false, "none enrolled", "Enroll a fresh login with `node dist/pool.js seed`.");
    for (const login of logins) {
      // The persisted reason can contain an API error. Do not copy it into the Actions summary.
      const detail = login.state === "leased" && /^run \d+ attempt \d+$/.test(login.owner ?? "") ? `leased by ${login.owner}` : login.state;
      add(poolAlias(login.alias), login.state !== "quarantined", detail, "Inspect with `node dist/pool.js check`, then reseed or remove the quarantined login.");
    }
  }
  return checks;
}
