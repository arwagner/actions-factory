import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The ref the agent job commits its work to before bundling it. */
export const WORK_REF = "factory-work";

export interface BundledWorkOptions {
  /** The apply job's checkout of the client repo, at the same commit the agent started from. */
  checkout: string;
  /** The agent job's `git bundle` of `WORK_REF`. Missing means the agent changed nothing. */
  bundle: string;
  /** Where to push: the client repo's URL, or a path in tests. */
  remote: string;
  /** `FACTORY_TOKEN`, sent as a header, never in the URL. */
  token?: string;
}

/** The agent's work as the apply job sees it: what changed, and a push that never forces. */
export function bundledWork({ checkout, bundle, remote, token }: BundledWorkOptions) {
  const git = (...args: string[]) => run("git", args, { cwd: checkout });
  let fetched: Promise<boolean> | undefined;
  const fetch = () =>
    (fetched ??= existsSync(bundle)
      ? git("fetch", "-q", bundle, `${WORK_REF}:${WORK_REF}`).then(() => true)
      : Promise.resolve(false));
  return {
    async changedFiles(): Promise<string[]> {
      if (!(await fetch())) return [];
      const { stdout } = await git("diff", "--name-only", `HEAD...${WORK_REF}`);
      return stdout.split("\n").filter(Boolean);
    },
    async push(branch: string): Promise<void> {
      if (!(await fetch())) throw new Error("there is no work to push");
      const auth = token
        ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]
        : [];
      try {
        await git(...auth, "push", "-q", remote, `${WORK_REF}:refs/heads/${branch}`);
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        const last = stderr.trim().split("\n").pop() ?? "";
        // No `cause`: the git error's `cmd` holds the auth header.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`git push to ${branch} failed: ${token ? last.replaceAll(token, "***") : last}`);
      }
    },
  };
}
