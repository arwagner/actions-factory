import type { GitHubApi } from "../router/github.js";
import type { Subject } from "../router/route.js";
import { type PlanContext, type PlanTask, validatePlan } from "./plan.js";

export interface ApplyTask extends PlanTask {
  label?: string;
  allowWorkflowChanges: boolean;
  outcomes: Record<string, { addLabels: string[]; removeLabels: string[]; waitsOnPerson: boolean }>;
  hooks?: { before?: string; after?: string };
}

/** What the apply job knows, and every side effect it can have. */
export interface ApplyIO {
  taskName: string;
  task: ApplyTask;
  subject: Subject;
  /** For a batch subject: the issues the agent was given. */
  batchNumbers?: number[];
  planSchema?: Record<string, unknown>;
  /** The agent's `plan.json`, or undefined if it wrote none. */
  plan: unknown;
  agentStatus: "ok" | "failed" | "timed-out";
  /** False when checks failed and the task gates on them (`checksGate`). */
  checksPassed: boolean;
  /** The agent's work, from the handed-over git bundle. */
  git: { changedFiles(): Promise<string[]>; push(branch: string): Promise<void> };
  /** Holds `FACTORY_TOKEN`. */
  api: GitHubApi;
  runId: string;
  runUrl: string;
  runHook: (path: string, env: Record<string, string>) => Promise<void>;
  /** Waits between polls while a merge waits on checks. Injected so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
}

export type ApplyResult = { ok: true; outcome: string } | { ok: false; reason: string };

const BLOCKED = "agent:blocked";
const WORKFLOWS = ".github/workflows/";

class Refusal extends Error {}

/**
 * The apply job: checks the plan against the task, makes every write itself, and reports in one status
 * comment. Any failure parks the item with `agent:blocked` and says how to retry. Nothing is retried.
 */
export async function applyRun(io: ApplyIO): Promise<ApplyResult> {
  const target = statusTarget(io.subject);
  try {
    const outcome = await applyWrites(io);
    if (target !== undefined) await upsertStatus(io, target, `✅ \`${io.taskName}\`: **${outcome}**`);
    return { ok: true, outcome };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (target !== undefined) {
      await io.api.addLabels(target, [BLOCKED]);
      const retry = io.task.label ? ` To retry, add \`${io.task.label}\` again.` : "";
      await upsertStatus(io, target, `⛔ \`${io.taskName}\` stopped: ${reason}${retry}`);
    }
    return { ok: false, reason };
  }
}

async function applyWrites(io: ApplyIO): Promise<string> {
  if (io.agentStatus !== "ok") {
    throw new Refusal(io.agentStatus === "timed-out" ? "the agent timed out." : "the agent failed.");
  }
  const ctx: PlanContext = {
    subject: io.subject.kind === "batch" ? { kind: "batch", numbers: io.batchNumbers ?? [] } : io.subject,
    planSchema: io.planSchema,
  };
  const { errors } = validatePlan(io.plan, io.task, ctx);
  if (errors.length > 0) {
    throw new Refusal(`the plan doesn't fit the task:\n${errors.map((e) => `- \`${e.path || "plan"}\`: ${e.message}`).join("\n")}`);
  }
  const plan = io.plan as Record<string, unknown>;

  const branch = await pushChanges(io);

  if (io.subject.kind === "batch") {
    for (const item of plan.items as Array<Record<string, unknown>>) await applyItem(io, item.number as number, item);
    await runAfterHook(io, { FACTORY_OUTCOME: "batch", FACTORY_PLAN: JSON.stringify(plan), FACTORY_SUBJECT: "" });
    return "batch";
  }

  const number = "number" in io.subject ? io.subject.number : undefined;
  let pullNumber: number | undefined;
  if (isMap(plan.pullRequest)) {
    if (!branch) throw new Refusal("the plan asks for a pull request, but the agent changed nothing.");
    const draft = io.task.writes.pullRequest !== false && io.task.writes.pullRequest.draft;
    const base = await io.api.defaultBranch();
    pullNumber = await io.api.createPull({ ...(plan.pullRequest as { title: string; body: string }), head: branch, base, draft });
  }
  if (number !== undefined) await applyItem(io, number, plan);
  for (const issue of (plan.createIssues ?? []) as Array<{ title: string; body: string; labels?: string[] }>) {
    await io.api.createIssue(issue);
  }
  if (plan.merge === true && number !== undefined) await mergeWhenReady(io, number);

  await runAfterHook(io, {
    FACTORY_OUTCOME: plan.outcome as string,
    FACTORY_PLAN: JSON.stringify(plan),
    FACTORY_SUBJECT: number === undefined ? "" : String(number),
    ...(pullNumber === undefined ? {} : { FACTORY_PULL_REQUEST: String(pullNumber) }),
  });
  return plan.outcome as string;
}

/** The `after` hook runs last, once every write is made. */
async function runAfterHook(io: ApplyIO, env: Record<string, string>): Promise<void> {
  if (io.task.hooks?.after) await io.runHook(io.task.hooks.after, { FACTORY_TASK: io.taskName, ...env });
}

const MERGE_POLL_MS = 30_000;
const MERGE_WAIT_MS = 30 * 60_000;

/** Waits for GitHub's checks on the head (up to 30 minutes), then merges with a merge commit, or parks. */
async function mergeWhenReady(io: ApplyIO, number: number): Promise<void> {
  const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let pull = await io.api.getPull(number);
  for (let waited = 0; pull.pending && !pull.mergeable && waited < MERGE_WAIT_MS; waited += MERGE_POLL_MS) {
    await sleep(MERGE_POLL_MS);
    pull = await io.api.getPull(number);
  }
  if (!pull.mergeable) {
    const why = pull.pending ? "its checks were still running after 30 minutes" : "it has conflicts, failing checks or missing reviews";
    throw new Refusal(`GitHub can't merge this pull request: ${why}.`);
  }
  await io.api.mergePull(number);
}

/** Pushes the agent's work, if any, to a branch the factory owns. Returns the branch, or undefined if nothing changed. */
async function pushChanges(io: ApplyIO): Promise<string | undefined> {
  const files = await io.git.changedFiles();
  if (files.length === 0) return undefined;
  if (!io.task.writes.push) throw new Refusal("the agent changed files, but this task may not push.");
  const workflows = files.filter((f) => f.startsWith(WORKFLOWS));
  if (workflows.length > 0 && !io.task.allowWorkflowChanges) {
    throw new Refusal(`the agent changed workflow files (${workflows.join(", ")}), and this task doesn't set allowWorkflowChanges.`);
  }
  if (!io.checksPassed) throw new Refusal("the checks failed, so nothing was pushed.");
  const branch = await branchFor(io);
  await io.git.push(branch);
  return branch;
}

async function branchFor(io: ApplyIO): Promise<string> {
  switch (io.subject.kind) {
    case "pr": {
      const { head } = await io.api.getPull(io.subject.number);
      if (!head.startsWith("agent/")) throw new Refusal(`the factory pushes only to agent/* branches, not ${head}.`);
      return head;
    }
    case "issue":
      return `agent/issue-${io.subject.number}-${io.runId}`;
    default:
      return `agent/${io.taskName}-${io.runId}`;
  }
}

/** One item's comment, outcome labels, plan labels and close. */
async function applyItem(io: ApplyIO, number: number, item: Record<string, unknown>): Promise<void> {
  if (typeof item.comment === "string") await io.api.comment(number, item.comment);
  const outcome = io.task.outcomes[item.outcome as string];
  const changes = (item.labels ?? {}) as { add?: string[]; remove?: string[] };
  const add = [...outcome.addLabels, ...(changes.add ?? [])];
  const remove = [...outcome.removeLabels, ...(changes.remove ?? [])];
  if (add.length > 0) await io.api.addLabels(number, add);
  for (const label of remove) await io.api.removeLabel(number, label);
  if (item.close === true || item.closeIssue === true) await io.api.closeIssue(number);
}

function statusTarget(subject: Subject): number | undefined {
  if ("number" in subject) return subject.number;
  return subject.origin;
}

/** One status comment per run, found by its hidden marker and updated in place. */
async function upsertStatus(io: ApplyIO, number: number, line: string): Promise<void> {
  const marker = `<!-- factory:status run=${io.runId} -->`;
  const body = `${marker}\n**actions-factory** · ${line}\n\n[run](${io.runUrl})`;
  const existing = (await io.api.listComments(number)).find((c) => c.body.startsWith(marker));
  if (existing) await io.api.updateComment(existing.id, body);
  else await io.api.comment(number, body);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
