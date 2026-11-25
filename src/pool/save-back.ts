import { authSecretName, POOL_ENVIRONMENT } from "./command.js";
import type { PoolGitHub } from "./github.js";
import type { PoolHandoff } from "./lease-run.js";
import { credentialHash, quarantine, release, type Owner, type PoolStore } from "./pool.js";
import type { Seal } from "./seal.js";

export interface SaveBackDeps {
  /** `CODEX_POOL_TOKEN`: environment secrets write. */
  github: Pick<PoolGitHub, "environmentKey" | "putEnvironmentSecret">;
  /** `FACTORY_TOKEN`: the lease and hash updates. */
  store: PoolStore;
  seal: Seal;
  owner: Owner;
  /** The sealed handoff, opened; undefined if none arrived or it didn't open. */
  handoff: PoolHandoff | undefined;
  /** The pool's current secrets, by name, as this job's environment holds them: the trusted copy of each login. */
  secrets: Record<string, string | undefined>;
}

export interface SaveOutcome {
  alias: string;
  result: "saved" | "unchanged" | "quarantined";
  /** Why, for a quarantine. Never holds a credential. */
  reason?: string;
}

/** Who a login belongs to: the account ID in `auth.json`, else the ID token's subject. */
export function accountIdentity(authJson: string): string | undefined {
  try {
    const tokens = (JSON.parse(authJson) as { tokens?: { account_id?: unknown; id_token?: unknown } }).tokens;
    if (typeof tokens?.account_id === "string" && tokens.account_id) return `account:${tokens.account_id}`;
    if (typeof tokens?.id_token === "string") {
      const claims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
      if (typeof claims.sub === "string" && claims.sub) return `sub:${claims.sub}`;
    }
  } catch {
    // Not a login we can read: no identity.
  }
  return undefined;
}

const hasRefreshToken = (authJson: string): boolean => {
  try {
    return typeof (JSON.parse(authJson) as { tokens?: { refresh_token?: unknown } }).tokens?.refresh_token === "string";
  } catch {
    return false;
  }
};

/**
 * The saving job. For every login the pool says this run holds: checks the refreshed login is the same account,
 * saves it as the secret (encrypted), records its hash and releases the lease. Anything uncertain quarantines the
 * login instead: a missing or unreadable handoff, a different account, a stale generation, a failed save. The set of
 * logins comes from the pool's own state, never from the handoff, so a run can't leave one out by omission.
 */
export async function saveBack(deps: SaveBackDeps): Promise<SaveOutcome[]> {
  const { state } = await deps.store.read();
  const mine = Object.entries(state.accounts).filter(([, a]) => a.lease && a.lease.runId === deps.owner.runId && a.lease.attempt === deps.owner.attempt);
  const outcomes: SaveOutcome[] = [];
  const handoffOwnerOk = deps.handoff?.owner.runId === deps.owner.runId && deps.handoff?.owner.attempt === deps.owner.attempt;

  for (const [alias, account] of mine) {
    const quarantined = async (reason: string): Promise<SaveOutcome> => {
      await quarantine(deps.store, { alias, reason, owner: deps.owner });
      return { alias, result: "quarantined", reason };
    };
    try {
      const entry = handoffOwnerOk ? deps.handoff!.logins.find((l) => l.alias === alias) : undefined;
      if (!entry) {
        outcomes.push(await quarantined("no refreshed login came back from the run"));
        continue;
      }
      if (entry.status === "auth") {
        outcomes.push(await quarantined("Codex rejected the login (an auth failure)"));
        continue;
      }
      const original = deps.secrets[authSecretName(account.sessionId)];
      if (original === undefined || credentialHash(original) !== account.hash || entry.claimedHash !== account.hash) {
        outcomes.push(await quarantined("the stored login isn't the generation the run was given"));
        continue;
      }
      if (entry.auth === null || credentialHash(entry.auth) === account.hash) {
        // Nothing was refreshed: the stored login stands.
        const done = await release(deps.store, { alias, owner: deps.owner, claimedHash: account.hash, newHash: account.hash });
        outcomes.push(done.saved ? { alias, result: "unchanged" } : await quarantined(`couldn't release the lease (${done.reason})`));
        continue;
      }
      const before = accountIdentity(original);
      if (!hasRefreshToken(entry.auth) || before === undefined || accountIdentity(entry.auth) !== before) {
        outcomes.push(await quarantined("the refreshed login isn't a login for the same account"));
        continue;
      }
      // Re-check the generation just before writing: a stale snapshot never overwrites a newer one.
      const current = (await deps.store.read()).state.accounts[alias];
      if (current?.hash !== account.hash || current.quarantine) {
        outcomes.push(await quarantined("the pool moved on while the run was going"));
        continue;
      }
      const key = await deps.github.environmentKey(POOL_ENVIRONMENT);
      await deps.github.putEnvironmentSecret(POOL_ENVIRONMENT, authSecretName(account.sessionId), {
        keyId: key.keyId,
        value: await deps.seal(entry.auth, key.key),
      });
      const done = await release(deps.store, { alias, owner: deps.owner, claimedHash: account.hash, newHash: credentialHash(entry.auth) });
      outcomes.push(done.saved ? { alias, result: "saved" } : await quarantined(`saved the secret but couldn't record it (${done.reason})`));
    } catch (error) {
      // Whatever went wrong, the secret and the pool may disagree now: take the login out.
      const reason = `saving back failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      try {
        outcomes.push(await quarantined(reason));
      } catch {
        outcomes.push({ alias, result: "quarantined", reason: `${reason} (and quarantining it failed too: run recover)` });
      }
    }
  }
  return outcomes;
}
