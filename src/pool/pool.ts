import { createHash } from "node:crypto";

/** The branch in the client repo that holds the pool's state (§6). */
export const STATE_BRANCH = "factory-auth-state";
/** The one file on that branch. */
export const STATE_FILE = "pool.json";

/** Who holds a login: the workflow run and its attempt. */
export interface Owner {
  runId: string;
  attempt: number;
}

export interface Account {
  /** The session the login belongs to. */
  sessionId: string;
  /** SHA-256 of the current credential: the generation. Never the credential itself. */
  hash: string;
  /** Relative chance of being picked by `claim`. Default 1. */
  weight?: number;
  lease?: Owner;
  quarantine?: { reason: string };
}

/** What `pool.json` holds. It never holds a credential. */
export interface PoolState {
  version: 1;
  accounts: Record<string, Account>;
}

export function emptyState(): PoolState {
  return { version: 1, accounts: {} };
}

/** The hash recorded for a credential (the text of its `auth.json`). */
export function credentialHash(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

/** A state as read, with an opaque token naming the version that was read. */
export interface Snapshot {
  state: PoolState;
  token: string | undefined;
}

/**
 * Where the state lives. `write` succeeds only if the state is still the one `expected` names (the commit's
 * only parent); it returns false on a conflict and throws on any other failure.
 */
export interface PoolStore {
  read(): Promise<Snapshot>;
  write(state: PoolState, expected: string | undefined): Promise<boolean>;
}

export interface UpdateOptions {
  /** Attempts before giving up on conflicts. Default 10. */
  attempts?: number;
}

/**
 * Applies `change` to the current state and writes it, rereading and retrying if another writer got in first.
 * `change` returns the new state and a result, or just a result to write nothing. It may run several times.
 */
export async function update<T>(
  store: PoolStore,
  change: (state: PoolState) => { state?: PoolState; result: T },
  options: UpdateOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 10;
  for (let i = 0; i < attempts; i++) {
    const { state, token } = await store.read();
    const { state: next, result } = change(structuredClone(state));
    if (!next) return result;
    if (await store.write(next, token)) return result;
  }
  throw new Error(`pool state kept changing under us: gave up after ${attempts} attempts`);
}

const sameOwner = (a: Owner | undefined, b: Owner): boolean => a !== undefined && a.runId === b.runId && a.attempt === b.attempt;

export interface Claim {
  alias: string;
  sessionId: string;
  /** The generation the claimer was handed; pass it back to `release`. */
  hash: string;
}

export interface ClaimOptions {
  owner: Owner;
  /** In [0, 1). Injectable for tests. */
  random?: () => number;
}

/**
 * Takes one free login, chosen at random by weight, skipping leased and quarantined ones. Atomic: the write only
 * lands if nobody changed the state since it was read. Undefined if no login is free.
 */
export function claim(store: PoolStore, options: ClaimOptions): Promise<Claim | undefined> {
  const random = options.random ?? Math.random;
  return update(store, (state) => {
    const free = Object.entries(state.accounts).filter(([, a]) => !a.lease && !a.quarantine);
    const weights = free.map(([, a]) => Math.max(0, a.weight ?? 1));
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (free.length === 0) return { result: undefined };
    let point = random() * (total > 0 ? total : free.length);
    let index = free.length - 1;
    for (let i = 0; i < free.length; i++) {
      point -= total > 0 ? weights[i]! : 1;
      if (point < 0) {
        index = i;
        break;
      }
    }
    const [alias, account] = free[index]!;
    account.lease = { ...options.owner };
    return { state, result: { alias, sessionId: account.sessionId, hash: account.hash } };
  });
}

export type ReleaseResult =
  | { saved: true }
  | { saved: false; reason: "unknown-account" | "not-owner" | "stale" };

export interface ReleaseOptions {
  alias: string;
  owner: Owner;
  /** The generation handed out by `claim`. */
  claimedHash: string;
  /** The hash of the refreshed credential. */
  newHash: string;
}

/**
 * Ends the owner's lease and records the refreshed credential's hash. A snapshot whose generation isn't current
 * is never saved back (`stale`), and a lease that isn't the caller's isn't touched (`not-owner`).
 */
export function release(store: PoolStore, options: ReleaseOptions): Promise<ReleaseResult> {
  return update<ReleaseResult>(store, (state) => {
    const account = state.accounts[options.alias];
    if (!account) return { result: { saved: false, reason: "unknown-account" } };
    if (!sameOwner(account.lease, options.owner) || account.quarantine) return { result: { saved: false, reason: "not-owner" } };
    if (account.hash !== options.claimedHash) return { result: { saved: false, reason: "stale" } };
    account.hash = options.newHash;
    delete account.lease;
    return { state, result: { saved: true } };
  });
}

/** True if `hash` is the login's current generation. A credential that isn't must not be used. */
export async function isCurrent(store: PoolStore, alias: string, hash: string): Promise<boolean> {
  const { state } = await store.read();
  return state.accounts[alias]?.hash === hash;
}

export interface QuarantineOptions {
  alias: string;
  reason: string;
  /** If given, only quarantines when this owner still holds the lease (or nobody does). */
  owner?: Owner;
}

/** Takes a login out of the pool, with a reason, and drops its lease. A person recovers it. */
export function quarantine(store: PoolStore, options: QuarantineOptions): Promise<boolean> {
  return update(store, (state) => {
    const account = state.accounts[options.alias];
    if (!account) return { result: false };
    if (options.owner && account.lease && !sameOwner(account.lease, options.owner)) return { result: false };
    account.quarantine = { reason: options.reason };
    delete account.lease;
    return { state, result: true };
  });
}

/** Whether a run has ended. Throws if GitHub can't say. */
export type RunEnded = (owner: Owner) => Promise<boolean>;

export interface RecoverReport {
  /** Logins quarantined because their owner's run ended. */
  quarantined: string[];
  /** Logins whose owner lookup failed: still reserved, never treated as free. */
  lookupFailed: Array<{ alias: string; owner: Owner; error: string }>;
}

/**
 * Quarantines logins whose owner run has ended without releasing. There's no expiry by time: a lease ends only
 * when its owner is seen to have ended. A failed lookup keeps the reservation and is reported.
 */
export async function recover(store: PoolStore, runEnded: RunEnded, options: UpdateOptions = {}): Promise<RecoverReport> {
  const report: RecoverReport = { quarantined: [], lookupFailed: [] };
  const { state } = await store.read();
  const ended: Array<{ alias: string; owner: Owner }> = [];
  for (const [alias, account] of Object.entries(state.accounts)) {
    const owner = account.lease;
    if (!owner) continue;
    try {
      if (await runEnded(owner)) ended.push({ alias, owner });
    } catch (error) {
      report.lookupFailed.push({ alias, owner, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (ended.length === 0) return report;
  report.quarantined = await update(
    store,
    (current) => {
      // Only what was looked up: a lease that changed hands since is a different run and gets its own lookup.
      const done = ended.filter(({ alias, owner }) => sameOwner(current.accounts[alias]?.lease, owner));
      for (const { alias, owner } of done) {
        const account = current.accounts[alias]!;
        account.quarantine = { reason: `owner run ${owner.runId} attempt ${owner.attempt} ended without releasing the login` };
        delete account.lease;
      }
      return { state: done.length > 0 ? current : undefined, result: done.map((d) => d.alias) };
    },
    options,
  );
  return report;
}
