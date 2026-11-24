import { beforeEach, describe, expect, it } from "vitest";
import { applyRun, type ApplyIO } from "../src/runner/apply.js";
import { FakeGitHub } from "./support/fake-github.js";

const writes = { comment: true, labels: [] as string[], pullRequest: false as const, push: false, closeIssue: false, createIssues: 0, merge: false };
const implement = {
  label: "agent:implement",
  subject: "issue",
  allowWorkflowChanges: false,
  writes: { ...writes, push: true, pullRequest: { draft: true } },
  outcomes: { done: { addLabels: ["agent:review"], removeLabels: [], waitsOnPerson: false } },
};

let gh: FakeGitHub;
let pushed: string[];
let hooks: Array<{ path: string; env: Record<string, string> }>;

function io(overrides: Partial<ApplyIO> = {}): ApplyIO {
  return {
    taskName: "implement",
    task: implement,
    subject: { kind: "issue", number: 42 },
    plan: { outcome: "done", comment: "Built it.", pullRequest: { title: "Add widget", body: "Closes #42" } },
    agentStatus: "ok",
    checksPassed: true,
    git: {
      changedFiles: async () => ["src/widget.ts"],
      push: async (branch) => {
        pushed.push(branch);
      },
    },
    api: gh.api("factory-token"),
    runId: "9001",
    runUrl: "https://github.com/acme/app/actions/runs/9001",
    runHook: async (path, env) => {
      hooks.push({ path, env });
    },
    ...overrides,
  };
}

const statusBody = (number: number) => gh.comments[number]?.find((c) => c.body.includes("<!-- factory:status"))?.body ?? "";

beforeEach(() => {
  gh = new FakeGitHub();
  pushed = [];
  hooks = [];
});

describe("applyRun", () => {
  it("pushes to a factory branch, opens the PR, comments, applies the outcome and reports it", async () => {
    const result = await applyRun(io());

    expect(result).toEqual({
      ok: true,
      outcome: "done",
      writes: ["pushed `agent/issue-42-9001`", "opened draft PR #77 from `agent/issue-42-9001`", "commented on #42", "added `agent:review` to #42"],
    });
    expect(pushed).toEqual(["agent/issue-42-9001"]);
    expect(gh.calls("createPull")[0].args).toEqual({
      title: "Add widget",
      body: "Closes #42",
      head: "agent/issue-42-9001",
      base: "main",
      draft: true,
    });
    expect(gh.calls("comment")[0].args).toEqual({ number: 42, body: "Built it." });
    expect(gh.calls("addLabels").map((w) => w.args)).toEqual([{ number: 42, names: ["agent:review"] }]);
    expect(statusBody(42)).toContain("implement");
    expect(statusBody(42)).toContain("done");
    expect(statusBody(42)).toContain("[run](https://github.com/acme/app/actions/runs/9001)");
  });

  it("blocks the item and writes nothing else when the plan is invalid", async () => {
    const result = await applyRun(io({ plan: { outcome: "shipped" } }));

    expect(result.ok).toBe(false);
    expect(pushed).toEqual([]);
    expect(gh.calls("addLabels").map((w) => w.args)).toEqual([{ number: 42, names: ["agent:blocked"] }]);
    expect(statusBody(42)).toContain("shipped isn't one of this task's outcomes");
    expect(statusBody(42)).toContain("add `agent:implement` again");
  });

  it("refuses changes to workflow files unless the task allows them", async () => {
    const git = { changedFiles: async () => [".github/workflows/ci.yml"], push: async () => {} };

    expect((await applyRun(io({ git }))).ok).toBe(false);
    expect(statusBody(42)).toContain(".github/workflows/ci.yml");

    gh = new FakeGitHub();
    const allowed = await applyRun(io({ git, task: { ...implement, allowWorkflowChanges: true } }));
    expect(allowed.ok).toBe(true);
  });

  it("refuses changes from a task that may not push, and a push whose checks failed", async () => {
    const readOnly = { ...implement, writes: { ...writes } };
    expect((await applyRun(io({ task: readOnly, plan: { outcome: "done" } }))).ok).toBe(false);
    expect(statusBody(42)).toContain("this task may not push");

    gh = new FakeGitHub();
    expect((await applyRun(io({ checksPassed: false }))).ok).toBe(false);
    expect(pushed).toEqual([]);
    expect(statusBody(42)).toContain("checks failed");
  });

  it("blocks the item when the agent didn't finish", async () => {
    const result = await applyRun(io({ agentStatus: "timed-out", plan: undefined }));

    expect(result.ok).toBe(false);
    expect(statusBody(42)).toContain("timed out");
  });

  it("gives the agent job's reason when it knows why the agent failed", async () => {
    const agentError = "the codex agent has no credential. Set the `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN` secret.";

    await applyRun(io({ agentStatus: "failed", agentError, plan: undefined }));

    expect(statusBody(42)).toContain(`stopped: ${agentError} To retry, add \`agent:implement\` again.`);
  });

  it("shows the agent's own error text when the adapter reported one", async () => {
    const agentError = "the claude agent failed: Failed to authenticate. API Error: 401";

    await applyRun(io({ agentStatus: "failed", agentError, plan: undefined }));

    expect(statusBody(42)).toContain(`stopped: ${agentError}`);
  });

  describe("on a pull request", () => {
    const review = { ...implement, label: "agent:review", subject: "pr", writes: { ...writes, push: true } };
    const pr = { kind: "pr" as const, number: 7 };

    it("pushes fixes to the PR's own agent/* branch without opening another PR", async () => {
      gh.pulls[7] = { head: "agent/issue-42-9001", mergeable: false };

      await applyRun(io({ task: review, subject: pr, plan: { outcome: "done" } }));

      expect(pushed).toEqual(["agent/issue-42-9001"]);
      expect(gh.calls("createPull")).toEqual([]);
    });

    it("won't push to a branch the factory doesn't own", async () => {
      gh.pulls[7] = { head: "ana/feature", mergeable: false };

      expect((await applyRun(io({ task: review, subject: pr, plan: { outcome: "done" } }))).ok).toBe(false);
      expect(pushed).toEqual([]);
      expect(statusBody(7)).toContain("ana/feature");
    });

    it("waits for the head's checks before merging", async () => {
      const merge = { ...implement, label: "agent:merge", subject: "pr", writes: { ...writes, merge: true } };
      gh.pullSequence[7] = [
        { head: "agent/x", mergeable: false, pending: true },
        { head: "agent/x", mergeable: false, pending: true },
        { head: "agent/x", mergeable: true, pending: false },
      ];
      gh.pulls[7] = { head: "agent/x", mergeable: true };
      let slept = 0;

      const result = await applyRun(
        io({ task: merge, subject: pr, git: { changedFiles: async () => [], push: async () => {} }, plan: { outcome: "done", merge: true }, sleep: async () => { slept++; } }),
      );

      expect(result.ok).toBe(true);
      expect(slept).toBe(2);
      expect(gh.calls("mergePull")).toHaveLength(1);
    });

    it("merges with a merge commit when GitHub can merge it, and parks it when not", async () => {
      const merge = { ...implement, label: "agent:merge", subject: "pr", writes: { ...writes, merge: true } };
      const noChanges = { changedFiles: async () => [], push: async () => {} };
      gh.pulls[7] = { head: "agent/x", mergeable: true };

      expect(await applyRun(io({ task: merge, subject: pr, git: noChanges, plan: { outcome: "done", merge: true } }))).toEqual({
        ok: true,
        outcome: "done",
        writes: ["added `agent:review` to #7", "merged #7"],
      });
      expect(gh.calls("mergePull")).toHaveLength(1);

      gh = new FakeGitHub();
      gh.pulls[7] = { head: "agent/x", mergeable: false };
      expect((await applyRun(io({ task: merge, subject: pr, git: noChanges, plan: { outcome: "done", merge: true } }))).ok).toBe(false);
      expect(gh.calls("addLabels").map((w) => w.args)).toContainEqual({ number: 7, names: ["agent:blocked"] });
      expect((await applyRun(io({ task: merge, subject: pr, git: noChanges, plan: { outcome: "done", merge: true } }))).writes).toEqual([
        "added `agent:review` to #7",
        "added `agent:blocked` to #7",
      ]);
    });
  });

  it("applies each item of a batch plan to its own issue", async () => {
    const explore = {
      label: "agent:explore",
      subject: "batch",
      allowWorkflowChanges: false,
      writes: { ...writes, closeIssue: true },
      outcomes: {
        "easy-call": { addLabels: ["agent:implement"], removeLabels: [], waitsOnPerson: false },
        duplicate: { addLabels: [], removeLabels: [], waitsOnPerson: false },
      },
    };
    const plan = {
      items: [
        { number: 1, outcome: "easy-call", comment: "Simple." },
        { number: 2, outcome: "duplicate", comment: "Same as #1.", close: true },
      ],
    };

    const result = await applyRun(
      io({ taskName: "explore", task: explore, subject: { kind: "batch", query: "q", origin: 1 }, batchNumbers: [1, 2], plan, git: { changedFiles: async () => [], push: async () => {} } }),
    );

    expect(result.ok).toBe(true);
    expect(gh.calls("addLabels").map((w) => w.args)).toEqual([{ number: 1, names: ["agent:implement"] }]);
    expect(gh.calls("closeIssue").map((w) => w.args)).toEqual([{ number: 2 }]);
    expect(gh.calls("comment").filter((w) => !(w.args as { body: string }).body.includes("factory:status")).map((w) => (w.args as { number: number }).number)).toEqual([1, 2]);
  });

  it("continues one branch per issue for a `branch: subject` task, reusing the PR it already opened", async () => {
    const task = { ...implement, branch: "subject" as const };
    gh.openPulls["agent/issue-42"] = 61;

    const result = await applyRun(io({ task }));

    expect(pushed).toEqual(["agent/issue-42"]);
    expect(gh.calls("createPull")).toEqual([]);
    expect(result.writes).toContain("pushed `agent/issue-42`");
  });

  it("tells the after hook which issues it created, in plan order", async () => {
    const task = { ...implement, writes: { ...implement.writes, createIssues: 2 }, hooks: { after: "/t/hooks/after.sh" } };
    const plan = { outcome: "done", createIssues: [{ title: "One", body: "" }, { title: "Two", body: "" }] };

    await applyRun(io({ task, plan, git: { changedFiles: async () => [], push: async () => {} } }));

    expect(hooks[0].env.FACTORY_CREATED_ISSUES).toMatch(/^\d+ \d+$/);
  });

  it("updates its status comment in place, and runs the after hook last", async () => {
    gh.comments[42] = [{ id: 5, body: "<!-- factory:status run=9001 -->\nstarted" }];
    const task = { ...implement, hooks: { after: "/t/hooks/after.sh" } };

    await applyRun(io({ task }));

    expect(gh.calls("updateComment").map((w) => (w.args as { id: number }).id)).toEqual([5]);
    expect(gh.comments[42].filter((c) => c.body.includes("factory:status"))).toHaveLength(1);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].path).toBe("/t/hooks/after.sh");
    expect(hooks[0].env).toMatchObject({ FACTORY_OUTCOME: "done", FACTORY_SUBJECT: "42" });
  });

  describe("assignee", () => {
    it("is assigned what waits on a person, and an item the run parks", async () => {
      const waits = { ...implement, outcomes: { done: { addLabels: [], removeLabels: [], waitsOnPerson: true } } };
      await applyRun(io({ task: waits, assignee: "ana", prsGetFactoryReview: true }));
      expect(gh.calls("addAssignees").map((w) => w.args)).toEqual([{ number: 42, logins: ["ana"] }]);

      gh = new FakeGitHub();
      await applyRun(io({ plan: { outcome: "nope" }, assignee: "ana" }));
      expect(gh.calls("addAssignees").map((w) => w.args)).toEqual([{ number: 42, logins: ["ana"] }]);
    });

    it("is asked to review a factory PR when no factory task reviews PRs", async () => {
      await applyRun(io({ assignee: "ana", prsGetFactoryReview: false }));

      expect(gh.calls("addAssignees").map((w) => w.args)).toEqual([{ number: 77, logins: ["ana"] }]);
      expect(gh.calls("requestReviewers").map((w) => w.args)).toEqual([{ number: 77, logins: ["ana"] }]);
    });
  });
});
