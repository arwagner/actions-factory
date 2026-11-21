import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { tree } from "./support/tree.js";

const defaultTemplate = {
  "templates/default/template.yml": `
name: default
schemaVersions: [1]
checks: [npm test]
labels:
  needs-a-human: { color: d93f0b }
tasks:
  review:
    label: agent:review
    subject: pr
    prompt: tasks/review/prompt.md
    skills:
      standards: skills/standards
    outcomes:
      done: { waitsOnPerson: true }
`,
  "templates/default/tasks/review/prompt.md": "Review the PR.",
};

const noFetch = () => {
  throw new Error("no remote templates in this test");
};

describe("loadConfig", () => {
  it("uses the default template when factory.yml names none, with its paths made absolute", async () => {
    const factoryRoot = tree(defaultTemplate);
    const clientRoot = tree({ "factory.yml": "schemaVersion: 1\n" });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo: noFetch });

    expect(result.errors).toEqual([]);
    const review = (result.config.tasks as Record<string, Record<string, unknown>>).review;
    expect(review.prompt).toBe(join(factoryRoot, "templates/default/tasks/review/prompt.md"));
    expect(review.skills).toEqual({ standards: join(factoryRoot, "templates/default/skills/standards") });
    expect(result.config.checks).toEqual(["npm test"]);
    expect(result.layers.map((l) => l.name)).toEqual(["template default", "factory.yml"]);
  });

  it("applies factory.yml as the last layer: maps merge, lists replace, null removes", async () => {
    const factoryRoot = tree({
      ...defaultTemplate,
      "templates/default/template.yml": defaultTemplate["templates/default/template.yml"] + `
  merge:
    label: agent:merge
    subject: pr
    prompt: tasks/merge/prompt.md
    outcomes:
      merged: {}
`,
    });
    const clientRoot = tree({
      "factory.yml": `
schemaVersion: 1
checks: [make lint]
tasks:
  review:
    agent: codex
    skills:
      standards: null
      house-style: .factory/skills/house-style
  merge: null
`,
    });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo: noFetch });

    expect(result.errors).toEqual([]);
    const tasks = result.config.tasks as Record<string, Record<string, unknown>>;
    expect(Object.keys(tasks)).toEqual(["review"]);
    expect(tasks.review.agent).toBe("codex");
    expect(tasks.review.subject).toBe("pr");
    expect(tasks.review.skills).toEqual({ "house-style": join(clientRoot, ".factory/skills/house-style") });
    expect(result.config.checks).toEqual(["make lint"]);
    expect(result.provenance).toMatchObject({
      checks: "factory.yml",
      "tasks.review.agent": "factory.yml",
      "tasks.review.subject": "template default",
      "labels.needs-a-human.color": "template default",
    });
    expect(result.provenance).not.toHaveProperty("tasks.merge");
  });

  it("names the layer that set an invalid field", async () => {
    const factoryRoot = tree(defaultTemplate);
    const clientRoot = tree({ "factory.yml": "schemaVersion: 1\ntasks:\n  review:\n    turns: 0\n" });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo: noFetch });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ path: "tasks.review.turns", layer: "factory.yml", message: "must be >= 1" }]);
  });

  it("appends instructions from every layer, reading a file when one is named", async () => {
    const factoryRoot = tree({
      ...defaultTemplate,
      "templates/default/template.yml": defaultTemplate["templates/default/template.yml"].replace(
        "checks: [npm test]",
        "checks: [npm test]\ninstructions: Be brief.",
      ),
    });
    const clientRoot = tree({
      "factory.yml": `
schemaVersion: 1
instructions: .factory/house-rules.md
tasks:
  review:
    instructions: Check the changelog.
`,
      ".factory/house-rules.md": "Use British spelling.",
    });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo: noFetch });

    expect(result.errors).toEqual([]);
    expect(result.config.instructions).toBe("Be brief.\n\nUse British spelling.");
    const tasks = result.config.tasks as Record<string, Record<string, unknown>>;
    expect(tasks.review.instructions).toBe("Check the changelog.");
  });

  it("stacks a client-repo template on the shipped one it extends", async () => {
    const factoryRoot = tree(defaultTemplate);
    const clientRoot = tree({
      "factory.yml": "schemaVersion: 1\ntemplate: ./factory/lean\n",
      "factory/lean/template.yml": "name: lean\nschemaVersions: [1]\nextends: default\ntasks:\n  review:\n    prompt: review.md\n",
      "factory/lean/review.md": "Lean review.",
    });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo: noFetch });

    expect(result.errors).toEqual([]);
    expect(result.layers.map((l) => l.name)).toEqual(["template default", "template ./factory/lean", "factory.yml"]);
    const tasks = result.config.tasks as Record<string, Record<string, unknown>>;
    expect(tasks.review.prompt).toBe(join(clientRoot, "factory/lean/review.md"));
  });

  it("fetches a template from another repo, resolving its own ./ extends inside that repo", async () => {
    const factoryRoot = tree(defaultTemplate);
    const remote = tree({
      "flows/team/template.yml": "name: team\nschemaVersions: [1]\nextends: ./sub\n",
      "flows/team/sub/template.yml": "name: sub\nschemaVersions: [1]\nextends: default\nmodel: big\n",
    });
    const fetched: string[] = [];
    const fetchRepo = async (r: { owner: string; repo: string; ref: string }) => {
      fetched.push(`${r.owner}/${r.repo}@${r.ref}`);
      return remote;
    };
    const clientRoot = tree({ "factory.yml": "schemaVersion: 1\ntemplate: acme/templates/flows/team@v2\n" });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo });

    expect(result.errors).toEqual([]);
    expect(fetched).toEqual(["acme/templates@v2"]);
    expect(result.layers.map((l) => l.name)).toEqual([
      "template default",
      "template acme/templates/flows/team/sub@v2",
      "template acme/templates/flows/team@v2",
      "factory.yml",
    ]);
    expect(result.config.model).toBe("big");
  });

  describe("a stack that can't be built", () => {
    const load = (factoryYml: string, clientFiles: Record<string, string> = {}, fetchRepo = noFetch) =>
      loadConfig({
        clientRoot: tree({ "factory.yml": factoryYml, ...clientFiles }),
        factoryRoot: tree(defaultTemplate),
        fetchRepo,
      });

    it("names a template that doesn't exist", async () => {
      const result = await load("schemaVersion: 1\ntemplate: nope\n");

      expect(result.ok).toBe(false);
      expect(result.errors).toEqual([
        { path: "template", layer: "factory.yml", message: 'no template at "nope" (expected template nope/template.yml)' },
      ]);
    });

    it("refuses an extends loop", async () => {
      const result = await load("schemaVersion: 1\ntemplate: ./a\n", {
        "a/template.yml": "name: a\nschemaVersions: [1]\nextends: ./b\n",
        "a/b/template.yml": "name: b\nschemaVersions: [1]\nextends: ./../\n",
      });

      expect(result.errors).toEqual([
        { path: "extends", layer: "template ./a/b", message: "extends loops back to template ./a" },
      ]);
    });

    it("refuses a template folder outside its repo", async () => {
      const result = await load("schemaVersion: 1\ntemplate: ./../elsewhere\n");

      expect(result.errors).toEqual([
        { path: "template", layer: "factory.yml", message: '"./../elsewhere" points outside its repo' },
      ]);
    });

    it("refuses a template that doesn't support the config's schemaVersion", async () => {
      const result = await load("schemaVersion: 1\ntemplate: ./old\n", {
        "old/template.yml": "name: old\nschemaVersions: [2]\n",
      });

      expect(result.errors).toEqual([
        { path: "schemaVersions", layer: "template ./old", message: "doesn't support schemaVersion 1 (supports 2)" },
      ]);
    });

    it("reports a remote repo that can't be fetched", async () => {
      const result = await load("schemaVersion: 1\ntemplate: acme/missing@v1\n", {}, () => {
        throw new Error("repository not found");
      });

      expect(result.errors).toEqual([
        { path: "template", layer: "factory.yml", message: "couldn't fetch acme/missing@v1: repository not found" },
      ]);
    });

    it("reports YAML that doesn't parse", async () => {
      const result = await load("schemaVersion: 1\ntasks: [unclosed\n");

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ path: "", layer: "factory.yml" });
      expect(result.errors[0].message).toMatch(/^couldn't read factory.yml: /);
    });
  });
});
