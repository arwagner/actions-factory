import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { renderConfig } from "../src/config/render.js";
import { tree } from "./support/tree.js";

const factoryRoot = () =>
  tree({
    "templates/default/template.yml": `
name: default
schemaVersions: [1]
tasks:
  review:
    label: agent:review
    subject: pr
    prompt: tasks/review/prompt.md
    outcomes:
      done: {}
`,
  });
const noFetch = () => Promise.reject(new Error("unused"));

describe("renderConfig", () => {
  it("shows the stack and the merged config with each field's layer and short paths", async () => {
    const clientRoot = tree({ "factory.yml": "schemaVersion: 1\nagent: codex\n" });
    const result = await loadConfig({ clientRoot, factoryRoot: factoryRoot(), fetchRepo: noFetch });

    const markdown = renderConfig(result);

    expect(markdown).toContain("<summary>Factory config: template default → factory.yml</summary>");
    expect(markdown).toContain("agent: codex # factory.yml");
    expect(markdown).toContain("prompt: '@factory/templates/default/tasks/review/prompt.md' # template default");
    expect(markdown).not.toContain(clientRoot);
  });

  it("lists errors first, naming field and layer, and leaves the block open", async () => {
    const clientRoot = tree({ "factory.yml": "schemaVersion: 1\nagent: gemini\n" });
    const result = await loadConfig({ clientRoot, factoryRoot: factoryRoot(), fetchRepo: noFetch });

    const markdown = renderConfig(result);

    expect(markdown).toContain("<details open>");
    expect(markdown).toContain("- `agent` (factory.yml): must be one of: claude, codex, copilot");
  });
});
