import { fakeAdapter } from "./fake.js";
import type { Adapter } from "./types.js";

/** Every adapter this release ships, by `agent:` name. */
export const ADAPTERS: Record<string, Adapter> = { fake: fakeAdapter };

export type { Adapter, AdapterInput, AdapterOutput } from "./types.js";
