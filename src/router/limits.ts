/** At most this many factory runs per subject per day (§7). Not configurable. */
export const LOOP_BRAKE = 10;

export interface RunCounts {
  /** Factory task runs today, not counting this one. */
  today: number;
  /** Of those, the runs about this subject. */
  subjectToday: number;
}

/**
 * Counts today's factory task runs from the repo's run list: runs titled `factory · agent:… · #n` by the stub
 * that weren't skipped (other labels leave skipped runs).
 */
export function countRuns(
  runs: Array<{ id: number; title: string; conclusion: string | null }>,
  subject: number | undefined,
  currentRunId: number | undefined,
): RunCounts {
  const tasks = runs.filter((r) => r.id !== currentRunId && r.conclusion !== "skipped" && /^factory · agent:/.test(r.title));
  const subjectToday = subject === undefined ? 0 : tasks.filter((r) => r.title.endsWith(` · #${subject}`)).length;
  return { today: tasks.length, subjectToday };
}

/** Midnight today in `timeZone`, as an ISO instant. */
export function startOfDay(now: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset).toISOString();
}
