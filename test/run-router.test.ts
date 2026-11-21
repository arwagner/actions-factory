import { beforeEach, describe, expect, it } from "vitest";
import { runRouter, type RouterIO } from "../src/router/run.js";
import { FakeGitHub } from "./support/fake-github.js";
import { tree } from "./support/tree.js";

const template = `
name: default
schemaVersions: [1]
labels:
  needs-a-human: { color: d93f0b, description: Waits on a person }
tasks:
  implement:
    label: agent:implement
    subject: issue
    prompt: p.md
    outcomes:
      done: { addLabels: [needs-a-human] }
  nightly:
    subject: repo
    prompt: p.md
    schedule: { cron: "0 9 * * *" }
    outcomes:
      done: {}
`;

let gh: FakeGitHub;
let summary: string[];
let outputs: Record<string, string>;

function io(overrides: Partial<RouterIO> = {}): RouterIO {
  return {
    eventName: "issues",
    payload: { action: "labeled", label: { name: "agent:implement" }, issue: { number: 42 }, sender: { login: "ana" } },
    clientRoot: tree({ "factory.yml": "schemaVersion: 1\noperatorIssue: 1\n" }),
    factoryRoot: tree({ "templates/default/template.yml": template, "package.json": '{"version":"1.2.0"}' }),
    cacheDir: tree({}),
    stubVersion: "1.0.0",
    factoryToken: "factory-token",
    githubToken: "github-token",
    api: gh.api,
    summary: (md) => summary.push(md),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    ...overrides,
  };
}

beforeEach(() => {
  gh = new FakeGitHub();
  gh.permissions = { ana: "write", tri: "read" };
  summary = [];
  outputs = {};
});

describe("runRouter", () => {
  it("hands a writer's labeled issue to the task runner: labels made, trigger label taken off", async () => {
    gh.labels = [{ name: "needs-a-human", color: "000000", description: "old" }];

    const decision = await runRouter(io());

    expect(decision).toMatchObject({ kind: "run", task: "implement" });
    expect(JSON.parse(outputs.decision)).toMatchObject({ kind: "run", task: "implement", subject: { kind: "issue", number: 42 } });
    expect(outputs.task).toBe("implement");
    expect(JSON.parse(outputs["agent-job"])).toEqual({
      agent: "claude",
      cliVersion: "2.1.319",
      runsOn: "ubuntu-latest",
      container: "",
      timeout: 60,
      stepTimeout: 65,
      turns: 1,
      repoWide: false,
      jobTimeout: 90,
    });
    expect(gh.calls("updateLabel").map((w) => w.args)).toEqual([
      { name: "needs-a-human", color: "d93f0b", description: "Waits on a person" },
    ]);
    expect(gh.calls("createLabel").map((w) => (w.args as { name: string }).name).sort()).toEqual(["agent:blocked", "agent:implement"]);
    expect(gh.calls("removeLabel")).toEqual([{ token: "factory-token", call: "removeLabel", args: { number: 42, name: "agent:implement" } }]);
    expect(gh.writes.every((w) => w.token === "factory-token")).toBe(true);
  });

  it("refuses a label added by someone without write access, and takes the label off", async () => {
    const decision = await runRouter(
      io({ payload: { action: "labeled", label: { name: "agent:implement" }, issue: { number: 42 }, sender: { login: "tri" } } }),
    );

    expect(decision).toMatchObject({ kind: "refuse", code: "not-writer" });
    const [comment] = gh.calls("comment");
    expect(comment.token).toBe("factory-token");
    expect(comment.args).toMatchObject({ number: 42 });
    expect((comment.args as { body: string }).body).toContain("only people with write access");
    expect(gh.calls("removeLabel").map((w) => w.args)).toEqual([{ number: 42, name: "agent:implement" }]);
    expect(outputs.task).toBeUndefined();
  });

  it("explains a missing FACTORY_TOKEN using GitHub's own token, and changes no labels", async () => {
    await runRouter(io({ factoryToken: undefined }));

    expect(gh.writes.map((w) => [w.token, w.call])).toEqual([
      ["github-token", "comment"],
      ["github-token", "removeLabel"],
    ]);
    expect((gh.calls("comment")[0].args as { body: string }).body).toContain("FACTORY_TOKEN");
  });

  it("sends a refusal with no subject to operatorIssue, once a day however many ticks repeat it", async () => {
    await runRouter(io({ eventName: "schedule", payload: {}, stubVersion: "0.9.0" }));
    await runRouter(io({ eventName: "schedule", payload: {}, stubVersion: "0.9.0" }));

    expect(gh.calls("comment").map((w) => (w.args as { number: number }).number)).toEqual([1]);
    expect(summary.join("\n")).toContain("refused (stale-stub)");
  });

  it("prints the merged config for show-config", async () => {
    await runRouter(io({ eventName: "workflow_dispatch", payload: { inputs: { command: "show-config" } } }));

    expect(summary.join("\n")).toContain("<summary>Factory config: template default → factory.yml</summary>");
    expect(JSON.parse(outputs.decision)).toMatchObject({ kind: "command", command: "show-config" });
  });

  it("writes nothing for an event that starts nothing", async () => {
    await runRouter(io({ payload: { action: "labeled", label: { name: "agent:unknown" }, issue: { number: 42 }, sender: { login: "ana" } } }));

    expect(gh.writes).toEqual([]);
    expect(summary.join("\n")).toContain("nothing to do");
  });

  it("explains a label write the token isn't allowed to make", async () => {
    const api = (token: string) => ({
      ...gh.api(token),
      createLabel: async () => {
        throw new Error("GitHub POST /labels failed: 404");
      },
    });

    await expect(runRouter(io({ api }))).rejects.toThrow(/FACTORY_TOKEN .* can't write this repo/);
  });

  describe("limits", () => {
    const runs = (n: number, title: string) => Array.from({ length: n }, (_, i) => ({ id: i + 1, title, conclusion: "success" }));

    it("defers a run over runsPerDay: the label stays, and the item gets one comment a day", async () => {
      gh.runs = runs(50, "factory · agent:review · #7");
      const now = new Date("2026-11-21T12:00:00Z");

      const first = await runRouter(io({ now }));
      await runRouter(io({ now }));

      expect(first).toMatchObject({ kind: "defer" });
      expect(gh.calls("removeLabel")).toEqual([]);
      expect(gh.calls("comment")).toHaveLength(1);
      expect((gh.calls("comment")[0].args as { body: string }).body).toContain("throttles.runsPerDay");
      expect(outputs.task).toBeUndefined();
    });

    it("parks a subject that has run 10 times today with agent:blocked, and assigns the assignee", async () => {
      gh.runs = runs(10, "factory · agent:implement · #42");
      const clientRoot = tree({ "factory.yml": "schemaVersion: 1\nassignee: ana\n" });

      const decision = await runRouter(io({ clientRoot }));

      expect(decision).toMatchObject({ kind: "refuse", code: "loop-brake" });
      expect(gh.calls("addLabels").map((w) => w.args)).toEqual([{ number: 42, names: ["agent:blocked"] }]);
      expect(gh.calls("addAssignees").map((w) => w.args)).toEqual([{ number: 42, logins: ["ana"] }]);
      expect(gh.calls("removeLabel").map((w) => w.args)).toEqual([{ number: 42, name: "agent:implement" }]);
    });

    it("unassigns the assignee when a run picks the item up", async () => {
      const clientRoot = tree({ "factory.yml": "schemaVersion: 1\nassignee: ana\n" });

      await runRouter(io({ clientRoot }));

      expect(gh.calls("removeAssignees").map((w) => w.args)).toEqual([{ number: 42, logins: ["ana"] }]);
    });
  });

  describe("the tick", () => {
    const now = new Date("2026-11-21T09:05:00Z");
    const tick = (overrides: Partial<RouterIO> = {}) => runRouter(io({ eventName: "schedule", payload: {}, runId: 500, now, ...overrides }));
    const dispatched = () => gh.calls("dispatch").map((w) => ({ token: w.token, ...(w.args as { payload: object }) }));

    beforeEach(() => {
      // This tick, a failed one (its window wasn't handled), and the last good one at 06:00.
      gh.ticks = [
        { id: 500, createdAt: "2026-11-21T09:04:00Z", conclusion: null },
        { id: 499, createdAt: "2026-11-21T08:49:00Z", conclusion: "failure" },
        { id: 498, createdAt: "2026-11-21T06:00:00Z", conclusion: "success" },
      ];
    });

    it("starts a scheduled task once for its latest slot, then waiting items oldest first, skipping blocked and busy ones", async () => {
      gh.issues = {
        30: { title: "", body: "", labels: ["agent:implement"] },
        12: { title: "", body: "", labels: ["agent:implement"] },
        15: { title: "", body: "", labels: ["agent:implement", "agent:blocked"] },
        20: { title: "", body: "", labels: ["agent:implement"] },
        25: { title: "", body: "", labels: ["agent:implement"], open: false },
      };
      gh.runs = [{ id: 401, title: "factory · agent:implement · #20", status: "in_progress", conclusion: null }];

      const decision = await tick();

      expect(decision).toMatchObject({ kind: "sweep" });
      expect(dispatched()).toEqual([
        { token: "factory-token", eventType: "factory-run", payload: { task: "nightly", trigger: "schedule:nightly" } },
        { token: "factory-token", eventType: "factory-run", payload: { task: "implement", trigger: "agent:implement", number: 12 } },
        { token: "factory-token", eventType: "factory-run", payload: { task: "implement", trigger: "agent:implement", number: 30 } },
      ]);
      expect(summary.join("\n")).toContain("`nightly`, scheduled for 2026-11-21T09:00:00.000Z: started");
      expect(outputs.task).toBeUndefined();
    });

    it("starts nothing more once today's runs reach runsPerDay", async () => {
      gh.issues = { 12: { title: "", body: "", labels: ["agent:implement"] } };
      gh.runs = Array.from({ length: 49 }, (_, i) => ({ id: i + 1, title: "factory · agent:implement · #3", conclusion: "success" }));

      await tick();

      expect(dispatched().map((d) => d.payload)).toEqual([{ task: "nightly", trigger: "schedule:nightly" }]);
      expect(summary.join("\n")).toContain("`agent:implement` on #12: held back");
    });

    it("starts nothing when no slot falls since the last handled tick and nothing waits", async () => {
      gh.ticks[2].createdAt = "2026-11-21T09:01:00Z";

      await tick();

      expect(gh.calls("dispatch")).toEqual([]);
      expect(summary.join("\n")).toContain("Nothing is due or waiting.");
    });
  });

  describe("an item the tick swept", () => {
    const swept = (number: number) =>
      io({
        eventName: "repository_dispatch",
        payload: { action: "factory-run", client_payload: { task: "implement", trigger: "agent:implement", number }, sender: { login: "factory-bot" } },
      });

    it("runs as the label event it stands for, checked against the person who added the label", async () => {
      gh.issues = { 42: { title: "", body: "", labels: ["agent:implement"] } };
      gh.labelers = { "42:agent:implement": "ana" };

      const decision = await runRouter(swept(42));

      expect(decision).toMatchObject({ kind: "run", task: "implement", subject: { kind: "issue", number: 42 }, actor: "ana" });
      expect(gh.calls("removeLabel").map((w) => w.args)).toEqual([{ number: 42, name: "agent:implement" }]);
    });

    it("refuses a label added by someone without write access", async () => {
      gh.issues = { 42: { title: "", body: "", labels: ["agent:implement"] } };
      gh.labelers = { "42:agent:implement": "tri" };

      expect(await runRouter(swept(42))).toMatchObject({ kind: "refuse", code: "not-writer" });
    });

    it("refuses a pull request from a fork", async () => {
      gh.issues = { 7: { title: "", body: "", labels: ["agent:implement"], isPullRequest: true } };
      gh.pulls = { 7: { head: "main", mergeable: false, headRepo: "someone/fork" } };
      gh.labelers = { "7:agent:implement": "ana" };

      expect(await runRouter(swept(7))).toMatchObject({ kind: "refuse", code: "fork" });
    });

    it("does nothing when the item was handled meanwhile", async () => {
      gh.issues = { 42: { title: "", body: "", labels: [] } };

      expect(await runRouter(swept(42))).toMatchObject({ kind: "ignore", reason: "#42 no longer waits on agent:implement" });
      expect(gh.writes).toEqual([]);
    });
  });
});
