import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authSecretName } from "./command.js";
import type { PoolNotice } from "./summary.js";
import { claim, credentialHash, quarantine, type Owner, type PoolStore } from "./pool.js";
import type { Seal } from "./seal.js";

/** Prefix of the secrets that hold logins. */
export const AUTH_PREFIX = "CODEX_AUTH_";
/** The artifact the agent job uploads: the refreshed logins, sealed to the transport public key. */
export const POOL_ARTIFACT = "factory-pool-handoff";
/** The file inside that artifact. */
export const POOL_SEALED_FILE = "logins.sealed";

/** How a login's use in this run ended. `leased` means the run hasn't said (it may have been killed). */
export type LeaseStatus = "leased" | "ok" | "quota" | "auth";

export interface LeaseRecord {
  alias: string;
  sessionId: string;
  /** The generation the run was handed. */
  claimedHash: string;
  status: LeaseStatus;
}

/** What the agent job keeps in its private folder between steps. Never holds a credential. */
export interface LeasesFile {
  owner: Owner;
  leases: LeaseRecord[];
  /** The alias the adapter is running on now. */
  current?: string;
  /** Why no login could be leased, if so. Becomes the item's parking comment. */
  unavailable?: string;
}

/** What the sealed handoff holds once opened: each leased login's text at the end of the run. */
export interface PoolHandoff {
  version: 1;
  owner: Owner;
  logins: Array<LeaseRecord & { auth: string | null }>;
}

export interface LeaseDeps {
  /** The private folder, outside the checkout: `$RUNNER_TEMP/factory-pool`. */
  dir: string;
  owner: Owner;
  store: () => PoolStore;
  /** How long to wait for a busy pool, ms. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
  report?: (notice: PoolNotice) => void;
}

const paths = (dir: string) => ({
  logins: join(dir, "logins.json"),
  leases: join(dir, "leases.json"),
  current: join(dir, "current", "auth.json"),
  held: (alias: string) => join(dir, "held", `${alias}.json`),
});

/** The path the adapter reads and refreshes in place. */
export const leasedAuthPath = (dir: string): string => paths(dir).current;

function privateWrite(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readLeases(dir: string): LeasesFile | undefined {
  const file = paths(dir).leases;
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LeasesFile) : undefined;
}

const writeLeases = (dir: string, leases: LeasesFile): void => privateWrite(paths(dir).leases, JSON.stringify(leases, null, 2));

/** The logins the secrets hold, keyed by secret name, with nothing else from the set. */
export function loginsFrom(secrets: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets).filter((e): e is [string, string] => e[0].startsWith(AUTH_PREFIX) && Boolean(e[1])));
}

const readLogins = (dir: string): Record<string, string> => JSON.parse(readFileSync(paths(dir).logins, "utf8")) as Record<string, string>;

/**
 * Leases a free login whose secret is the generation the pool recorded, and makes it the current one. A login the
 * pool lists but whose secret is missing or isn't that generation is quarantined, not used. If every login is busy,
 * waits up to `waitMs`, then gives up. Returns why it couldn't, or undefined on success.
 */
async function acquire(deps: LeaseDeps, budgetMs: number): Promise<string | undefined> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const store = deps.store();
  const logins = readLogins(deps.dir);
  const give = Math.min(deps.waitMs ?? 120_000, budgetMs);
  const until = now() + give;
  for (;;) {
    const got = await claim(store, { owner: deps.owner, random: deps.random });
    if (got) {
      const secret = logins[authSecretName(got.sessionId)];
      if (secret === undefined || credentialHash(secret) !== got.hash) {
        const why = secret === undefined ? "its secret isn't in the codex-pool environment" : "its secret isn't the generation the pool recorded";
        deps.log?.(`::warning::login "${got.alias}" quarantined: ${why}`);
        if (await quarantine(store, { alias: got.alias, reason: `leased by run ${deps.owner.runId}, but ${why}`, owner: deps.owner })) {
          deps.report?.({ kind: "quarantined", alias: got.alias });
        }
        continue;
      }
      const file = readLeases(deps.dir) ?? { owner: deps.owner, leases: [] };
      privateWrite(paths(deps.dir).current, secret);
      file.leases.push({ alias: got.alias, sessionId: got.sessionId, claimedHash: got.hash, status: "leased" });
      file.current = got.alias;
      delete file.unavailable;
      writeLeases(deps.dir, file);
      return undefined;
    }
    const { state } = await store.read();
    const accounts = Object.values(state.accounts);
    if (accounts.length === 0) return "the Codex login pool is empty";
    // A login this run set aside stays leased to it and never frees, so only another run's lease is worth waiting for.
    const heldByOthers = accounts.some((a) => a.lease && !(a.lease.runId === deps.owner.runId && a.lease.attempt === deps.owner.attempt));
    if (!heldByOthers) return "every Codex login in the pool is quarantined or already tried by this run; run `node dist/pool.js check` and recover them";
    if (now() >= until) return `every Codex login is in use by another run${give > 0 ? ` (waited ${Math.round(give / 1000)} s)` : ""}; add another login to the pool or try again later`;
    await sleep(Math.min(deps.pollMs ?? 15_000, Math.max(0, until - now())));
  }
}

/**
 * The capture step: keeps the pool's logins (and only those) in a private 0600 file outside the checkout, leases one
 * and writes it where the adapter reads it. Leases nothing if the client set `OPENAI_API_KEY` or
 * `CODEX_ACCESS_TOKEN`, which win (§6). Records why, if no login could be leased.
 */
export async function capture(deps: LeaseDeps, secrets: Record<string, string | undefined>, hasOwnCredential: boolean): Promise<LeasesFile> {
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  chmodSync(deps.dir, 0o700);
  const file: LeasesFile = { owner: deps.owner, leases: [] };
  writeLeases(deps.dir, file);
  if (hasOwnCredential) return file;
  privateWrite(paths(deps.dir).logins, JSON.stringify(loginsFrom(secrets)));
  const why = await acquire(deps, Number.POSITIVE_INFINITY);
  const after = readLeases(deps.dir)!;
  if (why) {
    deps.report?.({ kind: "exhausted" });
    after.unavailable = why;
    writeLeases(deps.dir, after);
  }
  return after;
}

/** What the agent job's turns see of the pool. */
export interface PoolRun {
  /** The leased login's path, for the adapter. */
  authFile(): string | undefined;
  /** Why no login was leased. */
  unavailable(): string | undefined;
  /** Records how the attempt on the current login ended. */
  settle(failure: "auth" | "quota" | undefined): void;
  /** After a quota failure: sets the login aside and leases another (each login at most once per run). False if none. */
  next(budgetMs: number): Promise<boolean>;
}

/** Undefined if this run leased nothing, so the job isn't in the pool mode. */
export function poolRun(deps: LeaseDeps): PoolRun | undefined {
  const start = readLeases(deps.dir);
  if (!start) return undefined;
  return {
    authFile: () => (readLeases(deps.dir)?.current ? paths(deps.dir).current : undefined),
    unavailable: () => readLeases(deps.dir)?.unavailable,
    settle(failure) {
      const file = readLeases(deps.dir)!;
      const lease = file.leases.find((l) => l.alias === file.current);
      if (lease) lease.status = failure ?? "ok";
      writeLeases(deps.dir, file);
    },
    async next(budgetMs) {
      shelve(deps.dir);
      // The set-aside login stays leased to this run until the saving job releases it, so claim can't hand it out again.
      const why = await acquire(deps, budgetMs);
      if (why) {
        deps.report?.({ kind: "exhausted" });
        const file = readLeases(deps.dir)!;
        file.unavailable = why;
        writeLeases(deps.dir, file);
      }
      return why === undefined;
    },
  };
}

/** Moves the current login's file (as the adapter refreshed it) aside, so the next login can take its place. */
function shelve(dir: string): void {
  const file = readLeases(dir);
  const p = paths(dir);
  if (!file?.current || !existsSync(p.current)) return;
  privateWrite(p.held(file.current), readFileSync(p.current, "utf8"));
  rmSync(p.current, { force: true });
  delete file.current;
  writeLeases(dir, file);
}

/** Removes every copy of every login this run held. Safe to run twice. */
export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The handoff step: seals each leased login's final text to the transport public key into `outDir`, then removes
 * every copy, even if sealing fails. An unsealed login is never written outside the private folder.
 */
export async function sealHandoff(deps: LeaseDeps, publicKey: string | undefined, outDir: string, seal: Seal): Promise<void> {
  try {
    const file = readLeases(deps.dir);
    if (!file || file.leases.length === 0) return;
    if (!publicKey) throw new Error("CODEX_POOL_TRANSPORT_PUBLIC_KEY isn't set: run `node dist/pool.js init`");
    shelve(deps.dir);
    const after = readLeases(deps.dir)!;
    const p = paths(deps.dir);
    const handoff: PoolHandoff = {
      version: 1,
      owner: file.owner,
      logins: after.leases.map((l) => ({ ...l, auth: existsSync(p.held(l.alias)) ? readFileSync(p.held(l.alias), "utf8") : null })),
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, POOL_SEALED_FILE), await seal(JSON.stringify(handoff), publicKey));
  } finally {
    cleanup(deps.dir);
  }
}
