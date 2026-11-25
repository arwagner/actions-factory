import type { Owner, RunEnded } from "./pool.js";

/** The GitHub calls the pool command makes on one repo, with `CODEX_POOL_TOKEN`. */
export interface PoolGitHub {
  /** Whether the repo exists and the token can see it. */
  repoExists(): Promise<boolean>;
  /** The environment's deployment-branch rule, or undefined if there is no such environment. */
  environment(name: string): Promise<{ selectedBranches: boolean } | undefined>;
  /** The environment's secret-encryption key. */
  environmentKey(name: string): Promise<{ keyId: string; key: string }>;
  putEnvironmentSecret(name: string, secret: string, encrypted: { keyId: string; value: string }): Promise<void>;
  /** The transport private key is stored separately from the login environment. */
  repositoryKey(): Promise<{ keyId: string; key: string }>;
  hasRepositorySecret(name: string): Promise<boolean>;
  putRepositorySecret(name: string, encrypted: { keyId: string; value: string }): Promise<void>;
  /** A repository variable's value, or undefined if it isn't set. */
  getVariable(name: string): Promise<string | undefined>;
  setVariable(name: string, value: string): Promise<void>;
  /** Whether a workflow run attempt has completed. Throws if GitHub can't say. */
  runEnded: RunEnded;
}

export function poolGitHub(token: string, owner: string, repo: string, baseUrl = "https://api.github.com"): PoolGitHub {
  const call = async (method: string, path: string, body?: unknown, okStatuses: number[] = []) => {
    const response = await fetch(`${baseUrl}${path}`, {
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
    const text = response.ok ? await response.text() : "";
    return { status: response.status, json: text ? (JSON.parse(text) as unknown) : undefined };
  };
  const repoPath = `/repos/${owner}/${repo}`;
  const env = (name: string) => `${repoPath}/environments/${encodeURIComponent(name)}`;

  return {
    async repoExists() {
      return (await call("GET", repoPath, undefined, [404])).status !== 404;
    },
    async environment(name) {
      const found = await call("GET", env(name), undefined, [404]);
      if (found.status === 404) return undefined;
      const policy = (found.json as { deployment_branch_policy?: { custom_branch_policies?: boolean } | null }).deployment_branch_policy;
      return { selectedBranches: policy?.custom_branch_policies === true };
    },
    async environmentKey(name) {
      const key = (await call("GET", `${env(name)}/secrets/public-key`)).json as { key_id: string; key: string };
      return { keyId: key.key_id, key: key.key };
    },
    async putEnvironmentSecret(name, secret, encrypted) {
      await call("PUT", `${env(name)}/secrets/${encodeURIComponent(secret)}`, { encrypted_value: encrypted.value, key_id: encrypted.keyId });
    },
    async repositoryKey() {
      const key = (await call("GET", `${repoPath}/actions/secrets/public-key`)).json as { key_id: string; key: string };
      return { keyId: key.key_id, key: key.key };
    },
    async hasRepositorySecret(name) {
      return (await call("GET", `${repoPath}/actions/secrets/${encodeURIComponent(name)}`, undefined, [404])).status === 200;
    },
    async putRepositorySecret(name, secret) {
      await call("PUT", `${repoPath}/actions/secrets/${encodeURIComponent(name)}`, { encrypted_value: secret.value, key_id: secret.keyId });
    },
    async getVariable(name) {
      const found = await call("GET", `${repoPath}/actions/variables/${encodeURIComponent(name)}`, undefined, [404]);
      return found.status === 404 ? undefined : (found.json as { value: string }).value;
    },
    async setVariable(name, value) {
      const created = await call("POST", `${repoPath}/actions/variables`, { name, value }, [409, 422]);
      if (created.status === 409 || created.status === 422) {
        await call("PATCH", `${repoPath}/actions/variables/${encodeURIComponent(name)}`, { name, value });
      }
    },
    async runEnded(run: Owner) {
      const { json } = await call("GET", `${repoPath}/actions/runs/${run.runId}/attempts/${run.attempt}`);
      return (json as { status: string }).status === "completed";
    },
  };
}
