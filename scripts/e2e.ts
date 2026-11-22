// End-to-end scenarios against the sandbox client (§11), run by the release workflow before tagging, or by hand.
// Every shipped template, driven by the `fake` agent: label → router → task → writes → next label. The sandbox's
// stub must call this repo's router at `release-candidate`, which the release workflow points at the candidate.
//
//   SANDBOX_TOKEN=… node scripts/e2e.ts [scenario…]      (Node 24+ runs this TypeScript directly)
//
// SANDBOX_TOKEN needs Contents, Issues, Pull requests (write) and Actions (write, for the doctor dispatch) on the
// sandbox. SANDBOX_REPO defaults to skylight-hq/osh-simulator. With AGENT set (say `claude`), only the smoke
// scenario runs, on a real agent; the sandbox then needs that agent's secret.
import { appendFileSync } from "node:fs";

const repo = process.env.SANDBOX_REPO ?? "skylight-hq/osh-simulator";
const token = process.env.SANDBOX_TOKEN ?? process.env.GH_TOKEN;
const realAgent = process.env.AGENT;
const STUB_REF = "release-candidate";
const POLL_MS = 15_000;
const STEP_TIMEOUT_MS = 12 * 60_000;
if (!token) throw new Error("set SANDBOX_TOKEN");

// ---------------------------------------------------------------------------------------------------------------
// GitHub

// API responses are read loosely here: this is a test driver, and each use names the fields it needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gh(method: string, path: string, body?: unknown): Promise<any> {
  const url = path.startsWith("repos/") || path.startsWith("search/") ? path : path ? `repos/${repo}/${path}` : `repos/${repo}`;
  const response = await fetch(`https://api.github.com/${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "actions-factory-e2e" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

/** One commit on the sandbox's default branch that sets (or, with null, deletes) these files. */
async function commitFiles(message: string, files: Record<string, string | null>): Promise<void> {
  const branch = (await gh("GET", "")).default_branch as string;
  const ref = await gh("GET", `git/ref/heads/${branch}`);
  const parent = await gh("GET", `git/commits/${ref.object.sha}`);
  const tree = await gh("POST", "git/trees", {
    base_tree: parent.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", ...(content === null ? { sha: null } : { content }) })),
  });
  if (tree.sha === parent.tree.sha) return;
  const commit = await gh("POST", "git/commits", { message, tree: tree.sha, parents: [ref.object.sha] });
  await gh("PATCH", `git/refs/heads/${branch}`, { sha: commit.sha });
}

async function fileOnMain(path: string): Promise<string | undefined> {
  try {
    const file = await gh("GET", `contents/${path}`);
    return Buffer.from(file.content, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

const createIssue = async (title: string, body: string, labels: string[]) =>
  (await gh("POST", "issues", { title: `e2e: ${title}`, body, labels: ["e2e", ...labels] })).number as number;
const addLabel = (n: number, label: string) => gh("POST", `issues/${n}/labels`, { labels: [label] });
const labels = async (n: number) => ((await gh("GET", `issues/${n}`)).labels as Array<{ name: string }>).map((l) => l.name);
const comments = async (n: number) => (await gh("GET", `issues/${n}/comments?per_page=100`)) as Array<{ body: string }>;
const status = async (n: number) => (await comments(n)).filter((c) => c.body.includes("<!-- factory:status")).map((c) => c.body);
const pullFrom = async (prefix: string) =>
  ((await gh("GET", "pulls?state=all&per_page=50")) as Array<{ number: number; head: { ref: string } }>).find((p) => p.head.ref.startsWith(prefix));

async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Waits for a status comment on `n` and fails the scenario if the run stopped. */
async function finished(n: number, task: string): Promise<string> {
  const body = await until(`${task} on #${n}`, async () => (await status(n)).find((b) => b.includes(`\`${task}\``)));
  if (!body.includes("✅")) throw new Error(`${task} on #${n} stopped: ${body.split("\n")[1]}`);
  return body;
}

// ---------------------------------------------------------------------------------------------------------------
// The sandbox's config and fake-agent scripts

const fake = (plan: unknown, files?: Record<string, string>) => JSON.stringify({ plan, ...(files ? { files } : {}) }, null, 2);
const cases = (list: unknown[]) => JSON.stringify({ cases: list }, null, 2);

const FIXTURES: Record<string, string> = {
  ".factory/fake/explore.json": cases([
    { promptMatch: "### Issue #(\\d+)", plan: { items: [{ number: "$1", outcome: "easy-call", comment: "e2e explore: an easy call." }] } },
  ]),
  ".factory/fake/implement.json": cases([
    {
      promptMatch: "### Issue #(\\d+)",
      plan: { outcome: "done", comment: "e2e implement.", pullRequest: { title: "e2e: implement #$1", body: "Closes #$1" } },
      files: { "e2e/issue-$1.txt": "built by the e2e implement run\n" },
    },
  ]),
  ".factory/fake/review.json": cases([
    {
      promptMatch: "### Pull request #(\\d+)",
      plan: { outcome: "ready", comment: "## Standards: PASS\ne2e review.\n\n## Spec: PASS\ne2e review." },
      files: { "e2e/review-$1.txt": "fixed by the e2e review run\n" },
    },
  ]),
  ".factory/fake/merge.json": fake({ outcome: "merged", comment: "e2e merge.", merge: true }),
  ".factory/fake/implement-spec.json": cases([
    {
      promptMatch: "splits it",
      plan: {
        outcome: "split",
        comment: "e2e split.",
        createIssues: [
          { title: "e2e: spec part one", body: "First.", labels: ["e2e"] },
          { title: "e2e: spec part two", body: "Second.", labels: ["e2e"] },
        ],
        dependsOn: [[], [0]],
      },
    },
    {
      promptMatch: "builds ticket #(\\d+)",
      plan: { outcome: "built", ticket: "$1", comment: "e2e built #$1.", pullRequest: { title: "e2e: spec", body: "The e2e spec." } },
      files: { "e2e/ticket-$1.txt": "built\n" },
    },
    { promptMatch: "is closed", plan: { outcome: "done", comment: "e2e: every ticket built." } },
    { promptMatch: "is blocked", plan: { outcome: "needs-a-human", comment: "e2e: blocked." } },
  ]),
  ".factory/fake/discover.json": fake({ outcome: "ready", comment: "## Who has this problem\ne2e discovery." }),
};

function factoryYml(template: string, agent = "fake"): string {
  return [
    "# The sandbox client's config. scripts/e2e.ts in actions-factory rewrites it for each scenario.",
    "schemaVersion: 1",
    `agent: ${agent}`,
    `template: ${template}`,
    "labels:",
    "  e2e: { color: 'c5def5', description: actions-factory end-to-end scenario }",
    "",
  ].join("\n");
}

async function useTemplate(template: string, agent?: string): Promise<void> {
  await commitFiles(`e2e: template ${template}`, { "factory.yml": factoryYml(template, agent), ...FIXTURES });
  // Labels the new template needs are made on the router's next run; show-config is the cheapest one.
  await gh("POST", "actions/workflows/factory.yml/dispatches", { ref: (await gh("GET", "")).default_branch, inputs: { command: "show-config" } });
  await until("labels for the template", async () => {
    const names = ((await gh("GET", "labels?per_page=100")) as Array<{ name: string }>).map((l) => l.name);
    const needed = { default: "agent:explore", full: "agent:implement-spec", "spec-flow": "agent:discover", "review-only": "agent:review" }[template];
    return !needed || names.includes(needed);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios

const created: number[] = [];
const track = (n: number) => (created.push(n), n);

const scenarios: Record<string, () => Promise<string>> = {
  async doctor() {
    const since = new Date().toISOString();
    await gh("POST", "actions/workflows/factory.yml/dispatches", { ref: (await gh("GET", "")).default_branch, inputs: { command: "doctor" } });
    const run = await until("the doctor run", async () => {
      const runs = (await gh("GET", `actions/workflows/factory.yml/runs?event=workflow_dispatch&created=>=${since}`)).workflow_runs as Array<{ status: string; conclusion: string; display_title: string }>;
      return runs.find((r) => r.display_title === "factory · doctor" && r.status === "completed");
    });
    if (run.conclusion !== "success") throw new Error(`the doctor run ended ${run.conclusion}`);
    return "doctor: every check passed";
  },

  async default() {
    await useTemplate("default");
    const issue = track(await createIssue("default journey", "Add a file.", ["agent:explore"]));
    await finished(issue, "explore");
    await finished(issue, "implement");
    const pr = await until("implement's pull request", () => pullFrom(`agent/issue-${issue}-`));
    track(pr.number);
    await finished(pr.number, "review");
    const files = ((await gh("GET", `pulls/${pr.number}/files`)) as Array<{ filename: string }>).map((f) => f.filename).sort();
    const expected = [`e2e/issue-${issue}.txt`, `e2e/review-${pr.number}.txt`];
    if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`PR #${pr.number} has ${files.join(", ")}, not ${expected.join(", ")}`);
    if ((await gh("GET", `pulls/${pr.number}`)).draft) throw new Error(`review didn't mark PR #${pr.number} ready`);
    // A person's agent:merge (this script stands in for one).
    await addLabel(pr.number, "agent:merge");
    await finished(pr.number, "merge");
    if (!(await gh("GET", `pulls/${pr.number}`)).merged) throw new Error(`PR #${pr.number} wasn't merged`);
    await commitFiles("e2e: remove merged scenario files", Object.fromEntries(expected.map((f) => [f, null])));
    return `default: explore → implement → review (fix pushed, ready) → merge, on #${issue} and PR #${pr.number}`;
  },

  async full() {
    await useTemplate("full");
    const spec = track(await createIssue("spec", "Add two files, in order.", ["agent:implement-spec"]));
    await until("the spec's split", async () => (await status(spec)).some((b) => b.includes("**split**")));
    const tickets = ((await gh("GET", `issues/${spec}/sub_issues`)) as Array<{ number: number }>).map((t) => t.number);
    tickets.forEach(track);
    await until("the spec's done", async () => (await status(spec)).some((b) => b.includes("**done**")));
    for (const t of tickets) if ((await gh("GET", `issues/${t}`)).state !== "closed") throw new Error(`ticket #${t} is still open`);
    const pr = await until("the spec's pull request", () => pullFrom(`agent/issue-${spec}`));
    track(pr.number);
    const files = ((await gh("GET", `pulls/${pr.number}/files`)) as Array<{ filename: string }>).map((f) => f.filename);
    for (const t of tickets) if (!files.includes(`e2e/ticket-${t}.txt`)) throw new Error(`PR #${pr.number} lacks ticket #${t}'s file`);
    await finished(pr.number, "review");
    return `full: implement-spec split #${spec} into ${tickets.map((t) => `#${t}`).join(", ")}, built each on PR #${pr.number}, then review`;
  },

  async "spec-flow"() {
    await useTemplate("spec-flow");
    const issue = track(await createIssue("spec-flow", "Users can't export their data.", ["agent:discover"]));
    await finished(issue, "discover");
    if (!(await labels(issue)).includes("needs-signoff")) throw new Error(`discover didn't add needs-signoff to #${issue}`);
    return `spec-flow: discover posted its write-up on #${issue} and waits on sign-off`;
  },

  async "review-only"() {
    await useTemplate("review-only");
    // A person's branch and pull request, which the factory must review without pushing to.
    const branch = `e2e/person-${Date.now()}`;
    const main = (await gh("GET", "")).default_branch as string;
    const sha = (await gh("GET", `git/ref/heads/${main}`)).object.sha;
    await gh("POST", "git/refs", { ref: `refs/heads/${branch}`, sha });
    await gh("PUT", `contents/e2e/person.txt`, { message: "e2e: a person's change", content: Buffer.from("a person's change\n").toString("base64"), branch });
    const pr = (await gh("POST", "pulls", { title: "e2e: a person's pull request", head: branch, base: main, body: "Review me." })).number as number;
    track(pr);
    await gh("POST", `issues/${pr}/labels`, { labels: ["e2e", "agent:review"] });
    await finished(pr, "review");
    const commits = (await gh("GET", `pulls/${pr}/commits`)) as unknown[];
    if (commits.length !== 1) throw new Error(`review pushed to a person's branch (PR #${pr} has ${commits.length} commits)`);
    return `review-only: reviewed PR #${pr} on a person's branch without pushing`;
  },

  async smoke() {
    if (!realAgent) throw new Error("the smoke scenario needs AGENT");
    await useTemplate("default", realAgent);
    const issue = track(await createIssue("smoke", "Add a file `e2e/smoke.txt` containing the word smoke. Nothing else.", ["agent:implement"]));
    await finished(issue, "implement");
    const pr = await until("implement's pull request", () => pullFrom(`agent/issue-${issue}-`));
    track(pr.number);
    return `smoke: ${realAgent} implemented #${issue} as PR #${pr.number}`;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Run

async function cleanUp(): Promise<void> {
  const open = (await gh("GET", `search/issues?q=${encodeURIComponent(`repo:${repo} label:e2e is:open`)}&per_page=100`)).items as Array<{ number: number }>;
  for (const n of new Set([...created, ...open.map((i) => i.number)])) await gh("PATCH", `issues/${n}`, { state: "closed" }).catch(() => {});
  const branches = (await gh("GET", "branches?per_page=100")) as Array<{ name: string }>;
  for (const b of branches) if (/^(agent\/issue-|e2e\/)/.test(b.name)) await gh("DELETE", `git/refs/heads/${b.name}`).catch(() => {});
}

async function main(): Promise<void> {
  const stub = (await fileOnMain(".github/workflows/factory.yml")) ?? "";
  if (!stub.includes(`router.yml@${STUB_REF}`)) throw new Error(`${repo}'s stub must call the router at @${STUB_REF}`);

  const chosen = process.argv.slice(2);
  const names = realAgent ? ["smoke"] : chosen.length > 0 ? chosen : ["doctor", "default", "full", "spec-flow", "review-only"];
  const results: string[] = [];
  let failed = 0;
  await cleanUp();
  try {
    for (const name of names) {
      const run = scenarios[name];
      if (!run) throw new Error(`no scenario named ${name}`);
      try {
        results.push(`✅ ${await run()}`);
      } catch (error) {
        failed++;
        results.push(`❌ ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      console.log(results.at(-1));
    }
  } finally {
    await useTemplate("default").catch(() => {});
    await cleanUp();
  }
  const report = ["### Sandbox end-to-end", "", ...results.map((r) => `- ${r}`), ""].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (failed > 0) process.exit(1);
}

await main();
