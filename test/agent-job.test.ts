import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/agents/fake.js";
import { type AgentJobIO, type AgentTask, handoff, prepare, runChecks, runTurn } from "../src/runner/agent-job.js";
import { FakeGitHub } from "./support/fake-github.js";
import { tree } from "./support/tree.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

let gh: FakeGitHub;
let logs: string[];
let hookEnvs: Array<Record<string, string>>;

function setup(files: Record<string, string>, task: Partial<AgentTask> = {}): AgentJobIO {
  const checkout = tree({ "README.md": "hi\n", ...files });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "init");
  const prompts = tree({ "prompt.md": "Implement the issue." });
  return {
    workDir: join(tree({}), "factory"),
    checkout,
    task: {
      name: "implement",
      agent: "fake",
      prompt: join(prompts, "prompt.md"),
      skills: {},
      permission: "edit-workspace",
      timeout: 60,
      turns: 1,
      checksGate: true,
      checks: [],
      outcomes: { done: {} },
      ...task,
    },
    subject: { kind: "issue", number: 42 },
    api: () => gh.api("github-token"),
    adapters: { fake: fakeAdapter },
    uploadTranscript: true,
    runCommand: async (command, env) => {
      const r = spawnSync("bash", ["-c", command], { cwd: checkout, env: { ...process.env, ...env }, encoding: "utf8" });
      return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
    },
    runHook: async (_path, env) => {
      hookEnvs.push(env);
    },
    log: (line) => logs.push(line),
    env: {},
  };
}

const script = (plan: unknown, files: Record<string, string> = {}) => JSON.stringify({ plan, files });
const meta = (io: AgentJobIO) => JSON.parse(readFileSync(join(io.workDir, "handoff/meta.json"), "utf8"));
const prompt = (io: AgentJobIO) => readFileSync(join(io.workDir, "prompt.md"), "utf8");

beforeEach(() => {
  gh = new FakeGitHub();
  gh.issues[42] = { title: "Add a widget", body: "Please." };
  gh.permissions = { ana: "write" };
  logs = [];
  hookEnvs = [];
});

describe("the agent job", () => {
  it("prepares the prompt from the subject, runs the agent, and hands over its plan and work", async () => {
    const io = setup({ ".factory/fake/implement.json": script({ outcome: "done" }, { "widget.ts": "export {};\n" }) }, { hooks: { before: "/h/before.sh" } });

    await prepare(io);
    await runTurn(io, 1);
    await runChecks(io, 1, undefined);
    await handoff(io);

    expect(prompt(io)).toContain("Add a widget");
    expect(hookEnvs).toEqual([{ FACTORY_TASK: "implement", FACTORY_WORK_DIR: io.workDir, FACTORY_SUBJECT: "42" }]);
    expect(meta(io)).toEqual({
      agentStatus: "ok",
      checksPassed: true,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      turnsRun: 1,
      agentSeconds: expect.any(Number),
      checks: [],
      transcript: true,
    });
    expect(JSON.parse(readFileSync(join(io.workDir, "handoff/plan.json"), "utf8"))).toEqual({ outcome: "done" });
    const bundle = join(io.workDir, "handoff/work.bundle");
    expect(git(io.checkout, "bundle", "list-heads", bundle)).toContain("refs/heads/factory-work");
  });

  it("runs the before hook first and puts what it writes to context.md into the prompt", async () => {
    const io = setup({}, { hooks: { before: "/h/before.sh" } });
    io.runHook = async (_path, env) => writeFileSync(join(env.FACTORY_WORK_DIR, "context.md"), "Build ticket #7 next.");

    await prepare(io);

    expect(prompt(io)).toContain("## Context from the template\n\nBuild ticket #7 next.");
  });

  it("plays the fake script case whose regex matches the prompt, filling in the capture", async () => {
    const cases = {
      cases: [
        { promptMatch: "splits it", plan: { outcome: "split" } },
        { promptMatch: "builds ticket #(\\d+)", plan: { outcome: "built", ticket: "$1" }, files: { "t-$1.txt": "x\n" } },
      ],
    };
    const io = setup({ ".factory/fake/implement.json": JSON.stringify(cases) }, { hooks: { before: "/h/before.sh" } });
    io.runHook = async (_path, env) => writeFileSync(join(env.FACTORY_WORK_DIR, "context.md"), "This run builds ticket #12 of spec #5.");

    await prepare(io);
    await runTurn(io, 1);

    expect(JSON.parse(readFileSync(join(io.workDir, "plan.json"), "utf8"))).toEqual({ outcome: "built", ticket: 12 });
    expect(existsSync(join(io.checkout, "t-12.txt"))).toBe(true);
  });

  it("hands over no bundle when the agent changed nothing", async () => {
    const io = setup({ ".factory/fake/implement.json": script({ outcome: "done" }) });

    await prepare(io);
    await runTurn(io, 1);
    await handoff(io);

    expect(existsSync(join(io.workDir, "handoff/work.bundle"))).toBe(false);
  });

  it("gives the agent another round with the failing output, up to turns, then stops once checks pass", async () => {
    const io = setup(
      {
        ".factory/fake/implement.turn1.json": script({ outcome: "done" }, { "fixed.txt": "no" }),
        ".factory/fake/implement.turn2.json": script({ outcome: "done" }, { "fixed.txt": "yes" }),
      },
      { turns: 3, checks: ["grep -q yes fixed.txt || { echo 'not fixed yet'; exit 1; }"] },
    );

    await prepare(io);
    for (const turn of [1, 2, 3]) {
      await runTurn(io, turn);
      await runChecks(io, turn, undefined);
    }
    await handoff(io);

    expect(prompt(io)).toContain("not fixed yet");
    expect(JSON.parse(readFileSync(join(io.workDir, "transcript.ndjson"), "utf8")).turn).toBe(2);
    expect(meta(io)).toMatchObject({
      agentStatus: "ok",
      checksPassed: true,
      turnsRun: 2,
      checks: [{ command: expect.stringContaining("grep -q yes"), ok: true, seconds: expect.any(Number) }],
    });
  });

  it("masks check secrets before running checks, gives them to the check only, and scrubs kept output", async () => {
    const io = setup({ ".factory/fake/implement.json": script({ outcome: "done" }) }, { checks: ['echo "db is $DB_URL"; exit 1'] });

    await prepare(io);
    await runTurn(io, 1);
    await runChecks(io, 1, "DB_URL=postgres://secret-host/db\n");
    await handoff(io);

    expect(logs[0]).toBe("::add-mask::postgres://secret-host/db");
    const state = JSON.parse(readFileSync(join(io.workDir, "state.json"), "utf8"));
    expect(state.checkFailure).toContain("db is ***");
    expect(state.checkFailure).not.toContain("secret-host");
    expect(meta(io).checksPassed).toBe(false);
  });

  it("reports a failed agent, and lets ungated checks through", async () => {
    const failing = setup({}, {});
    await prepare(failing);
    await runTurn(failing, 1);
    await handoff(failing);
    expect(meta(failing).agentStatus).toBe("failed");

    const ungated = setup({ ".factory/fake/implement.json": script({ outcome: "done" }) }, { checks: ["false"], checksGate: false });
    await prepare(ungated);
    await runTurn(ungated, 1);
    await runChecks(ungated, 1, undefined);
    await handoff(ungated);
    expect(meta(ungated).checksPassed).toBe(true);
  });

  it("stops before the CLI starts when the agent has no credential, naming the secrets to set", async () => {
    let ran = false;
    const keyed = { name: "codex", credentials: ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"], run: async () => ((ran = true), { status: "ok" as const }), ping: async () => ({ ok: true, detail: "" }) };
    const io = { ...setup({}, { agent: "codex" }), adapters: { codex: keyed } };

    await prepare(io);
    await runTurn(io, 1);
    await handoff(io);

    expect(ran).toBe(false);
    expect(meta(io)).toMatchObject({
      agentStatus: "failed",
      agentError: "the codex agent has no credential. Set the `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN` secret.",
    });

    const withKey = { ...setup({}, { agent: "codex" }), adapters: { codex: keyed }, env: { CODEX_ACCESS_TOKEN: "t" } };
    await prepare(withKey);
    await runTurn(withKey, 1);
    expect(ran).toBe(true);
  });

  it("reports an adapter that throws as failed, with the reason, not as timed out", async () => {
    const broken = { name: "fake", credentials: [], run: async () => { throw new Error("Bad control character in JSON"); }, ping: async () => ({ ok: true, detail: "" }) };
    const io = { ...setup({}), adapters: { fake: broken } };

    await prepare(io);
    await runTurn(io, 1);
    await handoff(io);

    expect(meta(io)).toMatchObject({ agentStatus: "failed", agentError: "the fake adapter failed: Bad control character in JSON" });
  });

  it("keeps commits the agent made itself, measured from where the job started", async () => {
    const io = setup({ ".factory/fake/implement.json": script({ outcome: "done" }) });
    await prepare(io);
    const base = git(io.checkout, "rev-parse", "HEAD");
    await runTurn(io, 1);
    execFileSync("sh", ["-c", "echo one > one.txt && git add one.txt && git -c user.name=a -c user.email=a@a commit -qm one && echo two > two.txt"], { cwd: io.checkout });

    await handoff(io);

    const bundle = join(io.workDir, "handoff/work.bundle");
    const clone = tree({});
    git(clone, "clone", "-q", io.checkout, "c");
    git(join(clone, "c"), "fetch", "-q", bundle, "factory-work:fw");
    expect(git(join(clone, "c"), "diff", "--name-only", `${base}...fw`).split("\n").sort()).toEqual(["one.txt", "two.txt"]);
  });
});
