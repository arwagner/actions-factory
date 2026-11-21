import type { GitHubApi, Label } from "../../src/router/github.js";

/** An in-memory GitHub for one repo, recording every write and which token made it. */
export class FakeGitHub {
  labels: Label[] = [];
  permissions: Record<string, string> = {};
  comments: Record<number, Array<{ id: number; body: string; author?: string }>> = {};
  issues: Record<number, { title: string; body: string }> = {};
  search: Array<{ number: number; title: string; body: string }> = [];
  runs: Array<{ id: number; title: string; conclusion: string | null }> = [];
  pulls: Record<number, { head: string; mergeable: boolean }> = {};
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
      getIssue: async (number) => ({ ...(this.issues[number] ?? { title: "", body: "" }), isPullRequest: false }),
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
      getPull: async (number) => this.pulls[number] ?? { head: "feature", mergeable: false },
      createPull: async (pull) => {
        record("createPull", pull);
        return 77;
      },
      listRunsSince: async () => structuredClone(this.runs),
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
