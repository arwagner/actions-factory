import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FetchRepo } from "./load.js";

const run = promisify(execFile);

export interface GitFetcherOptions {
  /** Where checkouts are kept, one per owner/repo/ref. */
  cacheDir: string;
  /** `FACTORY_TOKEN`, for private template repos. Sent as a header, never in the URL. */
  token?: string;
  baseUrl?: string;
}

/**
 * Fetches a template repo at a tag, branch or commit SHA with a depth-1 git
 * fetch, and returns a plain folder: no `.git`, so no credentials are left behind.
 */
export function gitFetcher({ cacheDir, token, baseUrl = "https://github.com" }: GitFetcherOptions): FetchRepo {
  return async ({ owner, repo, ref }) => {
    const dir = join(cacheDir, owner, repo, encodeURIComponent(ref));
    if (existsSync(dir)) return dir;
    mkdirSync(dirname(dir), { recursive: true });
    const work = mkdtempSync(`${dir}.partial-`);
    const auth = token
      ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]
      : [];
    const git = (...args: string[]) => run("git", args, { cwd: work });
    try {
      await git("init", "-q");
      await git(...auth, "fetch", "-q", "--depth", "1", "--no-tags", `${baseUrl}/${owner}/${repo}`, ref);
      await git("-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      // No `cause`: the git error's `cmd` holds the auth header, which must not reach any log.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(reason(error, ref, token));
    }
    rmSync(join(work, ".git"), { recursive: true, force: true });
    renameSync(work, dir);
    return dir;
  };
}

function reason(error: unknown, ref: string, token?: string): string {
  const stderr = String((error as { stderr?: unknown }).stderr ?? error);
  if (/couldn't find remote ref|not our ref|unadvertised object/i.test(stderr)) return `couldn't find ref ${ref}`;
  const last = stderr.trim().split("\n").pop() ?? "git fetch failed";
  return token ? last.replaceAll(token, "***") : last;
}
