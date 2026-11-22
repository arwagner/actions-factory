import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWiki, configReference, OUTLINE } from "../scripts/wiki.ts";
import { tree } from "./support/tree.js";

const root = new URL("..", import.meta.url).pathname;
const built = () => {
  const out = tree({});
  buildWiki(out, "1.2.3");
  const page = (name: string) => readFileSync(join(out, `${name}.md`), "utf8");
  return { out, page };
};

describe("the wiki", () => {
  it("has every page of the §13 outline, each with the generated-from banner, and a sidebar in that order", () => {
    const { out, page } = built();

    const pages = readdirSync(out).filter((f) => f.endsWith(".md") && f !== "_Sidebar.md").map((f) => f.replace(/\.md$/, "")).sort();
    expect(pages).toEqual(OUTLINE.map(([p]) => p).sort());
    for (const [name] of OUTLINE) expect(page(name), name).toMatch(/^> Generated from `.+` at v1\.2\.3\. Edit it there/);
    expect(page("_Sidebar")).toContain("- [Getting started](Getting-started)\n- [Identity and tokens](Identity-and-tokens)");
    expect(page("_Sidebar")).toContain("  - [Template: full](Template-full)");
  });

  it("links only to pages that exist", () => {
    const { page } = built();
    const names = new Set(OUTLINE.map(([p]) => p));

    for (const [name] of OUTLINE) {
      for (const [, target] of page(name).matchAll(/\]\(([A-Z][A-Za-z-]*)\)/g)) expect(names.has(target), `${name} → ${target}`).toBe(true);
    }
  });

  it("builds template pages from their READMEs, pointing links between templates at their pages", () => {
    const { page } = built();

    expect(page("Template-full")).toContain("](Template-default)");
    expect(page("Template-full")).not.toContain("](../");
  });

  it("documents every config field from the schema, each with a description", () => {
    const reference = configReference("1.2.3");
    const defs = JSON.parse(readFileSync(join(root, "src/config/schema/defs.schema.json"), "utf8")).$defs;

    for (const field of [...Object.keys(defs.topLevel.properties), ...Object.keys(defs.task.properties)]) expect(reference).toContain(`| \`${field}\` |`);
    for (const field of Object.keys(defs.writes.properties)) expect(reference).toContain(`| \`writes.${field}\` |`);
    const undescribed = reference.split("\n").filter((l) => l.startsWith("| `") && l.trimEnd().endsWith("|  |"));
    expect(undescribed).toEqual([]);
  });

  it("shows the stub in Getting started exactly as shipped", () => {
    const stub = readFileSync(join(root, "stub/factory.yml"), "utf8");
    const page = readFileSync(join(root, "docs/wiki/Getting-started.md"), "utf8");

    expect(page).toContain("```yaml\n" + stub + "```");
  });
});
