import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authSecretName } from "../src/pool/command.js";
import { capture, cleanup, type LeaseDeps, leasedAuthPath, loginsFrom, type PoolHandoff, POOL_SEALED_FILE, poolRun, readLeases, sealHandoff } from "../src/pool/lease-run.js";
import { credentialHash, type PoolState } from "../src/pool/pool.js";
import { saveBack } from "../src/pool/save-back.js";
import { openBox, sealBox, transportKeyPair } from "../src/pool/seal.js";
import { renderPoolNotice } from "../src/pool/summary.js";
import { MemoryStore } from "./support/memory-store.js";
import { tree } from "./support/tree.js";

const auth = (account: string, refresh: string) => JSON.stringify({ tokens: { account_id: account, refresh_token: refresh, access_token: `at-${refresh}` } });
const OWNER = { runId: "100", attempt: 1 };

function pool(...logins: Array<{ alias: string; session: string; text: string }>) {
  const state: PoolState = { version: 1, accounts: {} };
  const secrets: Record<string, string> = {};
  for (const l of logins) {
    state.accounts[l.alias] = { sessionId: l.session, hash: credentialHash(l.text) };
    secrets[authSecretName(l.session)] = l.text;
  }
  return { store: new MemoryStore(state), secrets };
}

const A = { alias: "a", session: "s1", text: auth("acct-1", "r1") };
const B = { alias: "b", session: "s2", text: auth("acct-2", "r2") };

function deps(store: MemoryStore, extra: Partial<LeaseDeps> = {}): LeaseDeps {
  return { dir: join(tree({}), "pool"), owner: OWNER, store: () => store, sleep: async () => {}, random: () => 0, ...extra };
}

describe("capture", () => {
  it("keeps only the CODEX_AUTH_* secrets, in 0600 files, and leases one login for the adapter", async () => {
    const { store, secrets } = pool(A);
    const d = deps(store);
    const file = await capture(d, { ...secrets, FACTORY_TOKEN: "t", OPENAI_API_KEY: "" }, false);
    expect(file.current).toBe("a");
    expect(JSON.parse(readFileSync(join(d.dir, "logins.json"), "utf8"))).toEqual(secrets);
    expect(statSync(join(d.dir, "logins.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(leasedAuthPath(d.dir), "utf8")).toBe(A.text);
    expect(statSync(leasedAuthPath(d.dir)).mode & 0o777).toBe(0o600);
    expect(store.state.accounts.a!.lease).toEqual(OWNER);
  });

  it("filters out everything but logins", () => {
    expect(loginsFrom({ CODEX_AUTH_X: "1", FACTORY_TOKEN: "t", CODEX_AUTH_Y: "" })).toEqual({ CODEX_AUTH_X: "1" });
  });

  it("leases nothing when the client set an API key or access token", async () => {
    const { store, secrets } = pool(A);
    const d = deps(store);
    const file = await capture(d, secrets, true);
    expect(file.leases).toEqual([]);
    expect(store.state.accounts.a!.lease).toBeUndefined();
    expect(existsSync(join(d.dir, "logins.json"))).toBe(false);
  });

  it("quarantines a login whose secret isn't the recorded generation, and leases the next one", async () => {
    const { store, secrets } = pool(A, B);
    secrets[authSecretName("s1")] = auth("acct-1", "older");
    const summary: string[] = [];
    const d = deps(store, { report: (notice) => summary.push(renderPoolNotice(notice)) });
    const file = await capture(d, secrets, false);
    expect(file.current).toBe("b");
    expect(summary).toEqual(["- Codex pool: login `a` was quarantined.\n"]);
    expect(store.state.accounts.a!.quarantine?.reason).toMatch(/generation/);
  });

  it("waits briefly when every login is busy, then says so", async () => {
    const { store, secrets } = pool(A);
    store.state.accounts.a!.lease = { runId: "other", attempt: 1 };
    let t = 0;
    const slept: number[] = [];
    const summary: string[] = [];
    const d = deps(store, { report: (notice) => summary.push(renderPoolNotice(notice)), waitMs: 60_000, pollMs: 20_000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    const file = await capture(d, secrets, false);
    expect(slept).toEqual([20_000, 20_000, 20_000]);
    expect(file.current).toBeUndefined();
    expect(file.unavailable).toMatch(/in use by another run/);
    expect(summary).toEqual(["- Codex pool exhausted. Check the pool for leased or quarantined logins.\n"]);
  });

  it("takes a login another run frees while it waits", async () => {
    const { store, secrets } = pool(A);
    store.state.accounts.a!.lease = { runId: "other", attempt: 1 };
    const d = deps(store, { waitMs: 60_000, sleep: async () => void delete store.state.accounts.a!.lease });
    expect((await capture(d, secrets, false)).current).toBe("a");
  });

  it("doesn't wait when nothing is leased, only quarantined", async () => {
    const { store, secrets } = pool(A);
    store.state.accounts.a!.quarantine = { reason: "x" };
    const file = await capture(deps(store), secrets, false);
    expect(file.unavailable).toMatch(/quarantined/);
  });
});

describe("failover", () => {
  it("sets a quota-limited login aside and leases another, each at most once", async () => {
    const { store, secrets } = pool(A, B);
    const d = deps(store, { waitMs: 0 });
    await capture(d, secrets, false);
    const run = poolRun(d)!;
    const first = readLeases(d.dir)!.current!;
    run.settle("quota");
    expect(await run.next(60_000)).toBe(true);
    const second = readLeases(d.dir)!.current!;
    expect(second).not.toBe(first);
    run.settle("quota");
    // Both are leased to this run now: a third try finds nothing, and the first isn't handed out again.
    expect(await run.next(60_000)).toBe(false);
    expect(run.authFile()).toBeUndefined();
    expect(readLeases(d.dir)!.leases.map((l) => [l.alias, l.status])).toEqual([[first, "quota"], [second, "quota"]]);
  });

  it("doesn't wait for logins this run set aside itself", async () => {
    const { store, secrets } = pool(A);
    let slept = 0;
    const d = deps(store, { sleep: async () => { slept++; } });
    await capture(d, secrets, false);
    const run = poolRun(d)!;
    run.settle("quota");
    expect(await run.next(600_000)).toBe(false);
    expect(slept).toBe(0);
    expect(run.unavailable()).toMatch(/already tried by this run/);
  });
});

describe("handoff and save back", () => {
  async function run(...logins: typeof A[]) {
    const { store, secrets } = pool(...logins);
    const d = deps(store);
    await capture(d, secrets, false);
    const keys = await transportKeyPair();
    return { store, secrets, d, keys, out: join(tree({}), "out") };
  }

  it("seals the refreshed login, and removes every copy", async () => {
    const { d, keys, out } = await run(A);
    const refreshed = auth("acct-1", "r1-new");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(leasedAuthPath(d.dir), refreshed);
    await sealHandoff(d, keys.publicKey, out, sealBox);
    expect(existsSync(d.dir)).toBe(false);
    const sealed = readFileSync(join(out, POOL_SEALED_FILE), "utf8");
    expect(sealed).not.toContain("r1-new");
    const opened = JSON.parse(await openBox(sealed, keys.privateKey)) as PoolHandoff;
    expect(opened.logins[0]).toMatchObject({ alias: "a", auth: refreshed });
  });

  it("removes every copy even when sealing fails, and writes nothing unencrypted", async () => {
    const { d, out } = await run(A);
    await expect(sealHandoff(d, undefined, out, sealBox)).rejects.toThrow(/PUBLIC_KEY/);
    expect(existsSync(d.dir)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("saves the refreshed login encrypted, records its hash and releases the lease", async () => {
    const { store, secrets, d, keys, out } = await run(A);
    const refreshed = auth("acct-1", "r1-new");
    (await import("node:fs")).writeFileSync(leasedAuthPath(d.dir), refreshed);
    await sealHandoff(d, keys.publicKey, out, sealBox);
    const handoff = JSON.parse(await openBox(readFileSync(join(out, POOL_SEALED_FILE), "utf8"), keys.privateKey)) as PoolHandoff;
    const put: Array<[string, string]> = [];
    const outcomes = await saveBack({
      github: { environmentKey: async () => ({ keyId: "k", key: "pub" }), putEnvironmentSecret: async (_e, name, enc) => void put.push([name, enc.value]) },
      store,
      seal: async (text) => `sealed:${text}`,
      owner: OWNER,
      handoff,
      secrets,
    });
    expect(outcomes).toEqual([{ alias: "a", result: "saved" }]);
    expect(put).toEqual([["CODEX_AUTH_S1", `sealed:${refreshed}`]]);
    expect(store.state.accounts.a).toEqual({ sessionId: "s1", hash: credentialHash(refreshed) });
  });

  const base = (store: MemoryStore, secrets: Record<string, string>, handoff: PoolHandoff | undefined, over = {}) => ({
    github: { environmentKey: async () => ({ keyId: "k", key: "pub" }), putEnvironmentSecret: async () => {} },
    store,
    seal: async (t: string) => t,
    owner: OWNER,
    handoff,
    secrets,
    ...over,
  });
  const handoffOf = (text: string | null, status: "ok" | "quota" | "auth" = "ok", hash = credentialHash(A.text)): PoolHandoff => ({
    version: 1,
    owner: OWNER,
    logins: [{ alias: "a", sessionId: "s1", claimedHash: hash, status, auth: text }],
  });

  it("quarantines every login the run holds when no handoff arrived", async () => {
    const { store, secrets } = pool(A, B);
    store.state.accounts.a!.lease = OWNER;
    store.state.accounts.b!.lease = OWNER;
    const outcomes = await saveBack(base(store, secrets, undefined));
    expect(outcomes.map((o) => o.result)).toEqual(["quarantined", "quarantined"]);
    expect(store.state.accounts.a!.quarantine).toBeDefined();
    expect(store.state.accounts.a!.lease).toBeUndefined();
  });

  it("leaves a login another run holds alone", async () => {
    const { store, secrets } = pool(A);
    store.state.accounts.a!.lease = { runId: "other", attempt: 1 };
    expect(await saveBack(base(store, secrets, undefined))).toEqual([]);
    expect(store.state.accounts.a!.quarantine).toBeUndefined();
  });

  it("quarantines a refreshed login for a different account", async () => {
    const { store, secrets } = pool(A);
    store.state.accounts.a!.lease = OWNER;
    const [o] = await saveBack(base(store, secrets, handoffOf(auth("someone-else", "x"))));
    expect(o).toMatchObject({ result: "quarantined", reason: expect.stringMatching(/same account/) });
  });

  it("quarantines when the run's generation isn't the pool's, so a stale snapshot never overwrites", async () => {
    const { store, secrets } = pool(A);
    store.state.accounts.a!.lease = OWNER;
    const [o] = await saveBack(base(store, secrets, handoffOf(auth("acct-1", "x"), "ok", "stale-hash")));
    expect(o!.result).toBe("quarantined");
  });

  it("quarantines when saving the secret fails, and when the auth failed", async () => {
    const { store, secrets } = pool(A);
    store.state.accounts.a!.lease = OWNER;
    const failing = { environmentKey: async () => ({ keyId: "k", key: "pub" }), putEnvironmentSecret: async () => { throw new Error("403"); } };
    const [o] = await saveBack(base(store, secrets, handoffOf(auth("acct-1", "x")), { github: failing }));
    expect(o).toMatchObject({ result: "quarantined", reason: expect.stringMatching(/403/) });

    const again = pool(A);
    again.store.state.accounts.a!.lease = OWNER;
    const [p] = await saveBack(base(again.store, again.secrets, handoffOf(null, "auth")));
    expect(p).toMatchObject({ result: "quarantined", reason: expect.stringMatching(/auth/) });
  });

  it("releases an unchanged login without touching the secret", async () => {
    const { store, secrets } = pool(A);
    store.state.accounts.a!.lease = OWNER;
    const [o] = await saveBack(base(store, secrets, handoffOf(A.text, "quota")));
    expect(o).toEqual({ alias: "a", result: "unchanged" });
    expect(store.state.accounts.a!.lease).toBeUndefined();
  });

  it("cleanup is safe to run twice", async () => {
    const { d } = await run(A);
    cleanup(d.dir);
    cleanup(d.dir);
    expect(existsSync(d.dir)).toBe(false);
  });
});
