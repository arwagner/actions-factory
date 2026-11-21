import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitFetcher } from "../config/fetch.js";
import { type FetchRepo, loadConfig, type LoadResult } from "../config/load.js";
import { renderConfig } from "../config/render.js";
import type { GitHubApi, Label } from "./github.js";
import { type Decision, route } from "./route.js";
import { CLI_VERSIONS } from "../agents/versions.js";
import { countRuns, LOOP_BRAKE, startOfDay } from "./limits.js";
import { MIN_STUB_VERSION } from "./version.js";

/** Everything the route job reads and every side effect it has. */
export interface RouterIO {
  eventName: string;
  payload: Record<string, unknown>;
  /** The client repo's checkout (default branch, or a PR's base branch; never PR code). */
  clientRoot: string;
  /** This repo's checkout at `job.workflow_sha`. */
  factoryRoot: string;
  /** Where templates from other repos are fetched to. */
  cacheDir: string;
  stubVersion?: string;
  factoryToken?: string;
  githubToken: string;
  api: (token: string) => GitHubApi;
  fetchRepo?: FetchRepo;
  /** Link to this run, for comments. */
  runUrl?: string;
  summary: (markdown: string) => void;
  setOutput: (name: string, value: string) => void;
  /** This run's id, left out of today's run count. */
  runId?: number;
  now?: Date;
}

const BLOCKED: Label = { name: "agent:blocked", color: "b60205", description: "The factory stopped; see its comment" };
const TASK_LABEL_COLOR = "1d76db";

/** Runs the route job: loads the config, decides, makes the route job's own writes, and reports. */
export async function runRouter(io: RouterIO): Promise<Decision> {
  const fetchRepo = io.fetchRepo ?? gitFetcher({ cacheDir: io.cacheDir, token: io.factoryToken });
  const loaded = await loadConfig({ clientRoot: io.clientRoot, factoryRoot: io.factoryRoot, fetchRepo });
  const reader = io.api(io.githubToken);
  const writer = io.factoryToken ? io.api(io.factoryToken) : undefined;

  let decision = route({
    event: { name: io.eventName, payload: io.payload },
    config: loaded,
    context: {
      hasFactoryToken: writer !== undefined,
      stubVersion: io.stubVersion,
      factoryVersion: factoryVersion(io.factoryRoot),
      minStubVersion: MIN_STUB_VERSION,
    },
  });

  if (decision.kind === "run" && !["admin", "write"].includes(await reader.permission(decision.actor))) {
    decision = {
      kind: "refuse",
      code: "not-writer",
      message: `@${decision.actor} added ${decision.label}, but only people with write access can start factory tasks.`,
      subject: decision.subject,
      warnings: decision.warnings,
    };
  }

  if (decision.kind === "run" && "number" in decision.subject) {
    decision = await applyLimits(decision, io, loaded, reader);
  }

  if (writer && loaded.ok && decision.kind !== "ignore") {
    try {
      await ensureLabels(reader, writer, loaded.config);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line preserve-caught-error -- the message is the whole story; no secrets in it
      throw new Error(
        `couldn't create labels with FACTORY_TOKEN (${reason}). A 403 or 404 here usually means the token can't write ` +
          "this repo: check its resource owner, repository access, and Issues permission (and org approval).",
      );
    }
  }

  const trigger = (io.payload.label as { name?: string } | undefined)?.name;
  const assignee = loaded.ok ? (loaded.config.assignee as string | undefined) : undefined;
  if (decision.kind === "run" && "number" in decision.subject) {
    if (trigger) await writer!.removeLabel(decision.subject.number, trigger);
    if (assignee) await writer!.removeAssignees(decision.subject.number, [assignee]);
  } else if (decision.kind === "defer") {
    await postDeferral(decision, writer!, io);
  } else if (decision.kind === "refuse") {
    if (decision.code === "loop-brake" && decision.subject && "number" in decision.subject) {
      await writer!.addLabels(decision.subject.number, [BLOCKED.name]);
      if (assignee) await writer!.addAssignees(decision.subject.number, [assignee]);
    }
    await postRefusal(decision, { io, loaded, reader, writer, trigger });
  }

  io.summary(summaryFor(decision, loaded));
  io.setOutput("decision", JSON.stringify(decision));
  if (decision.kind === "run") {
    io.setOutput("task", decision.task);
    io.setOutput("agent-job", JSON.stringify(agentJobSettings(loaded.config, decision.task)));
  }
  return decision;
}

type Refusal = Extract<Decision, { kind: "refuse" }>;
type Run = Extract<Decision, { kind: "run" }>;

/** `runsPerDay` defers the run (the label stays, so a later tick picks it up); the loop brake parks the item. */
async function applyLimits(decision: Run, io: RouterIO, loaded: LoadResult, reader: GitHubApi): Promise<Decision> {
  const config = loaded.config as { timezone: string; throttles: { runsPerDay: number } };
  const number = (decision.subject as { number: number }).number;
  const since = startOfDay(io.now ?? new Date(), config.timezone);
  const counts = countRuns(await reader.listRunsSince(since), number, io.runId);
  if (counts.subjectToday >= LOOP_BRAKE) {
    return {
      kind: "refuse",
      code: "loop-brake",
      message: `#${number} has had ${LOOP_BRAKE} factory runs today, which looks like a loop, so it's parked. Remove \`agent:blocked\` and add ${decision.label} again to carry on.`,
      subject: decision.subject,
      warnings: decision.warnings,
    };
  }
  if (counts.today >= config.throttles.runsPerDay) {
    return {
      kind: "defer",
      reason: `this repo has reached its limit of ${config.throttles.runsPerDay} factory runs today (\`throttles.runsPerDay\`). ${decision.label} stays on, and a later tick will start it.`,
      subject: decision.subject,
      warnings: decision.warnings,
    };
  }
  return decision;
}

/** One comment per item per day, however many ticks find it still waiting. */
async function postDeferral(decision: Extract<Decision, { kind: "defer" }>, writer: GitHubApi, io: RouterIO): Promise<void> {
  if (!("number" in decision.subject)) return;
  const day = (io.now ?? new Date()).toISOString().slice(0, 10);
  const marker = `<!-- factory:deferred ${day} -->`;
  const comments = await writer.listComments(decision.subject.number);
  if (comments.some((c) => c.body.startsWith(marker))) return;
  await writer.comment(decision.subject.number, `${marker}\n**actions-factory** is waiting: ${decision.reason}`);
}

/**
 * Comments on the item and takes the trigger label off, so the sweep doesn't refuse it again on every tick.
 * Without a subject, the refusal goes to `operatorIssue` when the config names one.
 */
async function postRefusal(
  decision: Refusal,
  ctx: { io: RouterIO; loaded: LoadResult; reader: GitHubApi; writer?: GitHubApi; trigger?: string },
): Promise<void> {
  const body = `**actions-factory** didn't run${ctx.trigger ? ` \`${ctx.trigger}\`` : ""}: ${decision.message}${
    ctx.io.runUrl ? `\n\n[Run](${ctx.io.runUrl})` : ""
  }`;
  const subject = decision.subject;
  if (subject && "number" in subject) {
    const poster = ctx.writer ?? ctx.reader;
    await poster.comment(subject.number, body);
    if (ctx.trigger) await poster.removeLabel(subject.number, ctx.trigger);
    return;
  }
  const operatorIssue = ctx.loaded.config.operatorIssue;
  if (ctx.writer && typeof operatorIssue === "number") await ctx.writer.comment(operatorIssue, body);
}

/** Creates or updates every label the merged config needs: its `labels`, each task's label, and `agent:blocked`. */
async function ensureLabels(reader: GitHubApi, writer: GitHubApi, config: Record<string, unknown>): Promise<void> {
  const wanted = new Map<string, Label>();
  for (const [name, spec] of Object.entries((config.tasks ?? {}) as Record<string, { label?: string }>)) {
    if (spec.label) wanted.set(spec.label, { name: spec.label, color: TASK_LABEL_COLOR, description: `Starts the factory's ${name} task` });
  }
  wanted.set(BLOCKED.name, BLOCKED);
  for (const [name, spec] of Object.entries((config.labels ?? {}) as Record<string, Partial<Label>>)) {
    const base = wanted.get(name) ?? { name, color: "ededed", description: "" };
    wanted.set(name, { name, color: spec.color ?? base.color, description: spec.description ?? base.description });
  }
  const existing = new Map((await reader.listLabels()).map((l) => [l.name, l]));
  for (const label of wanted.values()) {
    const have = existing.get(label.name);
    if (!have) await writer.createLabel(label);
    else if (have.color.toLowerCase() !== label.color.toLowerCase() || have.description !== label.description) {
      await writer.updateLabel(label);
    }
  }
}

function summaryFor(decision: Decision, loaded: LoadResult): string {
  const lines = [`### actions-factory: ${headline(decision)}`, ""];
  for (const warning of decision.warnings) lines.push(`> [!WARNING]`, `> ${warning}`, "");
  if (decision.kind === "refuse") lines.push(decision.message, "");
  if (decision.kind === "defer") lines.push(decision.reason, "");
  if (loaded.layers.length > 0 || loaded.errors.length > 0) lines.push(renderConfig(loaded), "");
  return lines.join("\n");
}

function headline(decision: Decision): string {
  switch (decision.kind) {
    case "run":
      return `${decision.task} on ${"number" in decision.subject ? `#${decision.subject.number}` : decision.subject.kind}`;
    case "refuse":
      return `refused (${decision.code})`;
    case "command":
      return decision.command === "show-config" ? "show-config" : `${decision.command} (not available yet)`;
    case "sweep":
      return "sweep (not available yet)";
    case "defer":
      return `deferred on ${"number" in decision.subject ? `#${decision.subject.number}` : decision.subject.kind}`;
    case "ignore":
      return `nothing to do: ${decision.reason}`;
  }
}

/** What the agent job's own `runs-on`, `container` and `timeout-minutes` need, read with `fromJSON`. */
export function agentJobSettings(config: Record<string, unknown>, taskName: string) {
  const task = (config.tasks as Record<string, Record<string, unknown>>)[taskName];
  const pick = (key: string) => task[key] ?? config[key];
  const timeout = task.timeout as number;
  const agent = pick("agent") as string;
  return {
    agent,
    cliVersion: CLI_VERSIONS[agent] ?? "none",
    runsOn: pick("runsOn"),
    container: (pick("container") as string | undefined) ?? "",
    timeout,
    // The agent step's backstop; the adapter enforces `timeout` itself.
    stepTimeout: timeout + 5,
    turns: task.turns as number,
    // concurrentRuns: 1 serializes every agent job in the repo (§7).
    repoWide: (config.throttles as { concurrentRuns: unknown }).concurrentRuns === 1,
    // Setup and checks get a margin on top of the agent's own limit, within the 6 h hosted cap (§8).
    jobTimeout: Math.min(360, timeout * (task.turns as number) + 30),
  };
}

function factoryVersion(factoryRoot: string): string {
  try {
    return (JSON.parse(readFileSync(join(factoryRoot, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}
