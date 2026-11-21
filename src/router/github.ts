/** A label as the factory manages it. Colours are six hex digits, no `#`. */
export interface Label {
  name: string;
  color: string;
  description: string;
}

/** The few GitHub calls the router makes, on one repo, with one token. */
export interface GitHubApi {
  /** `admin`, `write`, `read` or `none`. GitHub counts maintain as write and triage as read. */
  permission(user: string): Promise<string>;
  listLabels(): Promise<Label[]>;
  createLabel(label: Label): Promise<void>;
  updateLabel(label: Label): Promise<void>;
  removeLabel(issueNumber: number, name: string): Promise<void>;
  comment(issueNumber: number, body: string): Promise<void>;
}

/** A fetch-based client for `owner/repo`. */
export function gitHubApi(token: string, owner: string, repo: string, baseUrl = "https://api.github.com"): GitHubApi {
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
    return response.status === 204 || !response.ok ? undefined : response.json();
  };
  const enc = encodeURIComponent;
  return {
    async permission(user) {
      const result = (await call("GET", `/collaborators/${enc(user)}/permission`, undefined, [404])) as
        | { permission: string }
        | undefined;
      return result?.permission ?? "none";
    },
    async listLabels() {
      const labels: Label[] = [];
      for (let page = 1; ; page++) {
        const batch = (await call("GET", `/labels?per_page=100&page=${page}`)) as Label[];
        labels.push(...batch.map(({ name, color, description }) => ({ name, color, description: description ?? "" })));
        if (batch.length < 100) return labels;
      }
    },
    async createLabel(label) {
      await call("POST", "/labels", label);
    },
    async updateLabel(label) {
      await call("PATCH", `/labels/${enc(label.name)}`, { color: label.color, description: label.description });
    },
    async removeLabel(issueNumber, name) {
      await call("DELETE", `/issues/${issueNumber}/labels/${enc(name)}`, undefined, [404]);
    },
    async comment(issueNumber, body) {
      await call("POST", `/issues/${issueNumber}/comments`, { body });
    },
  };
}
