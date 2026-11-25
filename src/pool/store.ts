import { emptyState, STATE_BRANCH, STATE_FILE, type PoolState, type PoolStore, type Snapshot } from "./pool.js";

/**
 * The pool's state on the `factory-auth-state` branch of `owner/repo`, through the Git data API with
 * `FACTORY_TOKEN` (Contents write). Each write is a commit whose only parent is the commit that was read,
 * pushed without force: GitHub refuses it if the branch has moved, and that is the conflict signal.
 */
export function gitHubPoolStore(token: string, owner: string, repo: string, baseUrl = "https://api.github.com"): PoolStore {
  const call = async (method: string, path: string, body?: unknown, okStatuses: number[] = []) => {
    const response = await fetch(`${baseUrl}/repos/${owner}/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "actions-factory",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok && !okStatuses.includes(response.status)) {
      throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return { status: response.status, json: response.ok ? ((await response.json()) as unknown) : undefined };
  };

  return {
    async read(): Promise<Snapshot> {
      const ref = await call("GET", `/git/ref/heads/${STATE_BRANCH}`, undefined, [404]);
      if (ref.status === 404) return { state: emptyState(), token: undefined };
      const head = (ref.json as { object: { sha: string } }).object.sha;
      // Read at the commit, not the branch, so the token names exactly the state we saw.
      const file = await call("GET", `/contents/${STATE_FILE}?ref=${head}`, undefined, [404]);
      if (file.status === 404) return { state: emptyState(), token: head };
      const content = (file.json as { content: string }).content;
      return { state: JSON.parse(Buffer.from(content, "base64").toString("utf8")) as PoolState, token: head };
    },
    async write(state, expected) {
      const blob = (await call("POST", "/git/blobs", { content: `${JSON.stringify(state, null, 2)}\n`, encoding: "utf-8" })).json as { sha: string };
      const tree = (await call("POST", "/git/trees", { tree: [{ path: STATE_FILE, mode: "100644", type: "blob", sha: blob.sha }] })).json as { sha: string };
      const commit = (
        await call("POST", "/git/commits", {
          message: "factory: update auth pool state",
          tree: tree.sha,
          parents: expected ? [expected] : [],
        })
      ).json as { sha: string };
      // 422 is "not a fast-forward" / "already exists": somebody else got there first.
      const result =
        expected === undefined
          ? await call("POST", "/git/refs", { ref: `refs/heads/${STATE_BRANCH}`, sha: commit.sha }, [422])
          : await call("PATCH", `/git/refs/heads/${STATE_BRANCH}`, { sha: commit.sha, force: false }, [422]);
      return result.status !== 422;
    },
  };
}
