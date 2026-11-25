import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, AdapterInput, AdapterOutput } from "../src/agents/types.js";
import { capture, type PoolHandoff, POOL_SEALED_FILE, type PoolRun, poolRun, sealHandoff } from "../src/pool/lease-run.js";
import { credentialHash } from "../src/pool/pool.js";
import { saveBack } from "../src/pool/save-back.js";
import { openBox, sealBox, transportKeyPair } from "../src/pool/seal.js";
import { type AgentJobIO, prepare, runTurn } from "../src/runner/agent-job.js";
import { MemoryStore } from "./support/memory-store.js";
import { FakeGitHub } from "./support/fake-github.js";
import { tree } from "./support/tree.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

/** An adapter that returns the next scripted result and notes which login file it was given. */
function scripted(results: AdapterOutput[], seen: Array<string | undefined>): Adapter {
  return {
    name: "codex",
    credentials: [],
    ping: async () => ({ ok: true, detail: "" }),
    async run(input: AdapterInput) {
      seen.push(input.authFile);
      return results.shift()!;
    },
  };
}

function job(adapter: Adapter, pool: PoolRun | undefined): AgentJobIO {
  const gh = new FakeGitHub();
  gh.issues[42] = { title: "Add a widget", body: "Please." };
  const checkout = tree({ "README.md": "hi\n" });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "init");
  return {
    workDir: join(tree({}), "factory"),
    checkout,
    task: {
      name: "implement",
      agent: "codex",
      prompt: join(tree({ "p.md": "Do it." }), "p.md"),
      skills: {},
      permission: "edit-workspace",
      timeout: 60,
      turns: 1,
      checksGate: true,
      checks: [],
      outcomes: { done: {} },
    },
    subject: { kind: "issue", number: 42 },
    api: () => gh.api("t"),
    adapters: { codex: adapter },
    uploadTranscript: false,
    runCommand: async () => ({ code: 0, output: "" }),
    runHook: async () => {},
    log: () => {},
    env: {},
    pool,
  };
}

/** A pool of logins "a" then "b", leased in that order; `next` fails once they're gone. */
function fakePool(order: string[], unavailable?: string) {
  const events: string[] = [];
  let at = 0;
  const pool: PoolRun = {
    authFile: () => (at < order.length ? `/pool/${order[at]}.json` : undefined),
    unavailable: () => (at >= order.length ? unavailable : undefined),
    settle: (failure) => void events.push(`${order[at]}:${failure ?? "ok"}`),
    next: async () => {
      at++;
      return at < order.length;
    },
  };
  return { pool, events };
}

const state = (io: AgentJobIO) => JSON.parse(readFileSync(join(io.workDir, "state.json"), "utf8"));

describe("a turn in the pool mode", () => {
  it("reuses a synthetic credential on the next task after an encrypted round trip", async () => {
    const login = (refresh: string) => JSON.stringify({ tokens: { account_id: "fixture-account", refresh_token: refresh } });
    const original = login("old-fixture-token");
    const refreshed = login("new-fixture-token");
    const store = new MemoryStore({ version: 1, accounts: { fixture: { sessionId: "slot-01", hash: credentialHash(original) } } });
    const deps = {
      dir: join(tree({}), "pool"),
      owner: { runId: "100", attempt: 1 },
      store: () => store,
    };
    const secrets = { CODEX_AUTH_SLOT_01: original };
    const pair = await transportKeyPair();
    await capture(deps, secrets, false);
    const seen: string[] = [];
    const adapter = scripted([], []);
    adapter.run = async ({ authFile }) => {
      seen.push(readFileSync(authFile!, "utf8"));
      writeFileSync(authFile!, refreshed);
      return { status: "ok" };
    };
    const io = job(adapter, poolRun(deps));
    await prepare(io);
    await runTurn(io, 1);

    const out = tree({});
    await sealHandoff(deps, pair.publicKey, out, sealBox);
    const sealed = readFileSync(join(out, POOL_SEALED_FILE), "utf8");
    expect(sealed).not.toContain("new-fixture-token");
    const handoff = JSON.parse(await openBox(sealed, pair.privateKey)) as PoolHandoff;
    expect(await saveBack({
      github: {
        environmentKey: async () => ({ keyId: "fixture-key", key: pair.publicKey }),
        putEnvironmentSecret: async (_environment, _name, encrypted) => {
          secrets.CODEX_AUTH_SLOT_01 = await openBox(encrypted.value, pair.privateKey);
        },
      },
      store, seal: sealBox, owner: deps.owner, handoff, secrets,
    })).toMatchObject([{ alias: "fixture", result: "saved" }]);

    const next = { ...deps, owner: { runId: "101", attempt: 1 } };
    await capture(next, secrets, false);
    const nextJob = job(adapter, poolRun(next));
    await prepare(nextJob);
    await runTurn(nextJob, 1);
    expect(seen).toEqual([original, refreshed]);
  });

  it("moves to another login on a quota failure, and goes on from there", async () => {
    const seen: Array<string | undefined> = [];
    const { pool, events } = fakePool(["a", "b"]);
    const io = job(scripted([{ status: "failed", failure: "quota", usage: { inputTokens: 5 } }, { status: "ok", usage: { inputTokens: 7 } }], seen), pool);
    await prepare(io);
    await runTurn(io, 1);
    expect(seen).toEqual(["/pool/a.json", "/pool/b.json"]);
    expect(events).toEqual(["a:quota", "b:ok"]);
    expect(state(io)).toMatchObject({ agentStatus: "ok", usage: { inputTokens: 12 } });
  });

  it("doesn't fail over on an auth failure: the login is bad, and the run fails", async () => {
    const seen: Array<string | undefined> = [];
    const { pool, events } = fakePool(["a", "b"]);
    const io = job(scripted([{ status: "failed", failure: "auth" }], seen), pool);
    await prepare(io);
    await runTurn(io, 1);
    expect(seen).toHaveLength(1);
    expect(events).toEqual(["a:auth"]);
    expect(state(io).agentStatus).toBe("failed");
  });

  it("fails with a clear reason when every login hit its limit", async () => {
    const { pool } = fakePool(["a"], "every Codex login is in use by another run");
    const io = job(scripted([{ status: "failed", failure: "quota" }], []), pool);
    await prepare(io);
    await runTurn(io, 1);
    expect(state(io)).toMatchObject({ agentStatus: "failed", agentError: expect.stringContaining("every Codex login") });
  });

  it("doesn't start the CLI when no login could be leased, and says why", async () => {
    const seen: Array<string | undefined> = [];
    const { pool } = fakePool([], "every Codex login is in use by another run (waited 120 s)");
    const io = job(scripted([], seen), pool);
    await prepare(io);
    await runTurn(io, 1);
    expect(seen).toEqual([]);
    expect(state(io)).toMatchObject({ agentStatus: "failed", agentError: expect.stringMatching(/no Codex login was available: every Codex login is in use/) });
  });

  it("is unchanged without a pool: the adapter gets CODEX_AUTH_FILE if set", async () => {
    const seen: Array<string | undefined> = [];
    const io = job(scripted([{ status: "ok" }], seen), undefined);
    io.env = { CODEX_AUTH_FILE: "/x/auth.json" };
    await prepare(io);
    await runTurn(io, 1);
    expect(seen).toEqual(["/x/auth.json"]);
  });
});
