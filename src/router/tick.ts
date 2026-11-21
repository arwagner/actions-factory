import { latestSlot, parseCron } from "./cron.js";
import type { GitHubApi } from "./github.js";
import { countRuns, startOfDay } from "./limits.js";

/** The `repository_dispatch` type the tick sends to start one run. */
export const RUN_DISPATCH = "factory-run";
const TICK_MS = 15 * 60_000;
const BLOCKED = "agent:blocked";

interface TickConfig {
  timezone: string;
  throttles: { runsPerDay: number };
  tasks?: Record<string, { label?: string; schedule?: { cron: string; subject?: number } }>;
}

export interface TickInput {
  config: TickConfig;
  /** Holds the default token: runs, ticks and labeled items. */
  reader: GitHubApi;
  /** Holds `FACTORY_TOKEN`: a dispatch sent with the default token starts nothing. */
  writer: GitHubApi;
  now: Date;
  /** This tick's run id. */
  runId?: number;
}

/**
 * The 15-minute tick (§7). Starts each due scheduled task once, for its latest slot since the last handled tick,
 * then sweeps open items that still carry a trigger label, oldest first. Each run starts as a `factory-run`
 * dispatch, so it gets its own run, title and per-subject queue. Stays within `runsPerDay`. Returns one line
 * per run it started or held back, for the summary.
 */
export async function tick({ config, reader, writer, now, runId }: TickInput): Promise<string[]> {
  const lines: string[] = [];
  const runs = await reader.listRunsSince(startOfDay(now, config.timezone));
  let budget = config.throttles.runsPerDay - countRuns(runs, undefined, runId).today;
  // An item with a run still queued or going is handled by that run; its trigger label just hasn't come off yet.
  const busy = new Set(
    runs.filter((r) => r.id !== runId && r.status !== "completed").flatMap((r) => /· #(\d+)$/.exec(r.title)?.[1] ?? []).map(Number),
  );
  const start = async (payload: Record<string, unknown>, what: string) => {
    if (budget <= 0) {
      lines.push(`- ${what}: held back, the repo has reached \`throttles.runsPerDay\` (${config.throttles.runsPerDay})`);
      return;
    }
    budget--;
    await writer.dispatch(RUN_DISPATCH, payload);
    lines.push(`- ${what}: started`);
  };

  const tasks = Object.entries(config.tasks ?? {});
  const { after, upTo } = await window(reader, now, runId);
  for (const [name, task] of tasks) {
    if (!task.schedule) continue;
    const slot = latestSlot(parseCron(task.schedule.cron), config.timezone, after, upTo);
    if (!slot) continue;
    const number = task.schedule.subject;
    await start({ task: name, trigger: `schedule:${name}`, ...(number ? { number } : {}) }, `\`${name}\`, scheduled for ${slot.toISOString()}`);
  }

  const waiting: Array<{ number: number; task: string; label: string }> = [];
  for (const [name, task] of tasks) {
    if (!task.label) continue;
    for (const item of await reader.listOpenLabeled(task.label)) {
      if (!item.labels.includes(BLOCKED) && !busy.has(item.number)) waiting.push({ number: item.number, task: name, label: task.label });
    }
  }
  waiting.sort((a, b) => a.number - b.number);
  for (const w of waiting) await start({ task: w.task, trigger: w.label, number: w.number }, `\`${w.label}\` on #${w.number}`);
  return lines;
}

/**
 * The span this tick handles: from the last handled tick (a successful or still-running one) to this tick's
 * creation. Both ends come from run creation times, so neighbouring ticks never overlap or leave a gap.
 */
async function window(reader: GitHubApi, now: Date, runId: number | undefined): Promise<{ after: Date; upTo: Date }> {
  const ticks = await reader.listTicks();
  const self = ticks.find((t) => t.id === runId);
  const upTo = self ? new Date(self.createdAt) : now;
  const previous = ticks.find(
    (t) => t.id !== runId && new Date(t.createdAt) < upTo && (t.conclusion === null || t.conclusion === "success"),
  );
  return { after: previous ? new Date(previous.createdAt) : new Date(upTo.getTime() - TICK_MS), upTo };
}
