import { createHash } from "node:crypto";
import type { PoolGitHub } from "./github.js";
import { credentialHash, quarantine, recover, update, type Account, type PoolState, type PoolStore, type RecoverReport } from "./pool.js";
import { transportKeyPair, type Seal } from "./seal.js";

/** The environment holding the logins. */
export const POOL_ENVIRONMENT = "codex-pool";
/** The repository variable the agent job reads the transport public key from. */
export const TRANSPORT_PUBLIC_VARIABLE = "CODEX_POOL_TRANSPORT_PUBLIC_KEY";
/** The repository secret passed only to the save-back job. */
export const TRANSPORT_PRIVATE_SECRET = "CODEX_POOL_TRANSPORT_PRIVATE_KEY";

/** GitHub requires explicit secret names at each reusable-workflow boundary. */
export const POOL_SESSIONS = Array.from({ length: 8 }, (_, i) => `slot-${String(i + 1).padStart(2, "0")}`);

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The secret that holds a session's login. */
export const authSecretName = (sessionId: string): string => `CODEX_AUTH_${sessionId.toUpperCase().replace(/-/g, "_")}`;

export interface PoolDeps {
  github: PoolGitHub;
  store: PoolStore;
  seal: Seal;
}

export interface InitResult {
  stateBranchCreated: boolean;
  transportKeyCreated: boolean;
}

/**
 * Checks the repo and the `codex-pool` environment (it must exist and limit deployments to selected branches),
 * creates the state branch if missing, and makes the transport key pair if there isn't one. Safe to rerun: an
 * existing key pair is kept, because replacing it would strand runs already in flight.
 */
export async function init({ github, store, seal }: PoolDeps): Promise<InitResult> {
  if (!(await github.repoExists())) throw new Error("the repo doesn't exist, or CODEX_POOL_TOKEN can't see it");
  const environment = await github.environment(POOL_ENVIRONMENT);
  if (!environment) throw new Error(`create the "${POOL_ENVIRONMENT}" environment first (Settings, Environments)`);
  if (!environment.selectedBranches) {
    throw new Error(`the "${POOL_ENVIRONMENT}" environment must limit deployment branches to "Selected branches and tags"`);
  }

  const snapshot = await store.read();
  const stateBranchCreated = snapshot.token === undefined;
  if (stateBranchCreated && !(await store.write(snapshot.state, undefined))) {
    // Somebody created it between our read and write: fine, it exists.
    return init({ github, store, seal });
  }

  const published = await github.getVariable(TRANSPORT_PUBLIC_VARIABLE);
  const hasPrivate = await github.hasRepositorySecret(TRANSPORT_PRIVATE_SECRET);
  if (published && hasPrivate) return { stateBranchCreated, transportKeyCreated: false };

  const pair = await transportKeyPair();
  const key = await github.repositoryKey();
  // Private half first: a public key must never be published without its private half stored.
  await github.putRepositorySecret(TRANSPORT_PRIVATE_SECRET, { keyId: key.keyId, value: await seal(pair.privateKey, key.key) });
  await github.setVariable(TRANSPORT_PUBLIC_VARIABLE, pair.publicKey);
  return { stateBranchCreated, transportKeyCreated: true };
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The refresh token in an `auth.json`'s text; throws if it isn't a ChatGPT login. */
export function refreshToken(authJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    throw new Error("auth.json isn't valid JSON");
  }
  const token = (parsed as { tokens?: { refresh_token?: unknown } } | null)?.tokens?.refresh_token;
  if (typeof token !== "string" || token === "") throw new Error("auth.json has no ChatGPT login (tokens.refresh_token)");
  return token;
}

/**
 * Stores a login as `CODEX_AUTH_<SESSION>` and records it in the pool. Refuses a duplicate account, session or
 * secret name, and a login whose refresh token is one already seeded (a copy: the two would invalidate each other).
 */
export async function seed({ github, store, seal }: PoolDeps, alias: string, sessionId: string, authJson: string): Promise<{ secret: string }> {
  for (const [what, value] of [["account", alias], ["session", sessionId]] as const) {
    if (!NAME.test(value)) throw new Error(`the ${what} ID must be letters, digits, "-" and "_" (got "${value}")`);
  }
  if (!POOL_SESSIONS.includes(sessionId)) throw new Error("session ID must be slot-01 through slot-08");
  const seedHash = sha(refreshToken(authJson));
  const secret = authSecretName(sessionId);

  const refusal = (accounts: Record<string, Account>): string | undefined => {
    if (alias in accounts) return `account "${alias}" is already in the pool`;
    for (const [other, account] of Object.entries(accounts)) {
      if (authSecretName(account.sessionId) === secret) return `session "${sessionId}" collides with the session of "${other}"`;
      if (account.seedHash === seedHash) return `this login's refresh token is already seeded as "${other}": make a fresh login, don't copy one`;
    }
    return undefined;
  };

  const before = refusal((await store.read()).state.accounts);
  if (before) throw new Error(before);

  const key = await github.environmentKey(POOL_ENVIRONMENT);
  await github.putEnvironmentSecret(POOL_ENVIRONMENT, secret, { keyId: key.keyId, value: await seal(authJson, key.key) });
  await update(store, (state) => {
    const again = refusal(state.accounts);
    if (again) throw new Error(again);
    state.accounts[alias] = { sessionId, hash: credentialHash(authJson), seedHash };
    return { state, result: undefined };
  });
  return { secret };
}

/** Retires an idle login before deleting its secret so another run cannot lease it mid-removal. */
export async function remove({ github, store }: PoolDeps, alias: string): Promise<void> {
  const account = await update(store, (state) => {
    const login = Object.hasOwn(state.accounts, alias) ? state.accounts[alias] : undefined;
    if (!login) throw new Error(`no login named "${alias}" in the pool`);
    if (login.lease) throw new Error(`"${alias}" has an active lease; wait for the owner run to finish`);
    if (login.quarantine) return { result: login };
    login.quarantine = { reason: "retired for removal" };
    return { state, result: login };
  });

  await github.deleteEnvironmentSecret(POOL_ENVIRONMENT, authSecretName(account.sessionId));
  await update(store, (current) => {
    const login = current.accounts[alias];
    if (!login?.quarantine || login.lease || login.sessionId !== account.sessionId || login.hash !== account.hash) {
      throw new Error("the pool changed during removal; check the login before trying again");
    }
    delete current.accounts[alias];
    return { state: current, result: undefined };
  });
}

export interface LoginStatus {
  alias: string;
  sessionId: string;
  state: "free" | "leased" | "quarantined";
  /** The lease owner, as `run <id> attempt <n>`. */
  owner?: string;
  reason?: string;
}

/** Read-only: each login's state and lease owner. */
export async function check(store: PoolStore): Promise<LoginStatus[]> {
  return loginStatuses((await store.read()).state);
}

export function loginStatuses(state: PoolState): LoginStatus[] {
  return Object.entries(state.accounts).map(([alias, a]): LoginStatus => {
    const base = { alias, sessionId: a.sessionId };
    if (a.quarantine) return { ...base, state: "quarantined", reason: a.quarantine.reason };
    if (a.lease) return { ...base, state: "leased", owner: `run ${a.lease.runId} attempt ${a.lease.attempt}` };
    return { ...base, state: "free" };
  });
}

export interface RecoverResult extends RecoverReport {
  /** The login quarantined by `--force`, if any. */
  forced?: string;
}

/**
 * Quarantines logins whose owner run ended without releasing. With `force`, also quarantines the login of that
 * session now, whoever holds it.
 */
export async function recoverPool({ github, store }: PoolDeps, force?: string): Promise<RecoverResult> {
  let forced: string | undefined;
  if (force !== undefined) {
    const { state } = await store.read();
    const alias = Object.entries(state.accounts).find(([, a]) => a.sessionId === force)?.[0];
    if (!alias) throw new Error(`no login in the pool has session "${force}"`);
    await quarantine(store, { alias, reason: "quarantined by hand with recover --force" });
    forced = alias;
  }
  const report = await recover(store, github.runEnded);
  return forced ? { ...report, forced } : report;
}
