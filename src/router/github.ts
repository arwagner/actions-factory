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
  addLabels(issueNumber: number, names: string[]): Promise<void>;
  listComments(issueNumber: number): Promise<Array<{ id: number; body: string; author: string }>>;
  getIssue(issueNumber: number): Promise<{ title: string; body: string; isPullRequest: boolean; open: boolean; labels: string[] }>;
  /** Open issues and PRs carrying `label`, oldest first. */
  listOpenLabeled(label: string): Promise<Array<{ number: number; labels: string[] }>>;
  /** Who last added `label` to the item, from its events; undefined if no event says. */
  labeler(issueNumber: number, label: string): Promise<string | undefined>;
  /** Open issues matching a search query in this repo, oldest first. */
  searchIssues(query: string): Promise<Array<{ number: number; title: string; body: string }>>;
  updateComment(commentId: number, body: string): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  createIssue(issue: { title: string; body: string; labels?: string[] }): Promise<number>;
  defaultBranch(): Promise<string>;
  /**
   * Head branch name; whether GitHub can merge it now (mergeable, checks green); and whether that may still
   * change (mergeability being computed, or check runs on the head not finished).
   */
  getPull(number: number): Promise<{ head: string; mergeable: boolean; pending: boolean; headRepo: string | null; baseRepo: string }>;
  createPull(pull: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<number>;
  /** Merges with a merge commit. Throws if GitHub refuses. */
  mergePull(number: number): Promise<void>;
  /** Workflow runs created at or after `since` (ISO time), newest first. */
  listRunsSince(since: string): Promise<Array<{ id: number; title: string; status: string; conclusion: string | null }>>;
  /** The stub's recent schedule ticks (runs titled `factory · tick`), newest first. */
  listTicks(): Promise<Array<{ id: number; createdAt: string; conclusion: string | null }>>;
  /** Sends a `repository_dispatch`. Needs `FACTORY_TOKEN`: one sent with the default token starts no workflow. */
  dispatch(eventType: string, payload: Record<string, unknown>): Promise<void>;
  addAssignees(issueNumber: number, logins: string[]): Promise<void>;
  removeAssignees(issueNumber: number, logins: string[]): Promise<void>;
  requestReviewers(pullNumber: number, logins: string[]): Promise<void>;
  /**
   * What this token may do, without writing: reads the repo, then sends a branch, an issue and a PR that GitHub
   * rejects. GitHub checks permission before input, so each write answers 403 without it and 422 with it.
   */
  probeAccess(): Promise<{ read: number; contents: number; issues: number; pullRequests: number }>;
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
    async addLabels(issueNumber, names) {
      if (names.length > 0) await call("POST", `/issues/${issueNumber}/labels`, { labels: names });
    },
    async listComments(issueNumber) {
      const comments: Array<{ id: number; body: string; author: string }> = [];
      for (let page = 1; ; page++) {
        const batch = (await call("GET", `/issues/${issueNumber}/comments?per_page=100&page=${page}`)) as Array<{
          id: number;
          body: string;
          user: { login: string } | null;
        }>;
        comments.push(...batch.map(({ id, body, user }) => ({ id, body, author: user?.login ?? "ghost" })));
        if (batch.length < 100) return comments;
      }
    },
    async getIssue(issueNumber) {
      const issue = (await call("GET", `/issues/${issueNumber}`)) as {
        title: string;
        body: string | null;
        pull_request?: unknown;
        state: string;
        labels: Array<{ name: string }>;
      };
      return {
        title: issue.title,
        body: issue.body ?? "",
        isPullRequest: issue.pull_request !== undefined,
        open: issue.state === "open",
        labels: issue.labels.map((l) => l.name),
      };
    },
    async listOpenLabeled(label) {
      const items: Array<{ number: number; labels: string[] }> = [];
      for (let page = 1; page <= 10; page++) {
        const batch = (await call("GET", `/issues?state=open&labels=${enc(label)}&sort=created&direction=asc&per_page=100&page=${page}`)) as Array<{
          number: number;
          labels: Array<{ name: string }>;
        }>;
        items.push(...batch.map((i) => ({ number: i.number, labels: i.labels.map((l) => l.name) })));
        if (batch.length < 100) break;
      }
      return items;
    },
    async labeler(issueNumber, label) {
      let actor: string | undefined;
      for (let page = 1; page <= 10; page++) {
        const batch = (await call("GET", `/issues/${issueNumber}/events?per_page=100&page=${page}`)) as Array<{
          event: string;
          label?: { name: string };
          actor: { login: string } | null;
        }>;
        for (const e of batch) if (e.event === "labeled" && e.label?.name === label) actor = e.actor?.login;
        if (batch.length < 100) break;
      }
      return actor;
    },
    async searchIssues(query) {
      const q = encodeURIComponent(`repo:${owner}/${repo} is:issue is:open ${query}`);
      const result = (await fetch(`${baseUrl}/search/issues?q=${q}&sort=created&order=asc&per_page=100`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "actions-factory" },
      }).then((r) => r.json())) as { items: Array<{ number: number; title: string; body: string | null }> };
      return result.items.map(({ number, title, body }) => ({ number, title, body: body ?? "" }));
    },
    async updateComment(commentId, body) {
      await call("PATCH", `/issues/comments/${commentId}`, { body });
    },
    async closeIssue(issueNumber) {
      await call("PATCH", `/issues/${issueNumber}`, { state: "closed" });
    },
    async createIssue(issue) {
      return ((await call("POST", "/issues", issue)) as { number: number }).number;
    },
    async defaultBranch() {
      return ((await call("GET", "")) as { default_branch: string }).default_branch;
    },
    async getPull(number) {
      const pull = (await call("GET", `/pulls/${number}`)) as {
        head: { ref: string; sha: string; repo: { full_name: string } | null };
        base: { repo: { full_name: string } };
        mergeable: boolean | null;
        mergeable_state: string;
      };
      const checks = (await call("GET", `/commits/${pull.head.sha}/check-runs?per_page=100`)) as { check_runs: Array<{ status: string }> };
      const running = checks.check_runs.some((c) => c.status !== "completed");
      return {
        head: pull.head.ref,
        headRepo: pull.head.repo?.full_name ?? null,
        baseRepo: pull.base.repo.full_name,
        mergeable: pull.mergeable === true && pull.mergeable_state === "clean",
        pending: pull.mergeable === null || pull.mergeable_state === "unknown" || running,
      };
    },
    async createPull(pull) {
      return ((await call("POST", "/pulls", pull)) as { number: number }).number;
    },
    async mergePull(number) {
      await call("PUT", `/pulls/${number}/merge`, { merge_method: "merge" });
    },
    async listRunsSince(since) {
      const runs: Array<{ id: number; title: string; status: string; conclusion: string | null }> = [];
      for (let page = 1; page <= 10; page++) {
        const batch = (await call("GET", `/actions/runs?per_page=100&page=${page}&created=${enc(`>=${since}`)}`)) as {
          workflow_runs: Array<{ id: number; display_title: string; status: string; conclusion: string | null }>;
        };
        runs.push(...batch.workflow_runs.map((r) => ({ id: r.id, title: r.display_title, status: r.status, conclusion: r.conclusion })));
        if (batch.workflow_runs.length < 100) break;
      }
      return runs;
    },
    async listTicks() {
      const batch = (await call("GET", "/actions/runs?event=schedule&per_page=100")) as {
        workflow_runs: Array<{ id: number; display_title: string; created_at: string; conclusion: string | null }>;
      };
      return batch.workflow_runs
        .filter((r) => r.display_title === "factory · tick")
        .map((r) => ({ id: r.id, createdAt: r.created_at, conclusion: r.conclusion }));
    },
    async dispatch(eventType, payload) {
      await call("POST", "/dispatches", { event_type: eventType, client_payload: payload });
    },
    async addAssignees(issueNumber, logins) {
      await call("POST", `/issues/${issueNumber}/assignees`, { assignees: logins });
    },
    async removeAssignees(issueNumber, logins) {
      await call("DELETE", `/issues/${issueNumber}/assignees`, { assignees: logins });
    },
    async probeAccess() {
      const status = async (method: string, path: string, body?: unknown) => {
        try {
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
          return response.status;
        } catch {
          return 0;
        }
      };
      return {
        read: await status("GET", ""),
        contents: await status("POST", "/git/refs", { ref: "refs/heads/factory-doctor-probe", sha: "0".repeat(40) }),
        issues: await status("POST", "/issues", { title: "" }),
        pullRequests: await status("POST", "/pulls", { title: "factory doctor probe", head: "factory-doctor-no-such-branch", base: "factory-doctor-no-such-branch" }),
      };
    },
    async requestReviewers(pullNumber, logins) {
      await call("POST", `/pulls/${pullNumber}/requested_reviewers`, { reviewers: logins }, [422]);
    },
  };
}
