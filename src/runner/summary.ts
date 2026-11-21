import type { ApplyResult } from "./apply.js";
import type { HandoffMeta } from "./handoff.js";

/**
 * The apply job's half of the run summary (§10): the outcome, every write, the agent's rounds and time, the
 * checks, tokens and cost, and the transcript. The route job's half names the subject, task, template, versions
 * and config.
 */
export function renderApplySummary(input: { taskName: string; result: ApplyResult; meta: HandoffMeta; runUrl: string }): string {
  const { taskName, result, meta, runUrl } = input;
  const lines = [
    result.ok ? `### actions-factory: \`${taskName}\` → **${result.outcome}**` : `### actions-factory: \`${taskName}\` stopped`,
    "",
  ];
  if (!result.ok) lines.push(result.reason, "");

  const rounds = meta.turnsRun ?? 0;
  const agent = [meta.agentStatus, `${rounds} round${rounds === 1 ? "" : "s"}`, ...(meta.agentSeconds === undefined ? [] : [duration(meta.agentSeconds)])];
  const checks =
    meta.checks === undefined
      ? "didn't run"
      : meta.checks.length === 0
        ? "none configured"
        : meta.checks.map((c) => `${c.ok ? "✅" : "❌"} \`${c.command}\` ${duration(c.seconds)}`).join("<br>");
  const transcript = meta.transcript
    ? `\`transcript.ndjson\` in the [factory-handoff artifact](${runUrl}#artifacts)`
    : "not kept (public repos keep none, §9)";
  lines.push(
    "| | |",
    "|---|---|",
    `| Agent | ${agent.join(" · ")} |`,
    `| Checks${rounds > 1 ? " (last round)" : ""} | ${checks} |`,
    `| Tokens | ${usage(meta.usage)} |`,
    `| Transcript | ${transcript} |`,
    "",
    "**Writes**",
    "",
    ...(result.writes.length > 0 ? result.writes.map((w) => `- ${w}`) : ["None."]),
    "",
  );
  return lines.join("\n");
}

function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}

function usage(u: HandoffMeta["usage"]): string {
  if (!u || (u.inputTokens === undefined && u.outputTokens === undefined && u.costUsd === undefined)) return "not reported";
  const parts = [];
  if (u.inputTokens !== undefined) parts.push(`${u.inputTokens.toLocaleString("en-US")} in`);
  if (u.outputTokens !== undefined) parts.push(`${u.outputTokens.toLocaleString("en-US")} out`);
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}
