import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
    expect(hookEnvs).toEqual([{ FACTORY_TASK: "implement", FACTORY_WORK_DIR: io.workDir }]);
    expect(meta(io)).toEqual({ agentStatus: "ok", checksPassed: true, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
    expect(JSON.parse(readFileSync(join(io.workDir, "handoff/plan.json"), "utf8"))).toEqual({ outcome: "done" });
    const bundle = join(io.workDir, "handoff/work.bundle");
    expect(git(io.checkout, "bundle", "list-heads", bundle)).toContain("refs/heads/factory-work");
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
    expect(meta(io)).toMatchObject({ agentStatus: "ok", checksPassed: true });
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
});
