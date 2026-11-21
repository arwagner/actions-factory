import type { GitHubApi, Label } from "../../src/router/github.js";

/** An in-memory GitHub for one repo, recording every write and which token made it. */
export class FakeGitHub {
  labels: Label[] = [];
  permissions: Record<string, string> = {};
  comments: Record<number, Array<{ id: number; body: string; author?: string }>> = {};
  issues: Record<number, { title: string; body: string; open?: boolean; labels?: string[]; isPullRequest?: boolean }> = {};
  /** Who added a label, keyed `number:label`, as the issue events API reports it. */
  labelers: Record<string, string> = {};
  ticks: Array<{ id: number; createdAt: string; conclusion: string | null }> = [];
  /** What `probeAccess` reports, per token. Defaults to everything allowed. */
  access: Record<string, Partial<{ read: number; contents: number; issues: number; pullRequests: number }>> = {};
  search: Array<{ number: number; title: string; body: string }> = [];
  runs: Array<{ id: number; title: string; conclusion: string | null; status?: string }> = [];
  pulls: Record<number, { head: string; mergeable: boolean; pending?: boolean; headRepo?: string | null }> = {};
  /** Successive getPull answers for a PR, consumed in order, then `pulls` takes over. */
  pullSequence: Record<number, Array<{ head: string; mergeable: boolean; pending: boolean }>> = {};
  writes: Array<{ token: string; call: string; args: unknown }> = [];
  private nextId = 1000;

  api = (token: string): GitHubApi => {
    const record = (call: string, args: unknown) => this.writes.push({ token, call, args });
    return {
      permission: async (user) => this.permissions[user] ?? "none",
      listLabels: async () => structuredClone(this.labels),
      createLabel: async (label) => {
        record("createLabel", label);
        this.labels.push(label);
      },
      updateLabel: async (label) => {
        record("updateLabel", label);
        this.labels = this.labels.map((l) => (l.name === label.name ? label : l));
      },
      removeLabel: async (number, name) => {
        record("removeLabel", { number, name });
      },
      comment: async (number, body) => {
        record("comment", { number, body });
        (this.comments[number] ??= []).push({ id: this.nextId++, body });
      },
      addLabels: async (number, names) => {
        record("addLabels", { number, names });
      },
      listComments: async (number) =>
        structuredClone(this.comments[number] ?? []).map((c) => ({ ...c, author: c.author ?? "factory-bot" })),
      getIssue: async (number) => {
        const issue = this.issues[number] ?? { title: "", body: "" };
        return { title: issue.title, body: issue.body, isPullRequest: issue.isPullRequest ?? false, open: issue.open ?? true, labels: issue.labels ?? [] };
      },
      listOpenLabeled: async (label) =>
        Object.entries(this.issues)
          .filter(([, i]) => i.open !== false && i.labels?.includes(label))
          .map(([n, i]) => ({ number: Number(n), labels: [...(i.labels ?? [])] }))
          .sort((a, b) => a.number - b.number),
      labeler: async (number, label) => this.labelers[`${number}:${label}`],
      listTicks: async () => structuredClone(this.ticks),
      probeAccess: async () => ({ read: 200, contents: 422, issues: 422, pullRequests: 422, ...this.access[token] }),
      dispatch: async (eventType, payload) => {
        record("dispatch", { eventType, payload });
      },
      searchIssues: async () => structuredClone(this.search),
      updateComment: async (id, body) => {
        record("updateComment", { id, body });
        for (const list of Object.values(this.comments)) for (const c of list) if (c.id === id) c.body = body;
      },
      closeIssue: async (number) => {
        record("closeIssue", { number });
      },
      createIssue: async (issue) => {
        record("createIssue", issue);
        return this.nextId++;
      },
      defaultBranch: async () => "main",
      getPull: async (number) => {
        const next = this.pullSequence[number]?.shift();
        if (next) {
          this.pulls[number] = next;
          return next;
        }
        const pull = this.pulls[number] ?? { head: "feature", mergeable: false };
        return { pending: false, head: pull.head, mergeable: pull.mergeable, ...(pull.pending === undefined ? {} : { pending: pull.pending }) };
      },
      pullInfo: async (number) => {
        const pull = this.pulls[number] ?? { head: "feature", mergeable: false };
        return { head: pull.head, headSha: "headsha", baseSha: "basesha", headRepo: pull.headRepo === undefined ? "o/r" : pull.headRepo, baseRepo: "o/r" };
      },
      createPull: async (pull) => {
        record("createPull", pull);
        return 77;
      },
      listRunsSince: async () => this.runs.map((r) => ({ status: "completed", ...r })),
      addAssignees: async (number, logins) => {
        record("addAssignees", { number, logins });
      },
      removeAssignees: async (number, logins) => {
        record("removeAssignees", { number, logins });
      },
      requestReviewers: async (number, logins) => {
        record("requestReviewers", { number, logins });
      },
      mergePull: async (number) => {
        if (!this.pulls[number]?.mergeable) throw new Error("Pull Request is not mergeable");
        record("mergePull", { number });
      },
    };
  };

  calls(name: string) {
    return this.writes.filter((w) => w.call === name);
  }
}
