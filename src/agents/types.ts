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
  /**
   * Codex ChatGPT-login mode: the path of one leased `auth.json`, handed in by the job. Used only when no
   * `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN` is set. Refreshed in place after the run.
   */
  authFile?: string;
}

export type FailureDetail =
  | "authentication failed (HTTP 401)"
  | "authentication failed"
  | "access denied (HTTP 403)"
  | "access denied"
  | "quota or rate limit"
  | "service unavailable"
  | "CLI reported an error"
  | `exit ${number}`;

export interface AdapterOutput {
  status: "ok" | "failed" | "timed-out";
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** A classification safe for run logs and public status comments, never CLI text. */
  detail?: FailureDetail;
  /** Why a failed run failed, when the adapter can tell: a bad login (quarantine it) or a quota/rate limit (try another). */
  failure?: "auth" | "quota";
  /** Leased-login mode: the refreshed `auth.json` was written back to the leased path; `changed` says whether it differs. */
  auth?: { path: string; changed: boolean };
}

/** One agent CLI. Adapters never see a GitHub token. */
export interface Adapter {
  name: string;
  /** The secrets this adapter reads, by name. The agent step gets only these. */
  credentials: string[];
  run(input: AdapterInput): Promise<AdapterOutput>;
  /** Installs the pinned CLI into the agent cache, for the tick's cache-warming job. Absent when there's no CLI. */
  install?(): Promise<void>;
  /** The doctor's check that the credential works: one tiny prompt. `detail` never holds a secret. */
  ping(): Promise<{ ok: boolean; detail: string }>;
}
