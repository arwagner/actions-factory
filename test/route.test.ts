import { describe, expect, it } from "vitest";
import { route, type RouteInput } from "../src/router/route.js";

const task = (label: string, subject: string) => ({ label, subject, prompt: "p.md", outcomes: { done: {} } });
const config = {
  ok: true,
  errors: [],
  config: {
    tasks: {
      explore: { ...task("agent:explore", "batch"), query: "is:open label:agent:explore" },
      implement: task("agent:implement", "issue"),
      review: task("agent:review", "pr"),
      nightly: { subject: "repo", prompt: "p.md", outcomes: { done: {} }, schedule: { cron: "0 3 * * *" } },
    },
  },
};
const context = { hasFactoryToken: true, stubVersion: "1.0.0", factoryVersion: "1.2.0", minStubVersion: "1.0.0" };

const issueLabeled = (label: string, number = 42) => ({
  name: "issues",
  payload: { action: "labeled", label: { name: label }, issue: { number }, sender: { login: "ana" } },
});
const prLabeled = (label: string, headRepo = "acme/app") => ({
  name: "pull_request_target",
  payload: {
    action: "labeled",
    label: { name: label },
    pull_request: { number: 7, head: { repo: { full_name: headRepo } }, base: { repo: { full_name: "acme/app" } } },
    sender: { login: "ana" },
  },
});

const decide = (event: RouteInput["event"], overrides: Partial<RouteInput> = {}) =>
  route({ event, config, context, ...overrides });

describe("route", () => {
  it("runs the task whose label was added to an issue", () => {
    expect(decide(issueLabeled("agent:implement"))).toEqual({
      kind: "run",
      task: "implement",
      label: "agent:implement",
      subject: { kind: "issue", number: 42 },
      actor: "ana",
      warnings: [],
    });
  });

  it("runs the task whose label was added to a pull request", () => {
    expect(decide(prLabeled("agent:review"))).toMatchObject({ kind: "run", task: "review", subject: { kind: "pr", number: 7 } });
  });

  it("runs a batch task on its query, remembering which issue was labeled", () => {
    expect(decide(issueLabeled("agent:explore", 3))).toMatchObject({
      kind: "run",
      task: "explore",
      subject: { kind: "batch", query: "is:open label:agent:explore", origin: 3 },
    });
  });

  it("refuses a label on the wrong kind of item", () => {
    expect(decide(prLabeled("agent:implement"))).toEqual({
      kind: "refuse",
      code: "wrong-subject",
      message: "agent:implement works on issues, not pull requests.",
      subject: { kind: "pr", number: 7 },
      warnings: [],
    });
    expect(decide(issueLabeled("agent:review"))).toMatchObject({
      kind: "refuse",
      message: "agent:review works on pull requests, not issues.",
    });
  });

  it("matches labels exactly, ignoring other casings and labels no task uses", () => {
    expect(decide(issueLabeled("AGENT:implement"))).toMatchObject({ kind: "ignore" });
    expect(decide(issueLabeled("agent:blocked"))).toMatchObject({ kind: "ignore" });
  });

  describe("refusals", () => {
    it("refuses a pull request from a fork, including one whose fork was deleted", () => {
      expect(decide(prLabeled("agent:review", "mallory/app"))).toMatchObject({
        kind: "refuse",
        code: "fork",
        subject: { kind: "pr", number: 7 },
      });
      const deleted = prLabeled("agent:review");
      (deleted.payload.pull_request.head as { repo: unknown }).repo = null;
      expect(decide(deleted)).toMatchObject({ kind: "refuse", code: "fork" });
    });

    it("refuses without FACTORY_TOKEN, before reading the config", () => {
      const decision = decide(issueLabeled("agent:implement"), {
        context: { ...context, hasFactoryToken: false },
        config: { ok: false, errors: [], config: {} },
      });

      expect(decision).toMatchObject({ kind: "refuse", code: "missing-token", subject: { kind: "issue", number: 42 } });
      expect(decision.kind === "refuse" && decision.message).toContain("FACTORY_TOKEN");
    });

    it("refuses on the labeled item when the config doesn't validate, listing the errors", () => {
      const decision = decide(issueLabeled("agent:anything"), {
        config: { ok: false, errors: [{ path: "agent", layer: "factory.yml", message: "must be one of: claude, codex, copilot" }], config: {} },
      });

      expect(decision).toEqual({
        kind: "refuse",
        code: "bad-config",
        message: "The factory config doesn't validate:\n- `agent` (factory.yml): must be one of: claude, codex, copilot",
        subject: { kind: "issue", number: 42 },
        warnings: [],
      });
    });

    it("refuses a stub from an older major, and warns about one older than the minimum", () => {
      const old = decide(issueLabeled("agent:implement"), { context: { ...context, stubVersion: "0.9.0" } });
      expect(old).toMatchObject({ kind: "refuse", code: "stale-stub" });

      const behind = decide(issueLabeled("agent:implement"), {
        context: { ...context, stubVersion: "1.0.0", minStubVersion: "1.1.0" },
      });
      expect(behind).toMatchObject({ kind: "run" });
      expect(behind.warnings).toEqual([
        "The stub is v1.0.0; v1.1.0 or newer is recommended. Copy the current stub from the wiki's Getting started page.",
      ]);
    });
  });

  describe("other events", () => {
    const dispatch = (command: string) => ({ name: "workflow_dispatch", payload: { inputs: { command } } });
    const tick = { name: "schedule", payload: { schedule: "*/15 * * * *" } };

    it("runs doctor and show-config even without a token or a valid config", () => {
      const broken = { context: { ...context, hasFactoryToken: false }, config: { ok: false, errors: [], config: {} } };

      expect(decide(dispatch("doctor"), broken)).toEqual({ kind: "command", command: "doctor", warnings: [] });
      expect(decide(dispatch("show-config"), broken)).toEqual({ kind: "command", command: "show-config", warnings: [] });
    });

    it("refuses an unknown command, with no subject", () => {
      expect(decide(dispatch("deploy"))).toEqual({
        kind: "refuse",
        code: "unknown-command",
        message: "Unknown command deploy. Use doctor or show-config.",
        warnings: [],
      });
    });

    it("sweeps on the schedule tick, unless something blocks every run", () => {
      expect(decide(tick)).toEqual({ kind: "sweep", warnings: [] });
      const refused = decide(tick, { config: { ok: false, errors: [], config: {} } });
      expect(refused).toMatchObject({ kind: "refuse", code: "bad-config" });
      expect(refused).not.toHaveProperty("subject");
    });

    it("ignores repository_dispatch, which is reserved, and label events other than labeled", () => {
      expect(decide({ name: "repository_dispatch", payload: { action: "build" } })).toMatchObject({ kind: "ignore" });
      const unlabeled = issueLabeled("agent:implement");
      unlabeled.payload.action = "unlabeled";
      expect(decide(unlabeled)).toMatchObject({ kind: "ignore" });
    });
  });
});
