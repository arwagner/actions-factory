import { describe, expect, it } from "vitest";
import {
  claim,
  credentialHash,
  isCurrent,
  quarantine,
  recover,
  release,
  update,
  type Owner,
  type PoolState,
  type PoolStore,
  type Snapshot,
} from "../src/pool/pool.js";
import { gitHubPoolStore } from "../src/pool/store.js";

/** An in-memory store with compare-and-swap writes. `beforeWrite` lets a test slip another writer in. */
class MemoryStore implements PoolStore {
  version = 0;
  conflicts = 0;
  beforeWrite?: () => void;
  constructor(public state: PoolState) {}
  async read(): Promise<Snapshot> {
    return { state: structuredClone(this.state), token: String(this.version) };
  }
  async write(state: PoolState, expected: string | undefined) {
    this.beforeWrite?.();
    this.beforeWrite = undefined;
    if (expected !== String(this.version)) {
      this.conflicts++;
      return false;
    }
    this.state = structuredClone(state);
    this.version++;
    return true;
  }
}

const pool = (...aliases: string[]): MemoryStore =>
  new MemoryStore({ version: 1, accounts: Object.fromEntries(aliases.map((a) => [a, { sessionId: `s-${a}`, hash: `h-${a}` }])) });
const run = (runId: string, attempt = 1): Owner => ({ runId, attempt });

describe("claim", () => {
  it("leases a free login and hands back its generation", async () => {
    const store = pool("a");
    expect(await claim(store, { owner: run("1") })).toEqual({ alias: "a", sessionId: "s-a", hash: "h-a" });
    expect(store.state.accounts.a!.lease).toEqual(run("1"));
  });

  it("skips busy and quarantined logins, and returns undefined when none is free", async () => {
    const store = pool("a", "b", "c");
    store.state.accounts.a!.lease = run("9");
    store.state.accounts.b!.quarantine = { reason: "bad" };
    expect((await claim(store, { owner: run("1") }))?.alias).toBe("c");
    expect(await claim(store, { owner: run("2") })).toBeUndefined();
  });

  it("picks by weight", async () => {
    const store = pool("a", "b");
    store.state.accounts.a!.weight = 1;
    store.state.accounts.b!.weight = 3;
    expect((await claim(store, { owner: run("1"), random: () => 0.1 }))?.alias).toBe("a");
    const other = pool("a", "b");
    other.state.accounts.b!.weight = 3;
    expect((await claim(other, { owner: run("1"), random: () => 0.9 }))?.alias).toBe("b");
  });

  it("gives competing claims one login each, never the same one", async () => {
    const store = pool("a", "b");
    const results = await Promise.all([1, 2, 3].map((n) => claim(store, { owner: run(String(n)), random: () => 0 })));
    const aliases = results.filter(Boolean).map((r) => r!.alias);
    expect(aliases.sort()).toEqual(["a", "b"]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
  });

  it("rereads and retries when a push conflicts, then sees the other claim", async () => {
    const store = pool("a", "b");
    store.beforeWrite = () => {
      store.state.accounts.a!.lease = run("other");
      store.version++;
    };
    const got = await claim(store, { owner: run("1"), random: () => 0 });
    expect(got?.alias).toBe("b");
    expect(store.conflicts).toBe(1);
    expect(store.state.accounts.a!.lease).toEqual(run("other"));
  });

  it("gives up if the state never settles", async () => {
    const store = pool("a");
    store.write = async () => false;
    await expect(update(store, (s) => ({ state: s, result: 1 }), { attempts: 3 })).rejects.toThrow(/3 attempts/);
  });
});

describe("release", () => {
  it("records the new hash and frees the login", async () => {
    const store = pool("a");
    const got = (await claim(store, { owner: run("1") }))!;
    expect(await release(store, { alias: "a", owner: run("1"), claimedHash: got.hash, newHash: credentialHash("new") })).toEqual({ saved: true });
    expect(store.state.accounts.a).toEqual({ sessionId: "s-a", hash: credentialHash("new") });
  });

  it("never saves back a stale snapshot", async () => {
    const store = pool("a");
    const got = (await claim(store, { owner: run("1") }))!;
    store.state.accounts.a!.hash = "someone-refreshed";
    expect(await release(store, { alias: "a", owner: run("1"), claimedHash: got.hash, newHash: "x" })).toEqual({ saved: false, reason: "stale" });
    expect(store.state.accounts.a!.hash).toBe("someone-refreshed");
    expect(await isCurrent(store, "a", got.hash)).toBe(false);
    expect(await isCurrent(store, "a", "someone-refreshed")).toBe(true);
  });

  it("refuses a caller that doesn't hold the lease, or after quarantine", async () => {
    const store = pool("a");
    await claim(store, { owner: run("1") });
    expect(await release(store, { alias: "a", owner: run("1", 2), claimedHash: "h-a", newHash: "x" })).toEqual({ saved: false, reason: "not-owner" });
    await quarantine(store, { alias: "a", reason: "rate limited" });
    expect(await release(store, { alias: "a", owner: run("1"), claimedHash: "h-a", newHash: "x" })).toEqual({ saved: false, reason: "not-owner" });
    expect(await release(store, { alias: "zzz", owner: run("1"), claimedHash: "h", newHash: "x" })).toEqual({ saved: false, reason: "unknown-account" });
  });
});

describe("quarantine", () => {
  it("records the reason, drops the lease and keeps the login out of claims", async () => {
    const store = pool("a");
    await claim(store, { owner: run("1") });
    expect(await quarantine(store, { alias: "a", reason: "login failed", owner: run("1") })).toBe(true);
    expect(store.state.accounts.a).toEqual({ sessionId: "s-a", hash: "h-a", quarantine: { reason: "login failed" } });
    expect(await claim(store, { owner: run("2") })).toBeUndefined();
  });

  it("leaves another run's lease alone", async () => {
    const store = pool("a");
    await claim(store, { owner: run("1") });
    expect(await quarantine(store, { alias: "a", reason: "x", owner: run("2") })).toBe(false);
    expect(store.state.accounts.a!.quarantine).toBeUndefined();
  });
});

describe("recover", () => {
  it("quarantines logins whose owner has ended and keeps live ones", async () => {
    const store = pool("a", "b", "c");
    store.state.accounts.a!.lease = run("1");
    store.state.accounts.b!.lease = run("2");
    const report = await recover(store, async (o) => o.runId === "1");
    expect(report).toEqual({ quarantined: ["a"], lookupFailed: [] });
    expect(store.state.accounts.a!.lease).toBeUndefined();
    expect(store.state.accounts.a!.quarantine?.reason).toMatch(/run 1/);
    expect(store.state.accounts.b!.lease).toEqual(run("2"));
  });

  it("keeps the reservation and reports when a lookup fails", async () => {
    const store = pool("a", "b");
    store.state.accounts.a!.lease = run("1");
    store.state.accounts.b!.lease = run("2");
    const report = await recover(store, async (o) => {
      if (o.runId === "1") throw new Error("503");
      return true;
    });
    expect(report.quarantined).toEqual(["b"]);
    expect(report.lookupFailed).toEqual([{ alias: "a", owner: run("1"), error: "503" }]);
    expect(store.state.accounts.a!.lease).toEqual(run("1"));
    expect(store.state.accounts.a!.quarantine).toBeUndefined();
    expect(await claim(store, { owner: run("3") })).toBeUndefined();
  });

  it("doesn't quarantine a lease that changed hands after the lookup", async () => {
    const store = pool("a");
    store.state.accounts.a!.lease = run("1");
    const report = await recover(store, async () => {
      store.state.accounts.a!.lease = run("2");
      return true;
    });
    expect(report.quarantined).toEqual([]);
    expect(store.state.accounts.a!.lease).toEqual(run("2"));
  });

  it("writes nothing when no lease has ended", async () => {
    const store = pool("a");
    store.state.accounts.a!.lease = run("1");
    await recover(store, async () => false);
    expect(store.version).toBe(0);
  });
});

describe("gitHubPoolStore", () => {
  it("commits with the read commit as only parent, without force, and treats 422 as a conflict", async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init.method!, url, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (url.endsWith("/git/ref/heads/factory-auth-state")) return json({ object: { sha: "c0" } });
      if (url.includes("/contents/pool.json")) {
        return json({ content: Buffer.from(JSON.stringify({ version: 1, accounts: {} })).toString("base64") });
      }
      if (url.endsWith("/git/blobs")) return json({ sha: "b1" }, 201);
      if (url.endsWith("/git/trees")) return json({ sha: "t1" }, 201);
      if (url.endsWith("/git/commits")) return json({ sha: "c1" }, 201);
      return json({ message: "not a fast-forward" }, 422);
    }) as typeof fetch;
    try {
      const store = gitHubPoolStore("tok", "o", "r");
      const snap = await store.read();
      expect(snap.token).toBe("c0");
      expect(await store.write(snap.state, snap.token)).toBe(false);
      expect(calls.find((c) => c.url.endsWith("/git/commits"))!.body.parents).toEqual(["c0"]);
      const patch = calls.find((c) => c.method === "PATCH")!;
      expect(patch.body).toEqual({ sha: "c1", force: false });
    } finally {
      globalThis.fetch = original;
    }
  });
});
