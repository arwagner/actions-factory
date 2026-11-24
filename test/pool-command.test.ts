import { describe, expect, it } from "vitest";
import { authSecretName, check, init, recoverPool, seed, type PoolDeps } from "../src/pool/command.js";
import { main } from "../src/pool/cli.js";
import type { PoolGitHub } from "../src/pool/github.js";
import { emptyState, type PoolState, type PoolStore, type Snapshot } from "../src/pool/pool.js";

class MemoryStore implements PoolStore {
  version: number | undefined;
  constructor(public state: PoolState = emptyState(), exists = true) {
    this.version = exists ? 0 : undefined;
  }
  async read(): Promise<Snapshot> {
    return { state: structuredClone(this.state), token: this.version === undefined ? undefined : String(this.version) };
  }
  async write(state: PoolState, expected: string | undefined) {
    if (expected !== (this.version === undefined ? undefined : String(this.version))) return false;
    this.state = structuredClone(state);
    this.version = (this.version ?? -1) + 1;
    return true;
  }
}

function fakeGitHub(over: Partial<PoolGitHub> = {}) {
  const secrets = new Map<string, string>();
  const variables = new Map<string, string>();
  const github: PoolGitHub = {
    repoExists: async () => true,
    environment: async () => ({ selectedBranches: true }),
    environmentKey: async () => ({ keyId: "k1", key: "pub" }),
    putEnvironmentSecret: async (_env, name, enc) => void secrets.set(name, enc.value),
    listEnvironmentSecrets: async () => [...secrets.keys()],
    getVariable: async (name) => variables.get(name),
    setVariable: async (name, value) => void variables.set(name, value),
    runEnded: async () => false,
    ...over,
  };
  return { github, secrets, variables };
}

const seal = async (plaintext: string) => `sealed:${plaintext}`;
const login = (refresh: string) => JSON.stringify({ tokens: { refresh_token: refresh, access_token: "a" } });
const deps = (store: PoolStore, github: PoolGitHub): PoolDeps => ({ github, store, seal });

describe("init", () => {
  it("creates the state branch and the transport key pair", async () => {
    const store = new MemoryStore(emptyState(), false);
    const { github, secrets, variables } = fakeGitHub();
    expect(await init(deps(store, github))).toEqual({ stateBranchCreated: true, transportKeyCreated: true });
    expect(store.version).toBe(0);
    expect(secrets.get("CODEX_POOL_TRANSPORT_PRIVATE_KEY")).toMatch(/^sealed:/);
    expect(variables.get("CODEX_POOL_TRANSPORT_PUBLIC_KEY")).toBeTruthy();
  });

  it("keeps an existing key pair and branch", async () => {
    const store = new MemoryStore();
    const { github, variables } = fakeGitHub();
    await init(deps(store, github));
    const publicKey = variables.get("CODEX_POOL_TRANSPORT_PUBLIC_KEY");
    expect(await init(deps(store, github))).toEqual({ stateBranchCreated: false, transportKeyCreated: false });
    expect(variables.get("CODEX_POOL_TRANSPORT_PUBLIC_KEY")).toBe(publicKey);
  });

  it("refuses a missing environment or one without selected-branch rules", async () => {
    const store = new MemoryStore();
    await expect(init(deps(store, fakeGitHub({ environment: async () => undefined }).github))).rejects.toThrow(/create the "codex-pool"/);
    await expect(init(deps(store, fakeGitHub({ environment: async () => ({ selectedBranches: false }) }).github))).rejects.toThrow(/Selected branches/);
    await expect(init(deps(store, fakeGitHub({ repoExists: async () => false }).github))).rejects.toThrow(/repo/);
  });
});

describe("seed", () => {
  it("stores the secret and records the login without the credential", async () => {
    const store = new MemoryStore();
    const { github, secrets } = fakeGitHub();
    const text = login("r1");
    expect(await seed(deps(store, github), "work", "s-1", text)).toEqual({ secret: "CODEX_AUTH_S_1" });
    expect(secrets.get("CODEX_AUTH_S_1")).toBe(`sealed:${text}`);
    expect(store.state.accounts.work!.sessionId).toBe("s-1");
    expect(JSON.stringify(store.state)).not.toContain("r1");
  });

  it("rejects duplicate IDs and a copied refresh token", async () => {
    const store = new MemoryStore();
    const { github, secrets } = fakeGitHub();
    await seed(deps(store, github), "work", "s-1", login("r1"));
    await expect(seed(deps(store, github), "work", "s2", login("r2"))).rejects.toThrow(/already in the pool/);
    await expect(seed(deps(store, github), "other", "S_1", login("r2"))).rejects.toThrow(/collides/);
    await expect(seed(deps(store, github), "other", "s2", login("r1"))).rejects.toThrow(/copy/);
    expect([...secrets.keys()]).toEqual(["CODEX_AUTH_S_1"]);
  });

  it("rejects bad names and files that aren't ChatGPT logins", async () => {
    const d = deps(new MemoryStore(), fakeGitHub().github);
    await expect(seed(d, "a b", "s", login("r"))).rejects.toThrow(/account ID/);
    await expect(seed(d, "a", "../s", login("r"))).rejects.toThrow(/session ID/);
    await expect(seed(d, "a", "s", "nope")).rejects.toThrow(/valid JSON/);
    await expect(seed(d, "a", "s", "{}")).rejects.toThrow(/no ChatGPT login/);
  });

  it("names the secret from the session", () => {
    expect(authSecretName("a-b")).toBe("CODEX_AUTH_A_B");
  });
});

const busy = (): PoolState => ({
  version: 1,
  accounts: {
    a: { sessionId: "sa", hash: "h", lease: { runId: "10", attempt: 2 } },
    b: { sessionId: "sb", hash: "h" },
    c: { sessionId: "sc", hash: "h", quarantine: { reason: "bad" } },
  },
});

describe("check", () => {
  it("shows state and lease owner, and writes nothing", async () => {
    const store = new MemoryStore(busy());
    expect(await check(store)).toEqual([
      { alias: "a", sessionId: "sa", state: "leased", owner: "run 10 attempt 2" },
      { alias: "b", sessionId: "sb", state: "free" },
      { alias: "c", sessionId: "sc", state: "quarantined", reason: "bad" },
    ]);
    expect(store.version).toBe(0);
  });
});

describe("recover", () => {
  it("quarantines a login whose run ended", async () => {
    const store = new MemoryStore(busy());
    const result = await recoverPool(deps(store, fakeGitHub({ runEnded: async () => true }).github));
    expect(result.quarantined).toEqual(["a"]);
    expect(store.state.accounts.a!.quarantine).toBeDefined();
    expect(store.state.accounts.a!.lease).toBeUndefined();
  });

  it("forces a quarantine of a named session, and refuses an unknown one", async () => {
    const store = new MemoryStore(busy());
    const d = deps(store, fakeGitHub().github);
    expect((await recoverPool(d, "sb")).forced).toBe("b");
    expect(store.state.accounts.b!.quarantine!.reason).toMatch(/by hand/);
    await expect(recoverPool(d, "nope")).rejects.toThrow(/no login/);
  });
});

describe("cli", () => {
  it("prints usage without a command and needs a token", async () => {
    const lines: string[] = [];
    expect(await main([], {}, (l) => lines.push(l))).toBe(2);
    await expect(main(["check"], { GITHUB_REPOSITORY: "o/r" }, () => {})).rejects.toThrow(/CODEX_POOL_TOKEN/);
    await expect(main(["check"], { CODEX_POOL_TOKEN: "t" }, () => {})).rejects.toThrow(/--repo/);
    expect(await main(["seed", "x"], { CODEX_POOL_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, (l) => lines.push(l))).toBe(2);
  });
});
