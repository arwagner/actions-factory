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

  it("sends a refusal with no subject to operatorIssue", async () => {
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
});
