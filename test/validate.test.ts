import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate.js";

const reviewTask = {
  label: "agent:review",
  subject: "pr",
  prompt: "tasks/review/prompt.md",
  outcomes: { done: { addLabels: [], removeLabels: [], waitsOnPerson: true } },
};

describe("validateConfig", () => {
  it("accepts a minimal config and fills in the spec's defaults", () => {
    const result = validateConfig({ schemaVersion: 1, tasks: { review: reviewTask } });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({
      template: "default",
      agent: "claude",
      timezone: "UTC",
      runsOn: "ubuntu-latest",
      checks: [],
      throttles: { runsPerDay: 50, concurrentRuns: "unlimited" },
      tasks: {
        review: {
          timeout: 60,
          permission: "read-only",
          checksGate: true,
          turns: 1,
          skills: {},
          allowWorkflowChanges: false,
          writes: {
            comment: true,
            labels: [],
            pullRequest: false,
            push: false,
            closeIssue: false,
            createIssues: 0,
            merge: false,
          },
        },
      },
    });
  });

  it("rejects unknown keys, naming the field", () => {
    const result = validateConfig({
      schemaVersion: 1,
      agnet: "codex",
      tasks: { review: { ...reviewTask, colour: "red" } },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: "agnet", message: "unknown field" },
      { path: "tasks.review.colour", message: "unknown field" },
    ]);
  });

  it("refuses an unknown schemaVersion", () => {
    const result = validateConfig({ schemaVersion: 2, tasks: { review: reviewTask } });

    expect(result.errors).toEqual([
      { path: "schemaVersion", message: "unsupported schemaVersion 2; this factory supports 1" },
    ]);
  });

  it("names a missing required field", () => {
    const { prompt: _omit, ...noPrompt } = reviewTask;
    const result = validateConfig({ tasks: { review: noPrompt } });

    expect(result.errors).toEqual([
      { path: "schemaVersion", message: "required" },
      { path: "tasks.review.prompt", message: "required" },
    ]);
  });

  it("reports one readable error for a field with alternative forms", () => {
    const result = validateConfig({
      schemaVersion: 1,
      runsOn: 5,
      tasks: { review: { ...reviewTask, writes: { pullRequest: true } } },
    });

    expect(result.errors).toEqual([
      { path: "runsOn", message: "invalid: Runner label or labels for the agent job." },
      {
        path: "tasks.review.writes.pullRequest",
        message: "invalid: `false`, or `{draft: boolean}` to let the plan open a pull request.",
      },
    ]);
  });

  it("lists the allowed values for an enum field", () => {
    const result = validateConfig({ schemaVersion: 1, agent: "gemini", tasks: { review: reviewTask } });

    expect(result.errors).toEqual([
      { path: "agent", message: "must be one of: claude, codex, copilot, fake" },
    ]);
  });

  describe("hard rules", () => {
    it("allows merge only on a task a person starts with its label", () => {
      const scheduled = { ...reviewTask, schedule: { cron: "0 3 * * *" }, writes: { merge: true } };
      const { label: _omit, ...scheduleOnly } = scheduled;
      const result = validateConfig({
        schemaVersion: 1,
        tasks: {
          merge: { ...reviewTask, label: "agent:merge", writes: { merge: true } },
          nightly: scheduled,
          ratchet: scheduleOnly,
        },
      });

      expect(result.errors).toEqual([
        { path: "tasks.nightly.writes.merge", message: "merge is allowed only on a task triggered by a label alone, which a person adds" },
        { path: "tasks.ratchet.writes.merge", message: "merge is allowed only on a task triggered by a label alone, which a person adds" },
      ]);
    });

    it("forbids any outcome or write from adding agent:merge", () => {
      const result = validateConfig({
        schemaVersion: 1,
        tasks: {
          review: {
            ...reviewTask,
            writes: { labels: ["needs-a-human", "agent:merge"] },
            outcomes: {
              approved: { addLabels: ["agent:merge"] },
              done: { removeLabels: ["agent:merge"] },
            },
          },
        },
      });

      expect(result.errors).toEqual([
        { path: "tasks.review.outcomes.approved.addLabels", message: "agent:merge is added only by a person" },
        { path: "tasks.review.writes.labels", message: "agent:merge is added only by a person" },
      ]);
    });

    it("requires a trigger label to start with agent:", () => {
      const result = validateConfig({ schemaVersion: 1, tasks: { review: { ...reviewTask, label: "review" } } });

      expect(result.errors).toEqual([
        { path: "tasks.review.label", message: "invalid: Trigger label. Must start with `agent:`. Omit for a schedule-only task." },
      ]);
    });

    it("requires every task to have a label or a schedule", () => {
      const { label: _omit, ...untriggered } = reviewTask;
      const result = validateConfig({ schemaVersion: 1, tasks: { review: untriggered } });

      expect(result.errors).toEqual([
        { path: "tasks.review", message: "needs a label or a schedule to ever run" },
      ]);
    });
  });

  it("allows a query only with subject: batch", () => {
    const result = validateConfig({
      schemaVersion: 1,
      tasks: {
        explore: { ...reviewTask, label: "agent:explore", subject: "batch", query: "is:open label:agent:explore" },
        review: { ...reviewTask, query: "is:open" },
      },
    });

    expect(result.errors).toEqual([{ path: "tasks.review.query", message: "allowed only with subject: batch" }]);
  });

  it("requires an IANA time zone", () => {
    const ok = validateConfig({ schemaVersion: 1, timezone: "America/New_York", tasks: { review: reviewTask } });
    const bad = validateConfig({ schemaVersion: 1, timezone: "Eastern", tasks: { review: reviewTask } });

    expect(ok.errors).toEqual([]);
    expect(bad.errors).toEqual([{ path: "timezone", message: "unknown IANA time zone \"Eastern\"" }]);
  });

  it("names the layer that set a bad field, using the closest provenance entry", () => {
    const result = validateConfig(
      {
        schemaVersion: 1,
        agent: "gemini",
        tasks: { review: { ...reviewTask, timeout: 0, turns: 0 } },
      },
      {
        provenance: {
          agent: "factory.yml",
          tasks: "template default",
          "tasks.review.turns": "template acme/flow@v2",
        },
      },
    );

    expect(result.errors).toEqual([
      { path: "agent", layer: "factory.yml", message: "must be one of: claude, codex, copilot, fake" },
      { path: "tasks.review.timeout", layer: "template default", message: "must be >= 1" },
      { path: "tasks.review.turns", layer: "template acme/flow@v2", message: "must be >= 1" },
    ]);
  });
});
