import { afterEach, describe, expect, it, vi } from "vitest";
import { gitHubApi } from "../src/router/github.js";

/** Stubs fetch with a PR (mergeable, state) and its head's check runs, or a 403 for them. */
function serve(pull: { mergeable: boolean | null; mergeable_state: string }, checkRuns: object[] | 403) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("/check-runs")) {
      return checkRuns === 403
        ? new Response('{"message":"Resource not accessible"}', { status: 403 })
        : Response.json({ check_runs: checkRuns });
    }
    return Response.json({ head: { ref: "agent/x", sha: "abc", repo: { full_name: "o/r" } }, base: { sha: "def", repo: { full_name: "o/r" } }, ...pull });
  });
}

const OWN = "https://github.com/o/r/actions/runs/77/job/1";
const OTHER = "https://github.com/o/r/actions/runs/55/job/2";
const pull = (ownRunId?: string) => gitHubApi("t", "o", "r").getPull(7, ownRunId);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getPull, for the merge write", () => {
  it("doesn't wait on the merging run's own check run, which also makes GitHub call the PR unstable", async () => {
    serve({ mergeable: true, mergeable_state: "unstable" }, [
      { status: "in_progress", conclusion: null, details_url: OWN },
      { status: "completed", conclusion: "success", details_url: OTHER },
    ]);

    expect(await pull("77")).toEqual({ head: "agent/x", mergeable: true, pending: false });
  });

  it("waits while any other check run is going, and won't merge past one that failed", async () => {
    serve({ mergeable: true, mergeable_state: "unstable" }, [{ status: "queued", conclusion: null, details_url: OTHER }]);
    expect(await pull("77")).toMatchObject({ mergeable: false, pending: true });

    serve({ mergeable: true, mergeable_state: "unstable" }, [{ status: "completed", conclusion: "failure", details_url: OTHER }]);
    expect(await pull("77")).toMatchObject({ mergeable: false, pending: false });
  });

  it("without the Checks permission, waits while GitHub says required checks block the merge", async () => {
    serve({ mergeable: true, mergeable_state: "blocked" }, 403);
    expect(await pull("77")).toMatchObject({ mergeable: false, pending: true });

    serve({ mergeable: true, mergeable_state: "clean" }, 403);
    expect(await pull("77")).toMatchObject({ mergeable: true, pending: false });
  });

  it("waits while GitHub is still working out mergeability", async () => {
    serve({ mergeable: null, mergeable_state: "unknown" }, []);
    expect(await pull()).toMatchObject({ mergeable: false, pending: true });
  });
});
