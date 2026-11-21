/** What the factory hands an adapter for one turn. */
export interface AdapterInput {
  /** The client checkout the agent works in. */
  checkout: string;
  /** The full prompt: the template prompt, every layer's instructions, the subject and the plan contract. */
  promptFile: string;
  /** Skill name → folder, to install where the CLI looks. */
  skills: Record<string, string>;
  /** The JSON schema `plan.json` must match. */
  planSchemaFile: string;
  /** Where the agent must write `plan.json`. */
  planFile: string;
  permission: "read-only" | "edit-workspace";
  model?: string;
  timeoutMinutes: number;
  /** Where to write the NDJSON transcript. */
  transcriptFile: string;
  /** 1 for the first round; later rounds come after failed checks. */
  turn: number;
  /** The task's name, for adapters that key behaviour on it (the fake adapter). */
  task: string;
}

export interface AdapterOutput {
  status: "ok" | "failed" | "timed-out";
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/** One agent CLI. Adapters never see a GitHub token. */
export interface Adapter {
  name: string;
  /** The secrets this adapter reads, by name. The agent step gets only these. */
  credentials: string[];
  run(input: AdapterInput): Promise<AdapterOutput>;
  /** The doctor's check that the credential works: one tiny prompt. `detail` never holds a secret. */
  ping(): Promise<{ ok: boolean; detail: string }>;
}
