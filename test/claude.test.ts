import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/agents/claude.js";
import type { AdapterInput } from "../src/agents/types.js";
import { tree } from "./support/tree.js";

/** A stand-in `claude` that records its args, env and stdin, then prints `output`. */
function fakeCli(output: string, extra = "") {
  const dir = tree({});
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/args"\nenv > "${dir}/env"\ncat > "${dir}/stdin"\n${extra}\ncat <<'JSON'\n${output}\nJSON\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir, read: (name: string) => readFileSync(join(dir, name), "utf8") };
}

function input(overrides: Partial<AdapterInput> = {}): AdapterInput {
  const work = tree({ "prompt.md": "Do the task.", "schema.json": '{"type":"object"}', "skills/standards/SKILL.md": "# Standards" });
  return {
    checkout: tree({}),
    promptFile: join(work, "prompt.md"),
    skills: { standards: join(work, "skills/standards") },
    planSchemaFile: join(work, "schema.json"),
    planFile: join(work, "plan.json"),
    permission: "edit-workspace",
    timeoutMinutes: 1,
    transcriptFile: join(work, "transcript.ndjson"),
    turn: 1,
    task: "implement",
    ...overrides,
  };
}

const result = (extra: object) =>
  [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.12, usage: { input_tokens: 100, output_tokens: 20 }, ...extra }),
  ].join("\n");

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("claude adapter", () => {
  it("runs claude -p with the schema, writes the structured plan, transcript and usage, and installs skills", async () => {
    const cli = fakeCli(result({ structured_output: { outcome: "done" } }));
    const skillsDir = join(tree({}), "skills");
    const io = input({ model: "opus" });

    const output = await claudeAdapter({ install: async () => cli.bin, skillsDir }).run(io);

    expect(output).toEqual({ status: "ok", usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.12 } });
    expect(JSON.parse(readFileSync(io.planFile, "utf8"))).toEqual({ outcome: "done" });
    expect(cli.read("stdin")).toBe("Do the task.");
    const args = cli.read("args").split("\n");
    expect(args.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--json-schema", '{"type":"object"}']);
    expect(args).toContain("bypassPermissions");
    expect(args).toContain("opus");
    expect(args).not.toContain("--restricted");
    expect(readFileSync(join(skillsDir, "standards/SKILL.md"), "utf8")).toBe("# Standards");
    expect(readFileSync(io.transcriptFile, "utf8")).toContain('"type":"result"');
  });

  it("removes edit and code-running tools for a read-only task", async () => {
    const cli = fakeCli(result({ structured_output: { outcome: "done" } }));

    await claudeAdapter({ install: async () => cli.bin, skillsDir: tree({}) }).run(input({ permission: "read-only" }));

    const args = cli.read("args");
    expect(args).toContain("--restricted\n--permission-mode\ndontAsk\n--disallowedTools\nEdit\nWrite\nNotebookEdit");
    expect(args).not.toContain("bypassPermissions");
  });

  it("never passes GitHub tokens to the CLI, and scrubs its credential from the transcript", async () => {
    process.env.GITHUB_TOKEN = "ghs_should_not_leak";
    process.env.FACTORY_TOKEN = "github_pat_should_not_leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value";
    const cli = fakeCli(result({ structured_output: { outcome: "done" }, echo: "key is sk-ant-secret-value" }));
    const io = input();

    await claudeAdapter({ install: async () => cli.bin, skillsDir: tree({}) }).run(io);

    expect(cli.read("env")).not.toContain("should_not_leak");
    expect(cli.read("env")).toContain("ANTHROPIC_API_KEY=sk-ant-secret-value");
    expect(readFileSync(io.transcriptFile, "utf8")).not.toContain("sk-ant-secret-value");
  });

  it("reports failed for an error result or a non-zero exit, and timed-out when it runs too long", async () => {
    const errored = fakeCli(result({ is_error: true }));
    expect((await claudeAdapter({ install: async () => errored.bin, skillsDir: tree({}) }).run(input())).status).toBe("failed");

    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value";
    const said = fakeCli(result({ is_error: true, result: "Failed to authenticate.\nAPI Error: 401 unrelated-private-value sk-ant-secret-value" }));
    const detail = (await claudeAdapter({ install: async () => said.bin, skillsDir: tree({}) }).run(input())).detail;
    expect(detail).toBe("authentication failed (HTTP 401)");

    const crashed = fakeCli("unstructured secret from another provider", "exit 3");
    const crashedOutput = await claudeAdapter({ install: async () => crashed.bin, skillsDir: tree({}) }).run(input());
    expect(crashedOutput).toMatchObject({ status: "failed", detail: "exit 3" });

    const slow = fakeCli(result({}), "sleep 5");
    const output = await claudeAdapter({ install: async () => slow.bin, skillsDir: tree({}) }).run(input({ timeoutMinutes: 0.003 }));
    expect(output.status).toBe("timed-out");
  });

  describe("ping, for the doctor", () => {
    it("passes when Claude Code answers a tiny prompt, with no GitHub token in its env", async () => {
      const cli = fakeCli(JSON.stringify({ type: "result", is_error: false, result: "OK" }));
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret";
      process.env.FACTORY_TOKEN = "factory-secret";

      const ping = await claudeAdapter({ install: async () => cli.bin }).ping();

      expect(ping).toEqual({ ok: true, detail: "Claude Code 2.1.319 answered a test prompt" });
      expect(cli.read("args").split("\n").slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
      expect(cli.read("env")).not.toContain("factory-secret");
    });

    it("fails with what Claude Code said, minus the credential", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
      const cli = fakeCli(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key sk-ant-secret" }));

      const ping = await claudeAdapter({ install: async () => cli.bin }).ping();

      expect(ping.ok).toBe(false);
      expect(ping.detail).toContain("Invalid API key");
      expect(ping.detail).not.toContain("sk-ant-secret");
    });
  });
});
