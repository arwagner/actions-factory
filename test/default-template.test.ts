import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { tree } from "./support/tree.js";

const factoryRoot = fileURLToPath(new URL("..", import.meta.url));

describe("the default template", () => {
  it("loads and validates as shipped, with its four tasks", async () => {
    const clientRoot = tree({ "factory.yml": "schemaVersion: 1\nchecks: [npm test]\n" });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo: () => Promise.reject(new Error("unused")) });

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.config.tasks as object)).toEqual(["explore", "implement", "review", "merge"]);
  });

  it("never adds agent:merge, and names nothing after aint-farm", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    for (const file of walk(join(factoryRoot, "templates/default"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/aint-farm|\baint\b/i);
    }
  });
});
