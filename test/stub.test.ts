import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { STUB_VERSION } from "../src/router/version.js";

const text = readFileSync(new URL("../stub/factory.yml", import.meta.url), "utf8");
const stub = parse(text);
const job = stub.jobs.factory;

describe("the stub", () => {
  it("declares its version in a comment and passes it to the router", () => {
    expect(text.split("\n")[0]).toBe(`# actions-factory stub v${STUB_VERSION}`);
    expect(job.with["stub-version"]).toBe(STUB_VERSION);
  });

  it("wakes on label events, the doctor and show-config commands, repository_dispatch and a 15-minute tick only", () => {
    expect(stub.on).toEqual({
      issues: { types: ["labeled"] },
      pull_request_target: { types: ["labeled"] },
      workflow_dispatch: {
        inputs: { command: { description: expect.any(String), type: "choice", options: ["doctor", "show-config"], default: "doctor" } },
      },
      repository_dispatch: null,
      schedule: [{ cron: "*/15 * * * *" }],
    });
  });

  it("titles a tick's dispatched runs by their trigger and item, as label runs are, so the router can count them", () => {
    expect(stub["run-name"]).toContain("github.event.client_payload.trigger");
    expect(stub["run-name"]).toContain("github.event.client_payload.number");
    expect(stub["run-name"]).toContain("'tick'");
  });

  it("calls the router at the moving major tag", () => {
    expect(job.uses).toBe("arwagner/actions-factory/.github/workflows/router.yml@v1");
  });

  it("filters label events on the agent: prefix before any runner starts", () => {
    expect(job.if).toContain("startsWith(github.event.label.name, 'agent:')");
  });

  it("passes every secret in spec section 2 by name, and nothing else", () => {
    const names = ["FACTORY_TOKEN", "FACTORY_CHECK_ENV", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "COPILOT_GITHUB_TOKEN"];
    expect(job.secrets).toEqual(Object.fromEntries(names.map((n) => [n, `\${{ secrets.${n} }}`])));
  });
});
