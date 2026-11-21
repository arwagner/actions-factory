/** A parsed five-field cron: the allowed values of each field, and whether day-of-month and day-of-week were restricted. */
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, offset: 0 },
] as const;

/** Parses a five-field cron as GitHub's `schedule` accepts it: `*`, numbers, names, ranges, steps and lists. Throws on anything else. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron needs five fields, not ${parts.length}: ${expression}`);
  const sets = parts.map((part, i) => parseField(part, FIELDS[i]));
  const dayOfWeek = new Set([...sets[4]].map((d) => d % 7));
  return {
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek,
    domRestricted: !parts[2].startsWith("*"),
    dowRestricted: !parts[4].startsWith("*"),
  };
}

function parseField(part: string, field: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  const value = (text: string): number => {
    const lower = text.toLowerCase();
    const named = "names" in field ? (field.names as readonly string[]).indexOf(lower) + field.offset : -1;
    const n = named >= field.min ? named : /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!(n >= field.min && n <= field.max)) throw new Error(`${text} isn't a valid ${field.name}`);
    return n;
  };
  for (const item of part.split(",")) {
    const [range, stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${item} has a bad step`);
    let [from, to] = [field.min as number, field.max as number];
    if (range !== "*") {
      const [a, b] = range.split("-");
      from = value(a);
      to = b === undefined ? (stepText === undefined ? from : field.max) : value(b);
      if (to < from) throw new Error(`${range} runs backwards`);
    }
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return values;
}

/** Whether `cron` fires at this local wall-clock minute. Day-of-month and day-of-week combine with OR when both are restricted. */
function matches(cron: Cron, t: { minute: number; hour: number; day: number; month: number; weekday: number }): boolean {
  if (!cron.minute.has(t.minute) || !cron.hour.has(t.hour) || !cron.month.has(t.month)) return false;
  const dom = cron.dayOfMonth.has(t.day);
  const dow = cron.dayOfWeek.has(t.weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

const MINUTE = 60_000;
/** How far back a missed slot is looked for. Older slots are ignored. */
export const LOOKBACK_MS = 31 * 24 * 60 * MINUTE;

/**
 * The latest minute in (`after`, `upTo`] at which `cron` fires in `timeZone`, or undefined. Looks back at most
 * 31 days, so a long-idle repo runs a task once for its latest slot, not once per slot.
 */
export function latestSlot(cron: Cron, timeZone: string, after: Date, upTo: Date): Date | undefined {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const floor = Math.max(after.getTime(), upTo.getTime() - LOOKBACK_MS);
  for (let t = Math.floor(upTo.getTime() / MINUTE) * MINUTE; t > floor; t -= MINUTE) {
    const p = Object.fromEntries(format.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const local = {
      minute: Number(p.minute),
      hour: Number(p.hour),
      day: Number(p.day),
      month: Number(p.month),
      weekday: DAYS.indexOf(p.weekday.toLowerCase()),
    };
    if (matches(cron, local)) return new Date(t);
  }
  return undefined;
}
