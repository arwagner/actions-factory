/**
 * What the agent job hands the apply job, as files in one artifact:
 * - `meta.json`: this interface;
 * - `plan.json`: the agent's plan, if it wrote one;
 * - `work.bundle`: a git bundle of `factory-work`, if the agent changed anything.
 */
export interface HandoffMeta {
  agentStatus: "ok" | "failed" | "timed-out";
  /** False when the last round's checks failed and the task sets `checksGate`. */
  checksPassed: boolean;
  /** For a batch subject: the issues the agent was given. */
  batchNumbers?: number[];
  /** Summed over every round, as far as the CLI reports it. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** How many agent rounds ran. */
  turnsRun?: number;
  /** Seconds the agent ran, over every round. */
  agentSeconds?: number;
  /** The last round's checks, in order, up to the first that failed. */
  checks?: Array<{ command: string; ok: boolean; seconds: number }>;
  /** Whether `transcript.ndjson` is in the artifact (private repos, §9). */
  transcript?: boolean;
}

export const HANDOFF_ARTIFACT = "factory-handoff";
