import { describe, expect, it, vi } from "vitest";
import { poolDoctorChecks } from "../src/pool/doctor.js";
import type { Snapshot } from "../src/pool/pool.js";

const snapshot: Snapshot = {
  token: "state-head",
  state: {
    version: 1,
    accounts: {
      available: { sessionId: "slot-01", hash: "hidden-hash" },
      busy: { sessionId: "slot-02", hash: "hidden-hash", lease: { runId: "123", attempt: 2 } },
      parked: { sessionId: "slot-03", hash: "hidden-hash", quarantine: { reason: "private diagnostic" } },
    },
  },
};

function io() {
  return {
    store: { read: vi.fn(async (): Promise<Snapshot> => snapshot) },
    github: {
      environment: vi.fn(async (): Promise<{ selectedBranches: boolean } | undefined> => ({ selectedBranches: true })),
      hasBranchRule: vi.fn(async () => true),
    },
    writer: { probeEnvironmentSecretWrite: vi.fn(async () => 422) },
    configured: false,
  };
}

describe("pool doctor", () => {
  it("reports status without reading any login or echoing hashes or quarantine reasons", async () => {
    const deps = io();
    const checks = await poolDoctorChecks(deps);
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Codex pool: save-back token", ok: true }),
      expect.objectContaining({ name: expect.stringContaining("available"), ok: true, detail: "free" }),
      expect.objectContaining({ name: expect.stringContaining("busy"), ok: true, detail: "leased by run 123 attempt 2" }),
      expect.objectContaining({ name: expect.stringContaining("parked"), ok: false, detail: "quarantined", fix: expect.any(String) }),
    ]));
    expect(JSON.stringify(checks)).not.toMatch(/hidden-hash|private diagnostic/);
    expect(deps.writer.probeEnvironmentSecretWrite).toHaveBeenCalledWith("codex-pool");
  });

  it("shows fixes when a configured pool lacks the environment, token and state branch", async () => {
    const deps = io();
    deps.github.environment.mockResolvedValue(undefined);
    deps.store.read.mockResolvedValue({ token: undefined, state: { version: 1, accounts: {} } });
    const checks = await poolDoctorChecks({ ...deps, writer: undefined, configured: true });
    expect(checks?.filter((check) => !check.ok).map(({ name }) => name)).toEqual([
      "Codex pool: environment", "Codex pool: state branch", "Codex pool: save-back token",
    ]);
    expect(checks?.filter((check) => !check.ok).every((check) => check.fix)).toBe(true);
    expect(await poolDoctorChecks({ ...deps, writer: undefined })).toBeUndefined();
  });

  it("rejects selected-branch mode without a branch rule and a token denied by GitHub", async () => {
    const deps = io();
    deps.github.hasBranchRule.mockResolvedValue(false);
    deps.writer.probeEnvironmentSecretWrite.mockResolvedValue(403);
    expect(await poolDoctorChecks(deps)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Codex pool: branch rules", ok: false, fix: expect.any(String) }),
      expect.objectContaining({ name: "Codex pool: save-back token", ok: false, detail: "GitHub answered 403", fix: expect.any(String) }),
    ]));
  });
});
