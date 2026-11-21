import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { tree } from "./support/tree.js";

const factoryRoot = fileURLToPath(new URL("..", import.meta.url));
const hook = (name: string) => join(factoryRoot, "templates/full/hooks", name);

/**
 * Runs a hook with a stand-in `gh` that serves canned API responses (keyed by method and endpoint, `--jq`
 * applied with real jq) and logs every call. Returns the log and what the hook wrote to context.md.
 */
function runHook(name: string, responses: Record<string, unknown>, env: Record<string, string> = {}, cwd = tree({})) {
  const dir = tree({});
  const key = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
  for (const [endpoint, body] of Object.entries(responses)) writeFileSync(join(dir, key(endpoint)), JSON.stringify(body));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/log"
shift
method=GET; jqf=""; ep=""
while [ $# -gt 0 ]; do case "$1" in -X) method=$2; shift 2;; --jq) jqf=$2; shift 2;; -f|-F) shift 2;; --silent) shift;; *) ep=$1; shift;; esac; done
f="${dir}/$(printf '%s' "$method $ep" | sed 's/[^A-Za-z0-9]/_/g')"
if [ ! -f "$f" ]; then [ "$method" = GET ] && { echo "no response for $method $ep" >&2; exit 1; }; exit 0; fi
if [ -n "$jqf" ]; then jq -r "$jqf" "$f"; else cat "$f"; fi
`,
  );
  chmodSync(gh, 0o755);
  const work = tree({});
  const result = spawnSync("bash", [hook(name)], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", FACTORY_WORK_DIR: work, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  const log = existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").trim().split("\n") : [];
  const context = existsSync(join(work, "context.md")) ? readFileSync(join(work, "context.md"), "utf8") : "";
  return { log, context };
}

describe("the full template", () => {
  it("loads and validates as shipped: default's four tasks plus implement-spec and ratchet", async () => {
    const clientRoot = tree({ "factory.yml": "schemaVersion: 1\ntemplate: full\n" });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo: () => Promise.reject(new Error("unused")) });

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.config.tasks as object)).toEqual(["explore", "implement", "review", "merge", "implement-spec", "ratchet"]);
    expect(result.layers.map((l) => l.name)).toEqual(["template default", "template full", "factory.yml"]);
  });

  it("takes a ratchet schedule from factory.yml, since only the client knows the tracking issue", async () => {
    const clientRoot = tree({ "factory.yml": 'schemaVersion: 1\ntemplate: full\ntasks:\n  ratchet:\n    schedule: { cron: "0 6 * * 1-5", subject: 123 }\n' });

    const result = await loadConfig({ clientRoot, factoryRoot, fetchRepo: () => Promise.reject(new Error("unused")) });

    expect(result.errors).toEqual([]);
  });
});

describe("implement-spec's before hook", () => {
  const sub = (number: number, state = "open") => ({ number, state });

  it("asks for a split when the spec has no tickets", () => {
    const { context } = runHook("spec-next.sh", { "GET repos/o/r/issues/5/sub_issues?per_page=100": [] }, { FACTORY_SUBJECT: "5" });

    expect(context).toContain("Spec #5 has no tickets yet, so this run splits it.");
  });

  it("picks the first open ticket in sub-issue order that nothing open blocks, quoting it as untrusted", () => {
    const { context } = runHook(
      "spec-next.sh",
      {
        "GET repos/o/r/issues/5/sub_issues?per_page=100": [sub(10, "closed"), sub(11), sub(12)],
        "GET repos/o/r/issues/11/dependencies/blocked_by": [{ number: 12, state: "open" }],
        "GET repos/o/r/issues/12/dependencies/blocked_by": [{ number: 10, state: "closed" }],
        "GET repos/o/r/issues/12": { number: 12, title: "Add the store", body: "Persist it." },
      },
      { FACTORY_SUBJECT: "5" },
    );

    expect(context).toContain("This run builds ticket #12 of spec #5");
    expect(context).toContain("<ticket>\n#12 Add the store\n\nPersist it.\n</ticket>");
  });

  it("says when every open ticket is blocked, and when every ticket is closed", () => {
    const blocked = runHook(
      "spec-next.sh",
      {
        "GET repos/o/r/issues/5/sub_issues?per_page=100": [sub(11)],
        "GET repos/o/r/issues/11/dependencies/blocked_by": [{ number: 99, state: "open" }],
      },
      { FACTORY_SUBJECT: "5" },
    );
    expect(blocked.context).toContain("is blocked (#11)");

    const finished = runHook("spec-next.sh", { "GET repos/o/r/issues/5/sub_issues?per_page=100": [sub(10, "closed")] }, { FACTORY_SUBJECT: "5" });
    expect(finished.context).toContain("Every ticket of spec #5 is closed");
  });
});

describe("implement-spec's after hook", () => {
  const base = { FACTORY_SUBJECT: "5", FACTORY_TASK_LABEL: "agent:implement-spec" };

  it("after a split, links the new tickets as sub-issues with blocking links, and starts the next run", () => {
    const { log } = runHook(
      "spec-after.sh",
      { "GET repos/o/r/issues/20": { id: 2000 }, "GET repos/o/r/issues/21": { id: 2100 }, "GET repos/o/r/issues/22": { id: 2200 } },
      { ...base, FACTORY_OUTCOME: "split", FACTORY_CREATED_ISSUES: "20 21 22", FACTORY_PLAN: JSON.stringify({ dependsOn: [[], [0], [0, 1]] }) },
    );

    const writes = log.filter((l) => l.includes("-X POST"));
    expect(writes).toEqual([
      "api -X POST repos/o/r/issues/5/sub_issues -F sub_issue_id=2000 --silent",
      "api -X POST repos/o/r/issues/5/sub_issues -F sub_issue_id=2100 --silent",
      "api -X POST repos/o/r/issues/5/sub_issues -F sub_issue_id=2200 --silent",
      "api -X POST repos/o/r/issues/21/dependencies/blocked_by -F issue_id=2000 --silent",
      "api -X POST repos/o/r/issues/22/dependencies/blocked_by -F issue_id=2000 --silent",
      "api -X POST repos/o/r/issues/22/dependencies/blocked_by -F issue_id=2100 --silent",
      "api -X POST repos/o/r/issues/5/labels -f labels[]=agent:implement-spec --silent",
    ]);
  });

  it("after a built ticket, closes it and starts the next run; when done, hands the spec's PR to review", () => {
    const built = runHook("spec-after.sh", {}, { ...base, FACTORY_OUTCOME: "built", FACTORY_PLAN: JSON.stringify({ ticket: 12 }) });
    expect(built.log).toEqual([
      "api -X PATCH repos/o/r/issues/12 -f state=closed -f state_reason=completed --silent",
      "api -X POST repos/o/r/issues/5/labels -f labels[]=agent:implement-spec --silent",
    ]);

    const done = runHook("spec-after.sh", { "GET repos/o/r/pulls?state=open&head=o:agent/issue-5": [{ number: 61 }] }, { ...base, FACTORY_OUTCOME: "done", FACTORY_PLAN: "{}" });
    expect(done.log).toContain("api -X POST repos/o/r/issues/61/labels -f labels[]=agent:review --silent");
    expect(done.log.some((l) => l.includes("issues/5/labels"))).toBe(false);
  });
});

describe("ratchet's before hook", () => {
  const issue = (body: string) => ({ "GET repos/o/r/issues/9": { body } });
  const body = "Tracking strict mode.\nratchet-exceptions: strict.txt\nratchet-check: npx tsc --strict {entry}\n";

  it("picks one entry from the exception list the tracking issue names, and gives the check for it", () => {
    const cwd = tree({ "strict.txt": "# legacy files\n\nsrc/a.ts\n" });

    const { context } = runHook("ratchet-pick.sh", issue(body), { FACTORY_SUBJECT: "9" }, cwd);

    expect(context).toContain("    src/a.ts");
    expect(context).toContain("    npx tsc --strict src/a.ts");
  });

  it("stops with not-fixed when the issue names no list, a path outside the repo, or an empty list", () => {
    expect(runHook("ratchet-pick.sh", issue("No settings."), { FACTORY_SUBJECT: "9" }).context).toContain("needs a `ratchet-exceptions:` line");
    expect(runHook("ratchet-pick.sh", issue(body.replace("strict.txt", "../x.txt")), { FACTORY_SUBJECT: "9" }).context).toContain("must be a path inside the repo");
    expect(runHook("ratchet-pick.sh", issue(body), { FACTORY_SUBJECT: "9" }, tree({ "strict.txt": "# none left\n" })).context).toContain(
      "the migration is done",
    );
  });
});
