import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

/** One problem with a plan, at a dotted path such as `labels.add` or `items.2.outcome`. */
export interface PlanError {
  path: string;
  message: string;
}

export interface PlanTask {
  subject: string;
  writes: {
    comment: boolean;
    labels: string[];
    pullRequest: false | { draft: boolean };
    push: boolean;
    closeIssue: boolean;
    createIssues: number;
    merge: boolean;
  };
  outcomes: Record<string, unknown>;
}

export interface PlanContext {
  subject: { kind: "issue" | "pr"; number: number } | { kind: "batch"; numbers: number[] } | { kind: "repo" };
  /** The task's `planSchema`, already read from its file: a JSON schema for the extra fields. */
  planSchema?: Record<string, unknown>;
}

const MERGE_LABEL = "agent:merge";

const labelChanges = {
  type: "object",
  additionalProperties: false,
  properties: {
    add: { type: "array", items: { type: "string" } },
    remove: { type: "array", items: { type: "string" } },
  },
};

/** The fields a plan for one item may carry. */
const SINGLE_FIELDS = {
  outcome: { type: "string", description: "Exactly one of the task's outcomes." },
  comment: {
    type: "string",
    description: "A comment to post on the subject. Required with an outcome that waits on a person, such as needs-a-human or blocked: say what they have to decide or do.",
  },
  labels: { ...labelChanges, description: "Labels to add or remove, from the task's allowed list." },
  pullRequest: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body"],
    properties: { title: { type: "string" }, body: { type: "string" } },
    description: "Open a pull request from the pushed branch.",
  },
  closeIssue: { type: "boolean", description: "Close the subject issue." },
  createIssues: {
    type: "array",
    description: "New issues to open.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body"],
      properties: { title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } } },
    },
  },
  merge: { type: "boolean", description: "Merge the pull request once it's mergeable." },
};

/** The fields each entry of a batch plan may carry. */
const ITEM_FIELDS = {
  number: { type: "integer", description: "The issue this entry is about." },
  outcome: SINGLE_FIELDS.outcome,
  comment: SINGLE_FIELDS.comment,
  labels: SINGLE_FIELDS.labels,
  close: { type: "boolean", description: "Close this issue." },
};

const ajv = new Ajv2020({ allErrors: true, strict: false });

/**
 * Checks an agent's plan against its task: one declared outcome per item, and only the writes the task allows,
 * within their caps. Extra fields are allowed only where the task's `planSchema` declares them.
 */
export function validatePlan(plan: unknown, task: PlanTask, ctx: PlanContext): { ok: boolean; errors: PlanError[] } {
  const errors: PlanError[] = [];
  if (!isMap(plan)) return { ok: false, errors: [{ path: "", message: "the plan must be a JSON object" }] };

  if (ctx.subject.kind === "batch") {
    const numbers = ctx.subject.numbers;
    const items = plan.items;
    if (!Array.isArray(items)) {
      errors.push({ path: "items", message: "required: one entry per issue in the batch" });
    } else {
      const seen = new Set<number>();
      items.forEach((item, i) => {
        const at = `items.${i}`;
        if (!isMap(item)) return errors.push({ path: at, message: "must be an object" });
        checkShape(item, ITEM_FIELDS, ctx.planSchema, at, errors);
        if (typeof item.number === "number") {
          if (!numbers.includes(item.number)) errors.push({ path: `${at}.number`, message: `#${item.number} isn't in this batch` });
          else if (seen.has(item.number)) errors.push({ path: `${at}.number`, message: `#${item.number} appears more than once` });
          seen.add(item.number);
        } else if (item.number === undefined) {
          errors.push({ path: `${at}.number`, message: "required" });
        }
        checkWrites(item, task, at, errors);
      });
    }
    for (const key of Object.keys(plan)) if (key !== "items") errors.push({ path: key, message: "unknown field" });
  } else {
    checkShape(plan, SINGLE_FIELDS, ctx.planSchema, "", errors);
    checkWrites(plan, task, "", errors);
    if (plan.merge === true && task.writes.merge && ctx.subject.kind !== "pr") {
      errors.push({ path: "merge", message: "only a pull request can be merged" });
    }
  }

  const sorted = errors
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.path.localeCompare(b.e.path) || a.i - b.i)
    .map(({ e }) => e);
  return { ok: sorted.length === 0, errors: sorted };
}

/** The JSON schema handed to the agent: the base fields for this kind of subject, plus the task's extras. */
export function planJsonSchema(ctx: PlanContext): Record<string, unknown> {
  const extras = (ctx.planSchema?.properties ?? {}) as Record<string, unknown>;
  if (ctx.subject.kind === "batch") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["number", "outcome"], properties: { ...ITEM_FIELDS, ...extras } },
        },
      },
    };
  }
  return { type: "object", additionalProperties: false, required: ["outcome"], properties: { ...SINGLE_FIELDS, ...extras } };
}

function checkShape(
  value: Record<string, unknown>,
  fields: Record<string, unknown>,
  planSchema: Record<string, unknown> | undefined,
  at: string,
  errors: PlanError[],
): void {
  const join = (key: string) => (at ? `${at}.${key}` : key);
  const extraKeys = new Set(Object.keys((planSchema?.properties ?? {}) as Record<string, unknown>));
  const base: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key in fields) base[key] = v;
    else if (extraKeys.has(key)) extras[key] = v;
    else errors.push({ path: join(key), message: "unknown field" });
  }
  if (base.outcome === undefined) errors.push({ path: join("outcome"), message: "required" });
  const check = (schema: Record<string, unknown>, data: unknown) => {
    const validate = ajv.compile(schema);
    if (!validate(data)) errors.push(...(validate.errors ?? []).map((e) => toPlanError(e, at)));
  };
  check({ type: "object", properties: fields }, base);
  if (planSchema) check({ ...planSchema, required: undefined }, extras);
}

function checkWrites(plan: Record<string, unknown>, task: PlanTask, at: string, errors: PlanError[]): void {
  const join = (key: string) => (at ? `${at}.${key}` : key);
  const outcomes = Object.keys(task.outcomes);
  if (typeof plan.outcome === "string" && !outcomes.includes(plan.outcome)) {
    errors.push({ path: join("outcome"), message: `${plan.outcome} isn't one of this task's outcomes: ${outcomes.join(", ")}` });
  }
  if (plan.comment !== undefined && !task.writes.comment) errors.push({ path: join("comment"), message: "this task may not comment" });
  const waits = typeof plan.outcome === "string" && (task.outcomes[plan.outcome] as { waitsOnPerson?: boolean } | undefined)?.waitsOnPerson;
  if (waits && task.writes.comment && !(typeof plan.comment === "string" && plan.comment.trim())) {
    errors.push({ path: join("comment"), message: `${plan.outcome} waits on a person, so say in a comment what they have to decide or do` });
  }
  if (isMap(plan.labels)) {
    for (const direction of ["add", "remove"] as const) {
      const labels = plan.labels[direction];
      if (!Array.isArray(labels)) continue;
      for (const label of labels) {
        if (direction === "add" && label === MERGE_LABEL) {
          errors.push({ path: join("labels.add"), message: `${MERGE_LABEL} is added only by a person` });
        } else if (!task.writes.labels.includes(label)) {
          errors.push({ path: join(`labels.${direction}`), message: `${label} isn't in this task's writes.labels` });
        }
      }
    }
  }
  if (plan.pullRequest !== undefined && task.writes.pullRequest === false) {
    errors.push({ path: join("pullRequest"), message: "this task may not open a pull request" });
  }
  for (const key of ["closeIssue", "close"]) {
    if (plan[key] === true && !task.writes.closeIssue) errors.push({ path: join(key), message: "this task may not close the issue" });
  }
  if (Array.isArray(plan.createIssues) && plan.createIssues.length > task.writes.createIssues) {
    errors.push({
      path: join("createIssues"),
      message: `this task may create at most ${task.writes.createIssues} issues; the plan asks for ${plan.createIssues.length}`,
    });
  }
  if (plan.merge === true && !task.writes.merge) errors.push({ path: join("merge"), message: "this task may not merge" });
}

function toPlanError(e: ErrorObject, at: string): PlanError {
  const segments = [...(at ? at.split(".") : []), ...e.instancePath.split("/").slice(1)];
  if (e.keyword === "required") segments.push(e.params.missingProperty);
  if (e.keyword === "additionalProperties") segments.push(e.params.additionalProperty);
  const message = e.keyword === "required" ? "required" : e.keyword === "additionalProperties" ? "unknown field" : (e.message ?? "is invalid");
  return { path: segments.join("."), message };
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
