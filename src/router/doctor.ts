import { CLI_VERSIONS } from "../agents/versions.js";
import type { LoadResult } from "../config/load.js";
import type { GitHubApi } from "./github.js";
import { STUB_VERSION } from "./version.js";

const GETTING_STARTED = "https://github.com/arwagner/actions-factory/wiki/Getting-started";

/** One doctor check: what was checked, how it went, and how to fix it when it failed. */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** What each access probe returned: an HTTP status, or 0 when the request never got one. */
export interface AccessProbe {
  read: number;
  contents: number;
  issues: number;
  pullRequests: number;
}

export interface DoctorInput {
  loaded: LoadResult;
  /** The client for `FACTORY_TOKEN`, if the secret is set. */
  writer?: GitHubApi;
  stubVersion?: string;
  /** Why creating the labels failed, if it did. Undefined when they were made. */
  labelsError?: string;
}

/**
 * The route job's half of the doctor (§12): config, `FACTORY_TOKEN` and what it can do, labels, stub version.
 * The agent credentials are checked in their own job, which alone holds them.
 */
export async function doctorChecks({ loaded, writer, stubVersion, labelsError }: DoctorInput): Promise<Check[]> {
  const checks: Check[] = [];
  const stack = loaded.layers.map((l) => l.name).join(" → ");
  checks.push(
    loaded.ok
      ? { name: "Config", ok: true, detail: `validates; layers: ${stack}` }
      : {
          name: "Config",
          ok: false,
          detail: (loaded.errors as Array<{ path: string; layer?: string; message: string }>)
            .map((e) => `${e.path ? `\`${e.path}\`` : ""}${e.layer ? ` (${e.layer})` : ""}: ${e.message}`)
            .join("<br>"),
          fix: "Fix `factory.yml` (or the template it names). The config section below shows every layer.",
        },
  );

  if (!writer) {
    checks.push({ name: "`FACTORY_TOKEN`", ok: false, detail: "not set", fix: `Create the token and set the secret, as in ${GETTING_STARTED}.` });
  } else {
    checks.push({ name: "`FACTORY_TOKEN`", ok: true, detail: "set" });
    checks.push(...accessChecks(await writer.probeAccess()));
    const tasks = (loaded.config.tasks ?? {}) as Record<string, { allowWorkflowChanges?: boolean }>;
    const workflowTasks = Object.entries(tasks).filter(([, t]) => t.allowWorkflowChanges).map(([n]) => `\`${n}\``);
    if (workflowTasks.length > 0) {
      checks.push({
        name: "Token: workflows",
        ok: true,
        detail: `not checked (it can't be without pushing a workflow). ${workflowTasks.join(", ")} set \`allowWorkflowChanges\`, so the token needs Workflows: write.`,
      });
    }
  }

  if (loaded.ok && writer) {
    checks.push(
      labelsError
        ? { name: "Labels", ok: false, detail: labelsError, fix: "Give the token Issues: write." }
        : { name: "Labels", ok: true, detail: "every label the config needs exists" },
    );
  }

  checks.push(stubCheck(stubVersion));
  return checks;
}

const ACCESS: Array<{ key: keyof AccessProbe; name: string; permission: string; allowed: number[] }> = [
  { key: "read", name: "Token: read the repo", permission: "access to this repo (its resource owner and repository access)", allowed: [200] },
  // Each write probe sends input GitHub rejects, so it writes nothing: 403 means no permission, 422 means allowed.
  { key: "contents", name: "Token: push branches", permission: "Contents: write", allowed: [422] },
  { key: "issues", name: "Token: write issues", permission: "Issues: write", allowed: [422] },
  { key: "pullRequests", name: "Token: open pull requests", permission: "Pull requests: write", allowed: [422] },
];

function accessChecks(probe: AccessProbe): Check[] {
  return ACCESS.map(({ key, name, permission, allowed }) => {
    const status = probe[key];
    if (allowed.includes(status)) return { name, ok: true, detail: "allowed" };
    const detail = status === 401 ? "GitHub rejected the token (401): expired or revoked" : status ? `GitHub answered ${status}` : "no answer from GitHub";
    const fix = status === 401 ? "Create a new token and update the secret." : `Give the token ${permission}. In an org, an owner may need to approve it.`;
    return { name, ok: false, detail, fix };
  });
}

function stubCheck(stubVersion: string | undefined): Check {
  const name = "Stub version";
  const fix = `Copy the current stub (v${STUB_VERSION}) from ${GETTING_STARTED}.`;
  if (!stubVersion) return { name, ok: false, detail: "the stub declares no version", fix };
  if (stubVersion.replace(/^v/, "") !== STUB_VERSION) return { name, ok: false, detail: `v${stubVersion.replace(/^v/, "")}; the current stub is v${STUB_VERSION}`, fix };
  return { name, ok: true, detail: `v${STUB_VERSION}, current` };
}

/** Every agent the merged config uses, for the doctor's agent job: one entry per agent, with its CLI version for the cache key. */
export function doctorAgents(loaded: LoadResult): Array<{ agent: string; cliVersion: string }> {
  if (!loaded.ok) return [];
  const tasks = (loaded.config.tasks ?? {}) as Record<string, { agent?: string }>;
  const agents = new Set([loaded.config.agent as string, ...Object.values(tasks).flatMap((t) => t.agent ?? [])]);
  return [...agents].sort().map((agent) => ({ agent, cliVersion: CLI_VERSIONS[agent] ?? "none" }));
}

/** The doctor's results as a summary table. */
export function renderChecks(checks: Check[]): string {
  const rows = checks.map((c) => `| ${c.ok ? "✅" : "❌"} | ${c.name} | ${c.detail}${c.fix ? `<br>**Fix:** ${c.fix}` : ""} |`);
  return ["| | Check | Result |", "|---|---|---|", ...rows].join("\n");
}
