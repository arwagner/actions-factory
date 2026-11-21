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
}

export const HANDOFF_ARTIFACT = "factory-handoff";
