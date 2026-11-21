import type { Adapter } from "../agents/types.js";
import { type Check, renderChecks } from "../router/doctor.js";

/**
 * The doctor's agent job, one per agent the config uses (§12). It alone holds that agent's credentials, so it
 * checks one is set, then sends a tiny prompt. Returns whether both passed, after writing its summary.
 */
export async function doctorAgent(input: {
  agent: string;
  adapters: Record<string, Adapter>;
  env: Record<string, string | undefined>;
  summary: (markdown: string) => void;
}): Promise<boolean> {
  const adapter = input.adapters[input.agent];
  const checks: Check[] = [];
  if (!adapter) {
    checks.push({ name: "Agent", ok: false, detail: `this factory release has no ${input.agent} adapter`, fix: "Use one of the agents in the config reference." });
  } else {
    const names = adapter.credentials;
    const set = names.filter((n) => input.env[n]);
    if (names.length > 0 && set.length === 0) {
      const which = names.map((n) => `\`${n}\``).join(" or ");
      checks.push({ name: "Credential", ok: false, detail: "no credential secret is set", fix: `Set ${which} as a repo secret.` });
    } else {
      if (names.length > 0) checks.push({ name: "Credential", ok: true, detail: `${set.map((n) => `\`${n}\``).join(", ")} set` });
      const ping = await adapter.ping();
      checks.push({
        name: "Test prompt",
        ok: ping.ok,
        detail: ping.detail,
        ...(ping.ok ? {} : { fix: "Check that the credential is valid and has quota, then update the secret." }),
      });
    }
  }
  const ok = checks.every((c) => c.ok);
  input.summary([`### actions-factory doctor: \`${input.agent}\` agent ${ok ? "works" : "has a problem"}`, "", renderChecks(checks), ""].join("\n"));
  return ok;
}
