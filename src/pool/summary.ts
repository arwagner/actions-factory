import { appendFileSync } from "node:fs";

/** Render only known pool states and validated aliases, never a server error or a credential. */
export type PoolNotice = { kind: "quarantined"; alias: string } | { kind: "exhausted" };

export function poolAlias(alias: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias) ? alias : "(unrecognized login alias)";
}

export function renderPoolNotice(notice: PoolNotice): string {
  return notice.kind === "quarantined"
    ? `- Codex pool: login \`${poolAlias(notice.alias)}\` was quarantined.\n`
    : "- Codex pool exhausted. Check the pool for leased or quarantined logins.\n";
}

export function addPoolNotice(notice: PoolNotice): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, renderPoolNotice(notice));
}
