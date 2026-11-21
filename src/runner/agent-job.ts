import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Adapter } from "../agents/types.js";
import type { GitHubApi } from "../router/github.js";
import type { Subject } from "../router/route.js";
import { WORK_REF } from "./bundle.js";
import { maskCommands, parseDotenv, scrub } from "./check-env.js";
import type { HandoffMeta } from "./handoff.js";
import { planJsonSchema } from "./plan.js";
import { buildPrompt, type PromptInput, type PromptItem } from "./prompt.js";

const git = promisify(execFile);

/** The parts of the merged task the agent job reads, with top-level fields already inherited. */
export interface AgentTask {
  name: string;
  agent: string;
  model?: string;
  prompt: string;
  instructions?: string;
  skills: Record<string, string>;
  permission: "read-only" | "edit-workspace";
  timeout: number;
  turns: number;
  checksGate: boolean;
  checks: string[];
  outcomes: Record<string, unknown>;
  planSchema?: string;
  hooks?: { before?: string };
}

export interface AgentJobIO {
  /** `$RUNNER_TEMP/factory`: prompt, schema, plan, transcript and state live here, outside the checkout. */
  workDir: string;
  checkout: string;
  task: AgentTask;
  subject: Subject;
  /**
   * Read-only GitHub access (GITHUB_TOKEN), for the subject's text and comment authors. Called only while
   * preparing, the one step that holds the token; the agent and check steps never do.
   */
  api: () => GitHubApi;
  adapters: Record<string, Adapter>;
  /** Public repos keep no transcript artifact unless the client opts in (§9). */
  uploadTranscript: boolean;
  /** Runs a shell command in the checkout with extra env, streaming its output to the log. */
  runCommand: (command: string, env: Record<string, string>) => Promise<{ code: number; output: string }>;
  runHook: (path: string, env: Record<string, string>) => Promise<void>;
  log: (line: string) => void;
  /** The step's environment, where the agent's credentials are. */
  env: Record<string, string | undefined>;
}

interface State {
  /** The commit the job started from; the handed-over work is everything since. */
  base?: string;
  promptInput: PromptInput;
  batchNumbers?: number[];
  agentStatus: HandoffMeta["agentStatus"] | "not-run";
  checksPassed?: boolean;
  checkFailure?: string;
  checkResults?: HandoffMeta["checks"];
  agentError?: string;
  agentSeconds?: number;
  turnsRun: number;
  usage?: HandoffMeta["usage"];
}

const files = (workDir: string) => ({
  state: join(workDir, "state.json"),
  prompt: join(workDir, "prompt.md"),
  planSchema: join(workDir, "plan.schema.json"),
  plan: join(workDir, "plan.json"),
  transcript: join(workDir, "transcript.ndjson"),
  handoff: join(workDir, "handoff"),
});

/** Gathers the subject, writes the prompt and plan schema, then runs the `before` hook (no agent credential). */
export async function prepare(io: AgentJobIO): Promise<void> {
  const f = files(io.workDir);
  mkdirSync(io.workDir, { recursive: true });
  const { items, batchNumbers } = await gatherSubject(io);
  const planSchema = io.task.planSchema ? JSON.parse(readFileSync(io.task.planSchema, "utf8")) : undefined;
  const ctxSubject = io.subject.kind === "batch" ? { kind: "batch" as const, numbers: batchNumbers ?? [] } : io.subject;
  writeFileSync(f.planSchema, JSON.stringify(planJsonSchema({ subject: ctxSubject, planSchema }), null, 2));
  const promptInput: PromptInput = {
    prompt: readFileSync(io.task.prompt, "utf8"),
    instructions: io.task.instructions,
    items,
    outcomes: Object.keys(io.task.outcomes),
    checks: io.task.checks,
      planFile: f.plan,
      planSchemaFile: f.planSchema,
  };
  writeFileSync(f.prompt, buildPrompt(promptInput));
  const base = (await git("git", ["rev-parse", "HEAD"], { cwd: io.checkout })).stdout.trim();
  saveState(io, { base, promptInput, batchNumbers, agentStatus: "not-run", turnsRun: 0 });
  if (io.task.hooks?.before) {
    await io.runHook(io.task.hooks.before, { FACTORY_TASK: io.task.name, FACTORY_WORK_DIR: io.workDir });
  }
}

/** One round of the agent. Skipped when an earlier round's checks passed or the agent already failed. */
export async function runTurn(io: AgentJobIO, turn: number): Promise<void> {
  const state = loadState(io);
  if (turn > io.task.turns || !needsAnotherRound(state, turn)) return;
  const f = files(io.workDir);
  if (turn > 1) writeFileSync(f.prompt, buildPrompt({ ...state.promptInput, checkFailure: state.checkFailure }));
  const adapter = io.adapters[io.task.agent];
  if (!adapter) {
    io.log(`::error::no adapter named ${io.task.agent}`);
    saveState(io, { ...state, agentStatus: "failed", turnsRun: turn, agentError: `this factory release has no ${io.task.agent} adapter` });
    return;
  }
  // §2: a run whose agent has no credential stops before the CLI starts, naming the secret it needs.
  if (adapter.credentials.length > 0 && !adapter.credentials.some((name) => io.env[name])) {
    const agentError = `the ${adapter.name} agent has no credential. Set the ${adapter.credentials.map((n) => `\`${n}\``).join(" or ")} secret.`;
    io.log(`::error::${agentError}`);
    saveState(io, { ...state, agentStatus: "failed", turnsRun: turn, agentError });
    return;
  }
  // If the step's own timeout kills this round, the state already says so.
  saveState(io, { ...state, agentStatus: "timed-out", checksPassed: undefined, turnsRun: turn });
  const started = Date.now();
  let result: Awaited<ReturnType<Adapter["run"]>>;
  try {
    result = await adapter.run({
      checkout: io.checkout,
      promptFile: f.prompt,
      skills: io.task.skills,
    planSchemaFile: f.planSchema,
    planFile: f.plan,
      permission: io.task.permission,
      model: io.task.model,
      timeoutMinutes: io.task.timeout,
      transcriptFile: f.transcript,
      turn,
      task: io.task.name,
    });
  } catch (error) {
    // The adapter itself broke (not the agent timing out): say so rather than leave the provisional timed-out.
    const agentError = `the ${adapter.name} adapter failed: ${error instanceof Error ? error.message : String(error)}`;
    io.log(`::error::${agentError}`);
    saveState(io, { ...state, agentStatus: "failed", checksPassed: undefined, turnsRun: turn, agentError });
    return;
  }
  saveState(io, {
    ...state,
    agentStatus: result.status,
    checksPassed: undefined,
    turnsRun: turn,
    usage: addUsage(state.usage, result.usage),
    agentSeconds: (state.agentSeconds ?? 0) + Math.round((Date.now() - started) / 1000),
  });
}

/**
 * The checks after a round. Masks every `FACTORY_CHECK_ENV` value first, then runs each check with the values
 * in its own environment (never `$GITHUB_ENV`). Failing output is kept, scrubbed, for the next round.
 */
export async function runChecks(io: AgentJobIO, turn: number, checkEnv: string | undefined): Promise<void> {
  const state = loadState(io);
  if (state.turnsRun !== turn || state.agentStatus !== "ok") return;
  const values = checkEnv ? parseDotenv(checkEnv) : {};
  const { commands, warnings } = maskCommands(values);
  for (const line of [...commands, ...warnings]) io.log(line);
  let failure: string | undefined;
  const results: NonNullable<HandoffMeta["checks"]> = [];
  for (const command of io.task.checks) {
    io.log(`::group::check: ${command}`);
    const started = Date.now();
    const { code, output } = await io.runCommand(command, values);
    io.log("::endgroup::");
    results.push({ command, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000) });
    if (code !== 0) {
      failure = `${command} exited with ${code}:\n${scrub(output, values).split("\n").slice(-200).join("\n")}`;
      break;
    }
  }
  saveState(io, { ...state, checksPassed: failure === undefined, checkFailure: failure, checkResults: results });
}

/** Commits the agent's work to `factory-work`, bundles it, and writes the artifact the apply job reads. */
export async function handoff(io: AgentJobIO): Promise<void> {
  const f = files(io.workDir);
  const state = existsSync(f.state) ? loadState(io) : undefined;
  mkdirSync(f.handoff, { recursive: true });
  const status = state?.agentStatus === "not-run" || !state ? "failed" : state.agentStatus;
  const meta: HandoffMeta = {
    agentStatus: status,
    checksPassed: state?.checksPassed !== false || !io.task.checksGate,
    batchNumbers: state?.batchNumbers,
    usage: state?.usage,
    turnsRun: state?.turnsRun,
    agentSeconds: state?.agentSeconds,
    checks: state?.checkResults,
    agentError: state?.agentError,
    transcript: io.uploadTranscript && existsSync(f.transcript),
  };
  writeFileSync(join(f.handoff, "meta.json"), JSON.stringify(meta, null, 2));
  if (existsSync(f.plan)) copyFileSync(f.plan, join(f.handoff, "plan.json"));
  if (meta.transcript) copyFileSync(f.transcript, join(f.handoff, "transcript.ndjson"));

  const run = (...args: string[]) =>
    git("git", ["-c", "user.name=actions-factory", "-c", "user.email=actions-factory@users.noreply.github.com", ...args], {
      cwd: io.checkout,
    });
  const base = state?.base ?? (await run("rev-parse", "HEAD")).stdout.trim();
  await run("switch", "-q", "-c", WORK_REF);
  await run("add", "-A");
  if ((await run("status", "--porcelain")).stdout.trim() !== "") await run("commit", "-q", "-m", `actions-factory: ${io.task.name}`);
  if ((await run("rev-parse", "HEAD")).stdout.trim() === base) return;
  await run("bundle", "create", join(f.handoff, "work.bundle"), `${base}..${WORK_REF}`);
}

function addUsage(a: HandoffMeta["usage"], b: HandoffMeta["usage"]): HandoffMeta["usage"] {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return { inputTokens: sum(a.inputTokens, b.inputTokens), outputTokens: sum(a.outputTokens, b.outputTokens), costUsd: sum(a.costUsd, b.costUsd) };
}

function needsAnotherRound(state: State, turn: number): boolean {
  if (turn === 1) return state.turnsRun === 0;
  return state.turnsRun === turn - 1 && state.agentStatus === "ok" && state.checksPassed === false;
}

async function gatherSubject(io: AgentJobIO): Promise<{ items: PromptItem[]; batchNumbers?: number[] }> {
  const api = io.api();
  const permissions = new Map<string, string>();
  const permission = async (user: string) => {
    if (!permissions.has(user)) permissions.set(user, await api.permission(user));
    return permissions.get(user)!;
  };
  const item = async (number: number, kind: "issue" | "pr", title?: string, body?: string): Promise<PromptItem> => {
    const issue = title === undefined ? await api.getIssue(number) : { title, body: body ?? "" };
    const comments = [];
    for (const c of await api.listComments(number)) comments.push({ ...c, permission: await permission(c.author) });
    return { number, kind, title: issue.title, body: issue.body, comments };
  };
  switch (io.subject.kind) {
    case "issue":
    case "pr":
      return { items: [await item(io.subject.number, io.subject.kind)] };
    case "batch": {
      const found = await api.searchIssues(io.subject.query);
      const items = [];
      for (const issue of found) items.push(await item(issue.number, "issue", issue.title, issue.body));
      return { items, batchNumbers: found.map((i) => i.number) };
    }
    default:
      return { items: [] };
  }
}

function loadState(io: AgentJobIO): State {
  return JSON.parse(readFileSync(files(io.workDir).state, "utf8")) as State;
}

function saveState(io: AgentJobIO, state: State): void {
  writeFileSync(files(io.workDir).state, JSON.stringify(state, null, 2));
}
