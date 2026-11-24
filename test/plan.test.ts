import { describe, expect, it } from "vitest";
import { planJsonSchema, validatePlan } from "../src/runner/plan.js";

const writes = { comment: true, labels: ["needs-a-human"], pullRequest: false as const, push: false, closeIssue: false, createIssues: 0, merge: false };
const task = (overrides: Record<string, unknown> = {}) => ({
  subject: "issue",
  writes,
  outcomes: { done: {}, "needs-a-human": {} },
  ...overrides,
});
const issue = { subject: { kind: "issue" as const, number: 42 } };

describe("validatePlan", () => {
  it("accepts a plan within the task's outcomes and writes", () => {
    const plan = { outcome: "done", comment: "Looks fine.", labels: { add: ["needs-a-human"] } };

    expect(validatePlan(plan, task(), issue)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an outcome the task doesn't declare, and a missing one", () => {
    expect(validatePlan({ outcome: "shipped" }, task(), issue).errors).toEqual([
      { path: "outcome", message: "shipped isn't one of this task's outcomes: done, needs-a-human" },
    ]);
    expect(validatePlan({}, task(), issue).errors).toEqual([{ path: "outcome", message: "required" }]);
  });

  it("rejects writes the task doesn't allow, each named", () => {
    const plan = {
      outcome: "done",
      labels: { add: ["agent:merge", "bug"], remove: ["needs-a-human"] },
      pullRequest: { title: "t", body: "b" },
      closeIssue: true,
      createIssues: [{ title: "a", body: "b" }],
      merge: true,
    };

    expect(validatePlan(plan, task(), issue).errors).toEqual([
      { path: "closeIssue", message: "this task may not close the issue" },
      { path: "createIssues", message: "this task may create at most 0 issues; the plan asks for 1" },
      { path: "labels.add", message: "agent:merge is added only by a person" },
      { path: "labels.add", message: "bug isn't in this task's writes.labels" },
      { path: "merge", message: "this task may not merge" },
      { path: "pullRequest", message: "this task may not open a pull request" },
    ]);
  });

  it("rejects a comment when the task can't comment, and unknown fields", () => {
    const quiet = task({ writes: { ...writes, comment: false } });

    expect(validatePlan({ outcome: "done", comment: "hi", mood: "great" }, quiet, issue).errors).toEqual([
      { path: "comment", message: "this task may not comment" },
      { path: "mood", message: "unknown field" },
    ]);
  });

  it("requires a comment saying why, for an outcome that waits on a person", () => {
    const waiting = task({ outcomes: { done: {}, "needs-a-human": { waitsOnPerson: true } } });

    expect(validatePlan({ outcome: "needs-a-human" }, waiting, issue).errors).toEqual([
      { path: "comment", message: "needs-a-human waits on a person, so say in a comment what they have to decide or do" },
    ]);
    expect(validatePlan({ outcome: "needs-a-human", comment: "  " }, waiting, issue).ok).toBe(false);
    expect(validatePlan({ outcome: "needs-a-human", comment: "Pick a lease store." }, waiting, issue).ok).toBe(true);
    expect(validatePlan({ outcome: "done" }, waiting, issue).ok).toBe(true);
    // A task that can't comment can't explain, so it isn't asked to.
    expect(validatePlan({ outcome: "needs-a-human" }, { ...waiting, writes: { ...writes, comment: false } }, issue).ok).toBe(true);
  });

  it("accepts the extra fields a task's planSchema declares, validated by it", () => {
    const planSchema = { type: "object", properties: { confidence: { type: "number", maximum: 1 } } };

    expect(validatePlan({ outcome: "done", confidence: 0.5 }, task(), { ...issue, planSchema }).ok).toBe(true);
    expect(validatePlan({ outcome: "done", confidence: 3 }, task(), { ...issue, planSchema }).errors).toEqual([
      { path: "confidence", message: "must be <= 1" },
    ]);
  });

  it("validates each item of a batch plan, which must cover only the batch's issues, once each", () => {
    const batch = task({ subject: "batch", writes: { ...writes, closeIssue: true }, outcomes: { "easy-call": {}, duplicate: {} } });
    const planSchema = { type: "object", properties: { duplicate_of: { type: "integer" } } };
    const ctx = { subject: { kind: "batch" as const, numbers: [1, 2, 3] }, planSchema };
    const plan = {
      items: [
        { number: 1, outcome: "easy-call" },
        { number: 2, outcome: "duplicate", close: true, duplicate_of: 1 },
        { number: 2, outcome: "easy-call" },
        { number: 9, outcome: "nope" },
      ],
    };

    expect(validatePlan(plan, batch, ctx).errors).toEqual([
      { path: "items.2.number", message: "#2 appears more than once" },
      { path: "items.3.number", message: "#9 isn't in this batch" },
      { path: "items.3.outcome", message: "nope isn't one of this task's outcomes: easy-call, duplicate" },
    ]);
  });
});

describe("planJsonSchema", () => {
  it("gives the agent the base fields plus the task's extras, per item for a batch", () => {
    const planSchema = { type: "object", properties: { duplicate_of: { type: "integer" } } };

    const single = planJsonSchema({ subject: { kind: "issue", number: 1 }, planSchema }) as { required: string[]; properties: object };
    expect(single.required).toEqual(["outcome"]);
    expect(Object.keys(single.properties)).toEqual(["outcome", "comment", "labels", "pullRequest", "closeIssue", "createIssues", "merge", "duplicate_of"]);

    const batch = planJsonSchema({ subject: { kind: "batch", numbers: [1] }, planSchema }) as {
      properties: { items: { items: { required: string[]; properties: object } } };
    };
    expect(batch.properties.items.items.required).toEqual(["number", "outcome"]);
    expect(Object.keys(batch.properties.items.items.properties)).toContain("duplicate_of");
  });
});
