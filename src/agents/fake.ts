import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter } from "./types.js";

/**
 * Tests only, undocumented for clients. Plays back a ready-made script from the client checkout,
 * `.factory/fake/<task>.json`: `{ "plan": {...}, "files": { "path": "content" } }`, with no LLM call.
 * A script per turn can be given as `<task>.turn<N>.json`.
 */
export const fakeAdapter: Adapter = {
  name: "fake",
  credentials: [],
  async ping() {
    return { ok: true, detail: "the fake agent needs no credential" };
  },
  async run(input) {
    const dir = join(input.checkout, ".factory/fake");
    const perTurn = join(dir, `${input.task}.turn${input.turn}.json`);
    const file = existsSync(perTurn) ? perTurn : join(dir, `${input.task}.json`);
    if (!existsSync(file)) {
      writeFileSync(input.transcriptFile, `${JSON.stringify({ type: "error", message: `no fake script at ${file}` })}\n`);
      return { status: "failed" };
    }
    const script = JSON.parse(readFileSync(file, "utf8")) as { plan: unknown; files?: Record<string, string> };
    for (const [path, content] of Object.entries(script.files ?? {})) {
      if (input.permission === "read-only") break;
      mkdirSync(dirname(join(input.checkout, path)), { recursive: true });
      writeFileSync(join(input.checkout, path), content);
    }
    writeFileSync(input.planFile, JSON.stringify(script.plan, null, 2));
    writeFileSync(input.transcriptFile, `${JSON.stringify({ type: "fake", script: file, turn: input.turn })}\n`);
    return { status: "ok", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  },
};
