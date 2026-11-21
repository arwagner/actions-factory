import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { fakeAdapter } from "./fake.js";
import type { Adapter } from "./types.js";

/** Every adapter this release ships, by `agent:` name. */
export const ADAPTERS: Record<string, Adapter> = { claude: claudeAdapter(), codex: codexAdapter(), copilot: copilotAdapter(), fake: fakeAdapter };

export type { Adapter, AdapterInput, AdapterOutput } from "./types.js";
