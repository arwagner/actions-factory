import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/agents/types.js";
import { doctorAgent } from "../src/runner/doctor-agent.js";

const adapter = (ping: { ok: boolean; detail: string }): Adapter => ({
  name: "claude",
  credentials: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  run: async () => ({ status: "ok" }),
  ping: async () => ping,
});

async function check(env: Record<string, string>, ping = { ok: true, detail: "answered" }, agent = "claude") {
  const out: string[] = [];
  const logs: string[] = [];
  const ok = await doctorAgent({ agent, adapters: { claude: adapter(ping) }, env, summary: (m) => out.push(m), log: (l) => logs.push(l) });
  return { ok, text: out.join("\n"), logs };
}

describe("doctorAgent", () => {
  it("passes when a credential is set and the test prompt is answered, naming only the secret", async () => {
    const { ok, text } = await check({ CLAUDE_CODE_OAUTH_TOKEN: "secret-value" });

    expect(ok).toBe(true);
    expect(text).toContain("`claude` agent works");
    expect(text).toContain("| ✅ | Credential | `CLAUDE_CODE_OAUTH_TOKEN` set |");
    expect(text).not.toContain("secret-value");
  });

  it("fails without any credential, naming the secrets to set, and sends no prompt", async () => {
    const { ok, text } = await check({}, { ok: true, detail: "should not run" });

    expect(ok).toBe(false);
    expect(text).toContain("**Fix:** Set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` as a repo secret.");
    expect(text).not.toContain("should not run");
  });

  it("fails when the test prompt fails, and for an agent this release doesn't have", async () => {
    const failed = await check({ ANTHROPIC_API_KEY: "k" }, { ok: false, detail: "Invalid API key" });
    expect(failed.text).toContain("| ❌ | Test prompt | Invalid API key");
    expect(failed.logs).toContain("::error::claude · Test prompt: Invalid API key Fix: Check that the credential is valid and has quota, then update the secret.");
    expect(await check({}, undefined, "gemini")).toMatchObject({ ok: false });
  });
});
