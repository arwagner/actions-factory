import { parseCron } from "../router/cron.js";
import type { ConfigError } from "./validate.js";

interface Task {
  label?: string;
  subject: string;
  branch?: string;
  query?: string;
  schedule?: { cron: string; subject?: number };
  writes: { merge: boolean; labels: string[] };
  outcomes: Record<string, { addLabels: string[] }>;
}

const MERGE_LABEL = "agent:merge";
const MERGE_BY_PERSON = `${MERGE_LABEL} is added only by a person`;

/** The parts of a schema-valid config, defaults filled in, that the hard rules read. */
export interface SchemaValidConfig {
  timezone: string;
  tasks?: Record<string, Task>;
}

/**
 * The §5 hard rules that no layer can switch off. Runs on a config that
 * already matches the schema, with defaults filled in.
 */
export function checkHardRules(config: SchemaValidConfig): ConfigError[] {
  const errors: ConfigError[] = [];
  if (!isTimeZone(config.timezone)) {
    errors.push({ path: "timezone", message: `unknown IANA time zone ${JSON.stringify(config.timezone)}` });
  }
  for (const [name, task] of Object.entries(config.tasks ?? {})) {
    const at = (field: string) => `tasks.${name}.${field}`;
    if (!task.label && !task.schedule) {
      errors.push({ path: `tasks.${name}`, message: "needs a label or a schedule to ever run" });
    }
    if (task.schedule) {
      try {
        parseCron(task.schedule.cron);
      } catch (error) {
        errors.push({ path: at("schedule.cron"), message: (error as Error).message });
      }
      if ((task.subject === "issue" || task.subject === "pr") && task.schedule.subject === undefined) {
        errors.push({ path: at("schedule.subject"), message: `a scheduled ${task.subject} task needs the number of the ${task.subject === "pr" ? "pull request" : "issue"} it's about` });
      }
    }
    if (task.branch === "subject" && task.subject !== "issue") {
      errors.push({ path: at("branch"), message: "`subject` branches are for issue tasks; a PR task always works on the PR's own branch" });
    }
    if (task.query !== undefined && task.subject !== "batch") {
      errors.push({ path: at("query"), message: "allowed only with subject: batch" });
    }
    if (task.writes.merge && (!task.label || task.schedule)) {
      errors.push({
        path: at("writes.merge"),
        message: "merge is allowed only on a task triggered by a label alone, which a person adds",
      });
    }
    for (const [outcome, { addLabels }] of Object.entries(task.outcomes)) {
      if (addLabels.includes(MERGE_LABEL)) {
        errors.push({ path: at(`outcomes.${outcome}.addLabels`), message: MERGE_BY_PERSON });
      }
    }
    if (task.writes.labels.includes(MERGE_LABEL)) {
      errors.push({ path: at("writes.labels"), message: MERGE_BY_PERSON });
    }
  }
  return errors;
}

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
