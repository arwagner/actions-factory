/** What one run of a task is about. */
export type Subject =
  | { kind: "issue" | "pr"; number: number }
  | { kind: "batch"; query: string; origin?: number }
  | { kind: "repo"; origin?: number };

export type Decision = (
  | { kind: "run"; task: string; label: string; subject: Subject; actor: string }
  | { kind: "ignore"; reason: string }
  | { kind: "refuse"; code: RefusalCode; message: string; subject?: Subject }
  | { kind: "command"; command: Command }
  | { kind: "defer"; reason: string; subject: Subject }
  | { kind: "sweep" }
) & { warnings: string[] };

export type RefusalCode =
  | "fork"
  | "missing-token"
  | "stale-stub"
  | "bad-config"
  | "wrong-subject"
  | "unknown-command"
  | "not-writer"
  | "loop-brake";

export const COMMANDS = ["doctor", "show-config"] as const;
export type Command = (typeof COMMANDS)[number];

const GETTING_STARTED = "https://github.com/arwagner/actions-factory/wiki/Getting-started";

interface TaskConfig {
  label?: string;
  subject: string;
  query?: string;
  schedule?: { cron: string; subject?: number };
}

export interface RouteInput {
  /** `GITHUB_EVENT_NAME` and the event payload. */
  event: { name: string; payload: Record<string, unknown> };
  /** The result of loading the merged config. */
  config: { ok: boolean; errors: unknown[]; config: Record<string, unknown> };
  context: {
    hasFactoryToken: boolean;
    /** The version the stub declares, or undefined if it declares none. */
    stubVersion?: string;
    factoryVersion: string;
    minStubVersion: string;
  };
}

/** Decides what the router does with one event: at most one task, a command, a sweep, an ignore or a refusal. */
export function route(input: RouteInput): Decision {
  const warnings = stubWarnings(input.context);
  switch (input.event.name) {
    case "issues":
    case "pull_request_target":
      return routeLabel(input, warnings);
    case "workflow_dispatch": {
      const command = String((input.event.payload.inputs as { command?: string } | undefined)?.command ?? "");
      if ((COMMANDS as readonly string[]).includes(command)) return { kind: "command", command: command as Command, warnings };
      const message = `Unknown command ${command || "(none)"}. Use ${COMMANDS.join(" or ")}.`;
      return { kind: "refuse", code: "unknown-command", message, warnings };
    }
    case "schedule": {
      const blocked = blockingRefusal(input);
      return blocked ? { kind: "refuse", ...blocked, warnings } : { kind: "sweep", warnings };
    }
    case "repository_dispatch":
      return routeScheduled(input, warnings);
    default:
      return { kind: "ignore", reason: `${input.event.name} events start nothing`, warnings };
  }
}

function routeLabel(input: RouteInput, warnings: string[]): Decision {
  const payload = input.event.payload as unknown as LabeledPayload;
  const label = payload.label?.name ?? "";
  const refuse = (code: RefusalCode, message: string, subject?: Subject): Decision =>
    ({ kind: "refuse", code, message, subject, warnings });

  if (payload.action !== "labeled") return { kind: "ignore", reason: `${payload.action} events start nothing`, warnings };
  if (!label.startsWith("agent:")) return { kind: "ignore", reason: `${label} isn't a factory label`, warnings };
  const item: Subject & { number: number } = payload.pull_request
    ? { kind: "pr", number: payload.pull_request.number }
    : { kind: "issue", number: payload.issue!.number };

  if (payload.pull_request && isFork(payload.pull_request)) {
    return refuse("fork", "The factory doesn't run on pull requests from forks.", item);
  }
  const blocked = blockingRefusal(input);
  if (blocked) return refuse(blocked.code, blocked.message, item);

  const tasks = (input.config.config.tasks ?? {}) as Record<string, TaskConfig>;
  const match = Object.entries(tasks).find(([, t]) => t.label === label);
  if (!match) return { kind: "ignore", reason: `no task uses the label ${label}`, warnings };
  const [name, task] = match;
  const subject = subjectFor(task, item);
  if (!subject) {
    const wants = task.subject === "pr" ? "pull requests" : "issues";
    const got = item.kind === "pr" ? "pull requests" : "issues";
    const message = `${label} works on ${wants}, not ${got}.`;
    return refuse("wrong-subject", message, item);
  }
  return { kind: "run", task: name, label, subject, actor: payload.sender.login, warnings };
}

/**
 * A `factory-run` dispatch the tick sent for a scheduled task. (The tick's sweep dispatches name a trigger label;
 * the router turns those into the label event they stand for before routing.) Other dispatch types are reserved.
 */
function routeScheduled(input: RouteInput, warnings: string[]): Decision {
  const payload = input.event.payload as { action?: string; client_payload?: { task?: string }; sender?: { login: string } };
  if (payload.action !== "factory-run") return { kind: "ignore", reason: `repository_dispatch ${payload.action} starts nothing`, warnings };
  const name = String(payload.client_payload?.task ?? "");
  const tasks = (input.config.config.tasks ?? {}) as Record<string, TaskConfig>;
  const task = input.config.ok ? tasks[name] : undefined;
  const origin = task?.schedule?.subject;
  const blocked = blockingRefusal(input);
  if (blocked) return { kind: "refuse", ...blocked, subject: origin ? { kind: "issue", number: origin } : undefined, warnings };
  if (!task?.schedule) return { kind: "ignore", reason: `no scheduled task is named ${name || "(none)"}`, warnings };
  const subject: Subject =
    task.subject === "issue" || task.subject === "pr"
      ? { kind: task.subject, number: origin! }
      : task.subject === "batch"
        ? { kind: "batch", query: task.query ?? "", origin }
        : { kind: "repo", origin };
  return { kind: "run", task: name, label: `schedule:${name}`, subject, actor: payload.sender?.login ?? "", warnings };
}

/** The refusals that stop any work, in the order they're checked: token, stub, then config. */
function blockingRefusal({ context, config }: RouteInput): { code: RefusalCode; message: string } | undefined {
  if (!context.hasFactoryToken) {
    const message = `The \`FACTORY_TOKEN\` secret isn't set, so the factory can't run. Set it up as described in ${GETTING_STARTED}.`;
    return { code: "missing-token", message };
  }
  if (context.stubVersion && major(context.stubVersion) < major(context.factoryVersion)) {
    const message =
      `This repo's stub is v${bare(context.stubVersion)}, from an older major than the factory ` +
      `(v${bare(context.factoryVersion)}). Copy the current stub from ${GETTING_STARTED}.`;
    return { code: "stale-stub", message };
  }
  if (!config.ok) {
    const lines = (config.errors as ConfigErrorLike[]).map(
      (e) => `- ${[e.path ? `\`${e.path}\`` : "", e.layer ? `(${e.layer})` : ""].filter(Boolean).join(" ")}: ${e.message}`,
    );
    return { code: "bad-config", message: ["The factory config doesn't validate:", ...lines].join("\n") };
  }
  return undefined;
}

function stubWarnings({ stubVersion, minStubVersion }: RouteInput["context"]): string[] {
  if (!stubVersion) return ["The stub declares no version. Copy the current stub from the wiki's Getting started page."];
  if (compare(stubVersion, minStubVersion) < 0) {
    return [
      `The stub is v${bare(stubVersion)}; v${bare(minStubVersion)} or newer is recommended. ` +
        "Copy the current stub from the wiki's Getting started page.",
    ];
  }
  return [];
}

/** A PR is from a fork when its head repo isn't its base repo, or is gone. `head.repo.fork` is unreliable (#28). */
function isFork(pr: NonNullable<LabeledPayload["pull_request"]>): boolean {
  return pr.head.repo?.full_name !== pr.base.repo.full_name;
}

function bare(version: string): string {
  return version.replace(/^v/, "");
}

function parts(version: string): number[] {
  return bare(version).split(".").map((n) => Number.parseInt(n, 10) || 0);
}

function major(version: string): number {
  return parts(version)[0];
}

function compare(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

interface ConfigErrorLike {
  path: string;
  layer?: string;
  message: string;
}

/** The run's subject for a label on `item`, or undefined if the task doesn't work on that kind of item. */
function subjectFor(task: TaskConfig, item: Subject & { number: number }): Subject | undefined {
  switch (task.subject) {
    case "issue":
    case "pr":
      return task.subject === item.kind ? item : undefined;
    case "batch":
      return item.kind === "issue" ? { kind: "batch", query: task.query ?? "", origin: item.number } : undefined;
    default:
      return { kind: "repo", origin: item.number };
  }
}

interface LabeledPayload {
  action?: string;
  label?: { name: string };
  issue?: { number: number };
  pull_request?: { number: number; head: { repo: { full_name: string } | null }; base: { repo: { full_name: string } } };
  sender: { login: string };
}
