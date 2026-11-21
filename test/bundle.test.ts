import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledWork } from "../src/runner/bundle.js";
import { tree } from "./support/tree.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

/** An origin, the apply job's checkout of it, and a bundle of agent work on top. */
function setup() {
  const origin = tree({ "README.md": "hi\n" });
  git(origin, "init", "-q", "-b", "main");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "init");
  const checkout = join(tree({}), "client");
  git(origin, "clone", "-q", origin, checkout);
  const agent = join(tree({}), "agent");
  git(origin, "clone", "-q", origin, agent);
  git(agent, "switch", "-qc", "factory-work");
  writeFileSync(join(agent, "widget.ts"), "export {};\n");
  git(agent, "add", ".");
  git(agent, "commit", "-qm", "work");
  const bundle = join(tree({}), "work.bundle");
  git(agent, "bundle", "create", bundle, "main..factory-work");
  git(origin, "config", "receive.denyCurrentBranch", "ignore");
  return { origin, checkout, bundle };
}

describe("bundledWork", () => {
  it("lists the files the agent changed and pushes them to a new branch", async () => {
    const { origin, checkout, bundle } = setup();
    const work = bundledWork({ checkout, bundle, remote: origin });

    expect(await work.changedFiles()).toEqual(["widget.ts"]);
    await work.push("agent/issue-42-1");
    expect(git(origin, "ls-tree", "--name-only", "agent/issue-42-1").split("\n")).toEqual(["README.md", "widget.ts"]);
  });

  it("reports no changes when the agent handed over no bundle", async () => {
    const { origin, checkout } = setup();

    expect(await bundledWork({ checkout, bundle: join(checkout, "missing.bundle"), remote: origin }).changedFiles()).toEqual([]);
  });

  it("never force-pushes over a branch that has moved", async () => {
    const { origin, checkout, bundle } = setup();
    git(origin, "branch", "agent/issue-42-1");
    git(origin, "switch", "-q", "agent/issue-42-1");
    writeFileSync(join(origin, "other.ts"), "x\n");
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "someone else");
    git(origin, "switch", "-q", "main");

    await expect(bundledWork({ checkout, bundle, remote: origin }).push("agent/issue-42-1")).rejects.toThrow(/push/);
  });
});
