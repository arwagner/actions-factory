import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitFetcher } from "../src/config/fetch.js";
import { tree } from "./support/tree.js";

/** A local "owner/repo" under a fake GitHub base URL, with a v1 tag and a newer main. */
function fakeGitHub() {
  const base = tree({ "acme/templates/flows/team/template.yml": "name: team\n" });
  const repo = join(base, "acme/templates");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "v1");
  git("tag", "v1");
  const v1 = git("rev-parse", "HEAD");
  execFileSync("sh", ["-c", "echo 'name: team2' > flows/team/template.yml"], { cwd: repo });
  git("commit", "-qam", "newer");
  git("config", "uploadpack.allowReachableSHA1InWant", "true");
  return { baseUrl: `file://${base}`, v1 };
}

describe("gitFetcher", () => {
  it("checks out a tag, a branch or a commit SHA", async () => {
    const { baseUrl, v1 } = fakeGitHub();
    const fetchRepo = gitFetcher({ baseUrl, cacheDir: tree({}) });
    const read = (dir: string) => readFileSync(join(dir, "flows/team/template.yml"), "utf8");

    expect(read(await fetchRepo({ owner: "acme", repo: "templates", ref: "v1" }))).toBe("name: team\n");
    expect(read(await fetchRepo({ owner: "acme", repo: "templates", ref: "main" }))).toBe("name: team2\n");
    expect(read(await fetchRepo({ owner: "acme", repo: "templates", ref: v1 }))).toBe("name: team\n");
  });

  it("leaves no git metadata or credentials in the checkout", async () => {
    const { baseUrl } = fakeGitHub();
    const dir = await gitFetcher({ baseUrl, cacheDir: tree({}), token: "s3cret" })({
      owner: "acme",
      repo: "templates",
      ref: "v1",
    });

    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("fails with a short reason when the ref doesn't exist", async () => {
    const { baseUrl } = fakeGitHub();
    const fetchRepo = gitFetcher({ baseUrl, cacheDir: tree({}) });

    await expect(fetchRepo({ owner: "acme", repo: "templates", ref: "v9" })).rejects.toThrow(/couldn't find ref v9/);
  });
});
