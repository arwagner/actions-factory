import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFailure, codexAdapter } from "../src/agents/codex.js";
import { copilotAdapter } from "../src/agents/copilot.js";
import type { AdapterInput } from "../src/agents/types.js";
import { tree } from "./support/tree.js";

/**
 * A stand-in CLI: records its args (one per line), env and stdin, writes `lastMessage` to the file after `-o`,
 * copies any installed skills listing, then prints `output`.
 */
function fakeCli(output: string, lastMessage = "") {
  const dir = tree({ "last.txt": lastMessage });
  const bin = join(dir, "cli");
  writeFileSync(
    bin,
    [
      "#!/bin/bash",
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `env > "${dir}/env"`,
      `cat > "${dir}/stdin"`,
      `ls "\${CODEX_HOME:-$COPILOT_HOME}/skills" > "${dir}/skills" 2>/dev/null`,
      'prev=""; for a in "$@"; do if [ "$prev" = "-o" ]; then cp "' + dir + '/last.txt" "$a"; fi; prev="$a"; done',
      "cat <<'JSON'",
      output,
      "JSON",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, read: (name: string) => readFileSync(join(dir, name), "utf8") };
}

function input(overrides: Partial<AdapterInput> = {}): AdapterInput {
  const work = tree({ "prompt.md": "Do the task.", "schema.json": "{}", "skills/standards/SKILL.md": "# Standards" });
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

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("codex adapter", () => {
  const completed = lines(
    { type: "thread.started" },
    { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 40 } },
  );

  it("runs codex exec on the prompt with the API key as CODEX_API_KEY, its own home and skills, and no GitHub token", async () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    process.env.GITHUB_TOKEN = "ghs-secret";
    const cli = fakeCli(completed, '```json\n{"outcome":"done"}\n```');
    const io = input({ model: "gpt-5.5" });

    const output = await codexAdapter({ install: async () => cli.bin }).run(io);

    expect(output).toEqual({ status: "ok", usage: { inputTokens: 900, outputTokens: 40 } });
    const args = cli.read("args").split("\n");
    expect(args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toEqual(expect.arrayContaining(["--model", "gpt-5.5", "-"]));
    expect(cli.read("stdin")).toBe("Do the task.");
    const env = cli.read("env");
    expect(env).toContain("CODEX_API_KEY=sk-secret");
    expect(env).not.toContain("OPENAI_API_KEY=");
    expect(env).not.toContain("ghs-secret");
    expect(cli.read("skills").trim()).toBe("standards");
    // The agent wrote no plan file, so the plan comes from its final message.
    expect(JSON.parse(readFileSync(io.planFile, "utf8"))).toEqual({ outcome: "done" });
  });

  it("enforces read-only with Codex's sandbox, and asks for the plan as the final message", async () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    const cli = fakeCli(completed, '{"outcome":"done"}');

    await codexAdapter({ install: async () => cli.bin }).run(input({ permission: "read-only" }));

    expect(cli.read("args")).toContain("--sandbox\nread-only");
    expect(cli.read("args")).not.toContain("--dangerously-bypass");
    expect(cli.read("stdin")).toContain("end with the plan JSON as your final message");
  });

  it("fails a turn Codex reports as failed, and scrubs the key from the transcript", async () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    const cli = fakeCli(lines({ type: "error", message: "Incorrect API key provided: sk-secret" }, { type: "turn.failed" }));
    const io = input();

    const output = await codexAdapter({ install: async () => cli.bin }).run(io);

    expect(output.status).toBe("failed");
    expect(readFileSync(io.transcriptFile, "utf8")).not.toContain("sk-secret");
    expect(existsSync(io.planFile)).toBe(false);
  });

  it("pings: passes on a completed turn, fails with Codex's scrubbed error", async () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    expect(await codexAdapter({ install: async () => fakeCli(completed).bin }).ping()).toEqual({ ok: true, detail: "Codex 0.167.0 answered a test prompt" });
    const bad = await codexAdapter({ install: async () => fakeCli(lines({ type: "error", message: "Incorrect API key provided: sk-secret" })).bin }).ping();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("Incorrect API key");
    expect(bad.detail).not.toContain("sk-secret");
  });
});

describe("codex adapter, leased ChatGPT login", () => {
  const completed = lines({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  const auth = JSON.stringify({ tokens: { access_token: "access-secret-1", refresh_token: "refresh-secret-1" } });

  /** A CLI that records auth.json as it finds it, then optionally rewrites it as a refresh would. */
  function authCli(output: string, rewrite?: string) {
    const dir = tree({});
    const bin = join(dir, "cli");
    writeFileSync(
      bin,
      [
        "#!/bin/bash",
        `cp "$CODEX_HOME/auth.json" "${dir}/seen"`,
        `(stat -c %a "$CODEX_HOME/auth.json" 2>/dev/null || stat -f %Lp "$CODEX_HOME/auth.json") > "${dir}/mode"`,
        `env > "${dir}/env"`,
        `echo "$CODEX_HOME" > "${dir}/home"`,
        "cat > /dev/null",
        ...(rewrite ? [`printf '%s' '${rewrite}' > "$CODEX_HOME/auth.json"`] : []),
        "cat <<'JSON'",
        output,
        "JSON",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return { bin, read: (n: string) => readFileSync(join(dir, n), "utf8") };
  }
  const leasedFile = () => {
    const file = join(tree({}), "auth.json");
    writeFileSync(file, auth);
    return file;
  };

  it("writes the leased login into the temporary home at 0600, reads it back unchanged, and removes the home", async () => {
    const authFile = leasedFile();
    const cli = authCli(completed);
    const output = await codexAdapter({ install: async () => cli.bin }).run(input({ authFile }));
    expect(output.status).toBe("ok");
    expect(cli.read("seen")).toBe(auth);
    expect(cli.read("mode").trim()).toBe("600");
    expect(output.auth).toEqual({ path: authFile, changed: false });
    expect(existsSync(cli.read("home").trim())).toBe(false);
    expect(cli.read("env")).not.toContain("CODEX_AUTH_FILE");
  });

  it("hands back a refreshed login and says it changed", async () => {
    const authFile = leasedFile();
    const refreshed = JSON.stringify({ tokens: { access_token: "access-secret-2", refresh_token: "refresh-secret-2" } });
    const output = await codexAdapter({ install: async () => authCli(completed, refreshed).bin }).run(input({ authFile }));
    expect(output.auth).toEqual({ path: authFile, changed: true });
    expect(readFileSync(authFile, "utf8")).toBe(refreshed);
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
  });

  it("scrubs the login's tokens from the transcript", async () => {
    const io = input({ authFile: leasedFile() });
    const cli = authCli(lines({ type: "error", message: "bad refresh-secret-1 / access-secret-1" }, { type: "turn.failed" }));
    await codexAdapter({ install: async () => cli.bin }).run(io);
    const transcript = readFileSync(io.transcriptFile, "utf8");
    expect(transcript).not.toContain("refresh-secret-1");
    expect(transcript).not.toContain("access-secret-1");
  });

  it("an API key or access token wins over the leased login", async () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    const dir = tree({});
    const bin = join(dir, "cli");
    writeFileSync(bin, `#!/bin/bash\nls "$CODEX_HOME" > "${dir}/ls"\ncat >/dev/null\necho '${completed}'`);
    chmodSync(bin, 0o755);
    const output = await codexAdapter({ install: async () => bin }).run(input({ authFile: leasedFile() }));
    expect(output.auth).toBeUndefined();
    expect(readFileSync(join(dir, "ls"), "utf8")).not.toContain("auth.json");
  });

  it("reports an auth failure and a quota failure apart", async () => {
    const bad = authCli(lines({ type: "error", message: "401 Unauthorized: refresh token was already used" }, { type: "turn.failed" }));
    const slow = authCli(lines({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } }));
    expect((await codexAdapter({ install: async () => bad.bin }).run(input({ authFile: leasedFile() }))).failure).toBe("auth");
    expect((await codexAdapter({ install: async () => slow.bin }).run(input({ authFile: leasedFile() }))).failure).toBe("quota");
  });

  it("classifies messages", () => {
    expect(classifyFailure("429 Too Many Requests")).toBe("quota");
    expect(classifyFailure("Your access token could not be refreshed; please log in again")).toBe("auth");
    expect(classifyFailure("network unreachable")).toBeUndefined();
  });
});

describe("copilot adapter", () => {
  const session = lines(
    { type: "assistant.usage", data: { inputTokens: 500, outputTokens: 20 } },
    { type: "assistant.message", data: { content: "Here is the plan:\n```json\n{\"outcome\":\"done\"}\n```" } },
    { type: "assistant.usage", data: { inputTokens: 300, outputTokens: 10 } },
  );

  it("runs copilot -p with its own token only, GitHub MCP off, its own home and skills", async () => {
    process.env.COPILOT_GITHUB_TOKEN = "copilot-secret";
    process.env.GH_TOKEN = "gh-secret";
    process.env.FACTORY_TOKEN = "factory-secret";
    const cli = fakeCli(session);
    const io = input();

    const output = await copilotAdapter({ install: async () => cli.bin }).run(io);

    expect(output).toEqual({ status: "ok", usage: { inputTokens: 800, outputTokens: 30 } });
    const args = cli.read("args");
    expect(args.startsWith("-p\nDo the task.\n")).toBe(true);
    for (const flag of ["--output-format\njson", "--disable-builtin-mcps", "--no-auto-update", "--allow-all-tools"]) expect(args).toContain(flag);
    const env = cli.read("env");
    expect(env).toContain("COPILOT_GITHUB_TOKEN=copilot-secret");
    expect(env).not.toContain("gh-secret");
    expect(env).not.toContain("factory-secret");
    expect(cli.read("skills").trim()).toBe("standards");
    expect(JSON.parse(readFileSync(io.planFile, "utf8"))).toEqual({ outcome: "done" });
  });

  it("denies the write tool for read-only tasks", async () => {
    const cli = fakeCli(session);

    await copilotAdapter({ install: async () => cli.bin }).run(input({ permission: "read-only" }));

    expect(cli.read("args")).toContain("--deny-tool\nwrite");
    expect(cli.read("args")).toContain("end with the plan JSON as your final message");
  });
});
