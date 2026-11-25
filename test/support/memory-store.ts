import { emptyState, type PoolState, type PoolStore, type Snapshot } from "../../src/pool/pool.js";

/** An in-memory pool store with the same compare-and-swap rule as the branch. */
export class MemoryStore implements PoolStore {
  version: number | undefined;
  constructor(public state: PoolState = emptyState()) {
    this.version = 0;
  }
  async read(): Promise<Snapshot> {
    return { state: structuredClone(this.state), token: String(this.version) };
  }
  async write(state: PoolState, expected: string | undefined) {
    if (expected !== String(this.version)) return false;
    this.state = structuredClone(state);
    this.version = (this.version ?? 0) + 1;
    return true;
  }
}
