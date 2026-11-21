import type { GitHubApi, Label } from "../../src/router/github.js";

/** An in-memory GitHub for one repo, recording every write and which token made it. */
export class FakeGitHub {
  labels: Label[] = [];
  permissions: Record<string, string> = {};
  writes: Array<{ token: string; call: string; args: unknown }> = [];

  api = (token: string): GitHubApi => ({
    permission: async (user) => this.permissions[user] ?? "none",
    listLabels: async () => structuredClone(this.labels),
    createLabel: async (label) => {
      this.writes.push({ token, call: "createLabel", args: label });
      this.labels.push(label);
    },
    updateLabel: async (label) => {
      this.writes.push({ token, call: "updateLabel", args: label });
      this.labels = this.labels.map((l) => (l.name === label.name ? label : l));
    },
    removeLabel: async (number, name) => {
      this.writes.push({ token, call: "removeLabel", args: { number, name } });
    },
    comment: async (number, body) => {
      this.writes.push({ token, call: "comment", args: { number, body } });
    },
  });

  calls(name: string) {
    return this.writes.filter((w) => w.call === name);
  }
}
