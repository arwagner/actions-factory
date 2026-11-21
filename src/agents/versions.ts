import { CLAUDE_CODE_VERSION } from "./claude.js";
import { CODEX_VERSION } from "./codex.js";
import { COPILOT_VERSION } from "./copilot.js";

/** Each adapter's pinned CLI version, which also keys the workflow's install cache. */
export const CLI_VERSIONS: Record<string, string> = {
  claude: CLAUDE_CODE_VERSION,
  codex: CODEX_VERSION,
  copilot: COPILOT_VERSION,
  fake: "none",
};
