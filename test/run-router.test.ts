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
  review:
    label: agent:review
    subject: pr
    prompt: p.md
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
    stubVersion: "1.1.0",
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
  gh.issues[42] = { title: "A writer’s ticket", body: "", author: "ana" };
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
    expect(gh.calls("createLabel").map((w) => (w.args as { name: string }).name).sort()).toEqual(["agent:blocked", "agent:implement", "agent:review"]);
    expect(gh.calls("removeLabel")).toEqual([{ token: "factory-token", call: "removeLabel", args: { number: 42, name: "agent:implement" } }]);
    expect(gh.writes.every((w) => w.token === "factory-token")).toBe(true);
  });

  it("sets the codex-pool output only for a Codex task with an enrolled login", async () => {
    await runRouter(io({ poolEnrolled: async () => true }));
    expect(outputs["codex-pool"]).toBe("false"); // the default template's agent is claude

    outputs = {};
    await runRouter(io({ poolEnrolled: async () => true, clientRoot: tree({ "factory.yml": "schemaVersion: 1\noperatorIssue: 1\nagent: codex\n" }) }));
    expect(outputs["codex-pool"]).toBe("true");

    outputs = {};
    await runRouter(io({ poolEnrolled: async () => false, clientRoot: tree({ "factory.yml": "schemaVersion: 1\noperatorIssue: 1\nagent: codex\n" }) }));
    expect(outputs["codex-pool"]).toBe("false");

    outputs = {};
    await runRouter(io({ poolEnrolled: async () => { throw new Error("boom"); }, clientRoot: tree({ "factory.yml": "schemaVersion: 1\noperatorIssue: 1\nagent: codex\n" }) }));
    expect(outputs["codex-pool"]).toBe("false");
  });

  it("refuses an outsider's issue before a writer's label can start a pool-backed agent", async () => {
    gh.issues[42] = { title: "Outsider's request", body: "Edited after labeling", author: "tri" };
    const decision = await runRouter(io({
      poolEnrolled: async () => true,
      clientRoot: tree({ "factory.yml": "schemaVersion: 1\nagent: codex\n" }),
    }));

    expect(decision.kind).toBe("refuse");
    expect(outputs.task).toBeUndefined();
    expect(gh.calls("comment")[0]?.args).toMatchObject({ number: 42, body: expect.stringContaining("open a new issue under their own name") });
    expect(gh.calls("removeLabel").map((write) => write.args)).toEqual([{ number: 42, name: "agent:implement" }]);
  });

  it.each([["tri", "refuse"], ["ana", "run"]])("checks the original author %s of a same-repo PR in pool mode", async (author, kind) => {
    gh.issues[7] = { title: "Change", body: "", isPullRequest: true, author };
    const decision = await runRouter(io({
      poolEnrolled: async () => true,
      clientRoot: tree({ "factory.yml": "schemaVersion: 1\nagent: codex\n" }),
      eventName: "pull_request_target",
      payload: {
        action: "labeled",
        label: { name: "agent:review" },
        pull_request: { number: 7, head: { repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } },
        sender: { login: "ana" },
      },
    }));

    expect(decision.kind).toBe(kind);
    if (kind === "refuse") {
      expect(outputs.task).toBeUndefined();
      expect(gh.calls("comment")[0]?.args).toMatchObject({ number: 7, body: expect.stringContaining("open a new pull request") });
    } else {
      expect(outputs["head-sha"]).toBe("headsha");
      expect(outputs["codex-pool"]).toBe("true");
    }
  });

  it("drops only the outsider from a pool-backed batch, including its untrusted origin", async () => {
    gh.issues[42] = { title: "Outside origin", body: "Outsider text", author: "tri" };
    gh.issues[44] = { title: "Trusted ticket", body: "Writer text", author: "ana" };
    gh.search = [42, 44].map((number) => ({ number, ...gh.issues[number] }));
    const decision = await runRouter(io({
      poolEnrolled: async () => true,
      clientRoot: tree({ "factory.yml": "schemaVersion: 1\nagent: codex\n" }),
      factoryRoot: tree({
        "templates/default/template.yml": template.replace("    subject: issue\n", "    subject: batch\n    query: label:agent:implement\n"),
        "package.json": '{"version":"1.2.0"}',
      }),
    }));

    expect(decision).toMatchObject({ kind: "run", subject: { kind: "batch", numbers: [44] } });
    expect(JSON.parse(outputs.decision).subject).not.toHaveProperty("origin");
    expect(gh.calls("comment").map((write) => write.args)).toEqual([
      { number: 42, body: expect.stringContaining("only runs on items opened by someone with write access") },
    ]);
    expect(gh.calls("removeLabel").map((write) => write.args)).toEqual([{ number: 42, name: "agent:implement" }]);
  });

  it("does not gate outsider authors when an API key or access token overrides the pool", async () => {
    gh.issues[42] = { title: "Outside request", body: "", author: "tri" };
    const decision = await runRouter(io({
      poolEnrolled: async () => true,
      hasDirectCodexCredential: true,
      clientRoot: tree({ "factory.yml": "schemaVersion: 1\nagent: codex\n" }),
    }));

    expect(decision.kind).toBe("run");
    expect(outputs["codex-pool"]).toBe("false");
    expect(gh.calls("comment")).toEqual([]);
  });

  it("starts the run summary: the linked subject, task, template, factory version and agent", async () => {
    await runRouter(io({ runUrl: "https://github.com/acme/app/actions/runs/9", factorySha: "abcdef1234567890" }));

    const text = summary.join("\n");
    expect(text).toContain("### actions-factory: implement on #42");
    expect(text).toContain("| Subject | issue [#42](https://github.com/acme/app/issues/42) |");
    expect(text).toContain("| Task | `implement`, started by agent:implement (@ana) |");
    expect(text).toContain("| Template | template default → factory.yml |");
    expect(text).toContain("| Factory | v1.2.0 (`abcdef1`) |");
    expect(text).toContain("| Agent | claude 2.1.319, model the CLI's default |");
    expect(text).toContain("<summary>Factory config: template default → factory.yml</summary>");
  });

  it("hands a PR task the PR's head and base commits, so the work is on the PR and the config on the base", async () => {
    gh.pulls[7] = { head: "agent/issue-3-1", mergeable: false };
    const payload = {
      action: "labeled",
      label: { name: "agent:review" },
      pull_request: { number: 7, head: { repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } },
      sender: { login: "ana" },
    };

    await runRouter(io({ eventName: "pull_request_target", payload }));

    expect(outputs["head-sha"]).toBe("headsha");
    expect(outputs["base-ref"]).toBe("main");
  });

  it("hands a `branch: subject` task its issue's branch once it exists, to continue from", async () => {
    const factoryRoot = tree({
      "templates/default/template.yml": template.replace("    subject: issue\n", "    subject: issue\n    branch: subject\n"),
      "package.json": '{"version":"1.2.0"}',
    });

    await runRouter(io({ factoryRoot }));
    expect(outputs["head-sha"]).toBeUndefined();

    gh.branches["agent/issue-42"] = "spec-branch-sha";
    await runRouter(io({ factoryRoot }));
    expect(outputs["head-sha"]).toBe("spec-branch-sha");
    expect(outputs["base-ref"]).toBe("main");
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
      // The tick also warms the agent CLI cache: scheduled runs may write it, label-triggered ones may not.
      expect(JSON.parse(outputs["warm-agents"])).toEqual([{ agent: "claude", cliVersion: "2.1.319" }]);
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

  describe("the doctor", () => {
    const doctor = (overrides: Partial<RouterIO> = {}) => {
      const failures: string[] = [];
      const run = runRouter(io({ eventName: "workflow_dispatch", payload: { inputs: { command: "doctor" } }, setFailed: (m) => failures.push(m), ...overrides }));
      return run.then((decision) => ({ decision, failures, text: summary.join("\n") }));
    };

    it("passes a healthy repo: config, token access, labels and stub, and hands the agents to the agent job", async () => {
      const { failures, text } = await doctor();

      expect(failures).toEqual([]);
      expect(text).toContain("### actions-factory: doctor: all checks pass");
      expect(text).toContain("| ✅ | Config | validates; layers: template default → factory.yml |");
      expect(text).toContain("| ✅ | Token: push branches | allowed |");
      expect(text).toContain("| ✅ | Labels |");
      expect(text).toContain("| ✅ | Stub version | v1.1.0, current |");
      expect(JSON.parse(outputs["doctor-agents"])).toEqual([{ agent: "claude", cliVersion: "2.1.319" }]);
      expect(gh.calls("createLabel").length).toBeGreaterThan(0);
    });

    it("names each permission the token lacks, with the fix, and fails the job", async () => {
      gh.access["factory-token"] = { contents: 403, pullRequests: 403 };

      const { failures, text } = await doctor();

      expect(text).toContain("doctor: 2 problems");
      expect(text).toContain("| ❌ | Token: push branches | GitHub answered 403<br>**Fix:** Give the token Contents: write.");
      expect(text).toContain("| ❌ | Token: open pull requests | GitHub answered 403<br>**Fix:** Give the token Pull requests: write.");
      expect(failures).toEqual(["the doctor found 2 problems; see the run summary"]);
    });

    it("reports a missing token, a broken config and an old stub together, without stopping at the first", async () => {
      const clientRoot = tree({ "factory.yml": "schemaVersion: 1\nagent: gemini\n" });

      const { text } = await doctor({ factoryToken: undefined, clientRoot, stubVersion: "0.9.0" });

      expect(text).toContain("| ❌ | Config | `agent` (factory.yml): must be one of");
      expect(text).toContain("| ❌ | `FACTORY_TOKEN` | not set");
      expect(text).toContain("| ❌ | Stub version | v0.9.0; the current stub is v1.1.0");
      expect(JSON.parse(outputs["doctor-agents"])).toEqual([]);
    });

    it("reports labels it couldn't create instead of crashing", async () => {
      const api = (token: string) => ({
        ...gh.api(token),
        createLabel: async () => {
          throw new Error("GitHub POST /labels failed: 403");
        },
      });

      const { text } = await doctor({ api });

      expect(text).toContain("| ❌ | Labels | couldn't create them: GitHub POST /labels failed: 403");
    });
  });
});
