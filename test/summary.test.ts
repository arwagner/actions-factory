import { describe, expect, it } from "vitest";
import { renderApplySummary } from "../src/runner/summary.js";

const runUrl = "https://github.com/acme/app/actions/runs/9";

describe("renderApplySummary", () => {
  it("shows the outcome, every write, rounds, checks with times, tokens and cost, and the transcript", () => {
    const text = renderApplySummary({
      taskName: "implement",
      runUrl,
      result: { ok: true, outcome: "done", writes: ["pushed `agent/issue-4-9`", "opened draft PR #7 from `agent/issue-4-9`"] },
      meta: {
        agentStatus: "ok",
        checksPassed: true,
        turnsRun: 2,
        agentSeconds: 252,
        checks: [{ command: "npm test", ok: true, seconds: 63 }],
        usage: { inputTokens: 12345, outputTokens: 678, costUsd: 0.4213 },
        transcript: true,
      },
    });

    expect(text).toBe(
      [
        "### actions-factory: `implement` → **done**",
        "",
        "| | |",
        "|---|---|",
        "| Agent | ok · 2 rounds · 4m 12s |",
        "| Checks (last round) | ✅ `npm test` 1m 3s |",
        "| Tokens | 12,345 in · 678 out · $0.42 |",
        "| Transcript | `transcript.ndjson` in the [factory-handoff artifact](https://github.com/acme/app/actions/runs/9#artifacts) |",
        "",
        "**Writes**",
        "",
        "- pushed `agent/issue-4-9`",
        "- opened draft PR #7 from `agent/issue-4-9`",
        "",
      ].join("\n"),
    );
  });

  it("gives the reason a run stopped, and says what wasn't reported or kept", () => {
    const text = renderApplySummary({
      taskName: "review",
      runUrl,
      result: { ok: false, reason: "the agent timed out.", writes: ["added `agent:blocked` to #7"] },
      meta: { agentStatus: "timed-out", checksPassed: true, turnsRun: 1 },
    });

    expect(text).toContain("### actions-factory: `review` stopped\n\nthe agent timed out.");
    expect(text).toContain("| Agent | timed-out · 1 round |");
    expect(text).toContain("| Checks | didn't run |");
    expect(text).toContain("| Tokens | not reported |");
    expect(text).toContain("| Transcript | not kept");
    expect(text).toContain("- added `agent:blocked` to #7");
  });
});
