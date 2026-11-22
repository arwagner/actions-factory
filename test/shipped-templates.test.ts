import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { tree } from "./support/tree.js";

const factoryRoot = fileURLToPath(new URL("..", import.meta.url));
const load = (factoryYml: string) =>
  loadConfig({ clientRoot: tree({ "factory.yml": factoryYml }), factoryRoot, fetchRepo: () => Promise.reject(new Error("unused")) });

describe("the review-only template", () => {
  it("keeps only review, which reports rather than pushes, since it reviews people's branches", async () => {
    const result = await load("schemaVersion: 1\ntemplate: review-only\n");

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.config.tasks as object)).toEqual(["review"]);
    const review = (result.config.tasks as Record<string, { permission: string; writes: { push: boolean }; instructions: string }>).review;
    expect(review.permission).toBe("read-only");
    expect(review.writes.push).toBe(false);
    expect(review.instructions).toContain("change no code");
  });
});

describe("the spec-flow template", () => {
  it("stands alone, with its six stages", async () => {
    const result = await load("schemaVersion: 1\ntemplate: spec-flow\n");

    expect(result.errors).toEqual([]);
    expect(result.layers.map((l) => l.name)).toEqual(["template spec-flow", "factory.yml"]);
    expect(Object.keys(result.config.tasks as object)).toEqual(["discover", "define", "specify", "plan", "implement", "review"]);
  });

  it("keeps the four write-up stages read-only, each waiting on a person's sign-off", async () => {
    const tasks = (await load("schemaVersion: 1\ntemplate: spec-flow\n")).config.tasks as Record<
      string,
      { permission: string; outcomes: Record<string, { addLabels: string[]; waitsOnPerson: boolean }> }
    >;

    for (const stage of ["discover", "define", "specify", "plan"]) {
      expect(tasks[stage].permission, stage).toBe("read-only");
      expect(tasks[stage].outcomes.ready, stage).toMatchObject({ addLabels: ["needs-signoff"], waitsOnPerson: true });
    }
  });
});

describe("this repo's own factory.yml (dog-fooding)", () => {
  it("validates, on the default template", async () => {
    const result = await loadConfig({ clientRoot: factoryRoot, factoryRoot, fetchRepo: () => Promise.reject(new Error("unused")) });

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.config.tasks as object)).toContain("merge");
  });
});

describe("every shipped template", () => {
  it("names nothing after aint-farm", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    for (const file of walk(join(factoryRoot, "templates"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/aint-farm|\baint\b/i);
    }
  });
});
