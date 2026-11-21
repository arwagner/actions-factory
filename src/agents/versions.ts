import { CLAUDE_CODE_VERSION } from "./claude.js";

/** Each adapter's pinned CLI version, which also keys the workflow's install cache. */
export const CLI_VERSIONS: Record<string, string> = {
  claude: CLAUDE_CODE_VERSION,
  fake: "none",
};
