import type { AdapterOutput, FailureDetail } from "./types.js";

/** Replaces every known secret value in text the factory keeps, such as a transcript. */
export function scrubValues(text: string, secrets: string[]): string {
  return secrets
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((out, s) => out.split(s).join("***"), text);
}

/** Classifies an error without copying any part of CLI output into a log or public comment. */
export function failureDetail(text: string | undefined, code: number, kind?: AdapterOutput["failure"]): FailureDetail {
  const message = text ?? "";
  if (kind === "quota" || /\b429\b|too many requests|quota|rate[_ -]?limit|usage[_ ]limit/i.test(message)) return "quota or rate limit";
  if (/\b401\b/.test(message)) return "authentication failed (HTTP 401)";
  if (kind === "auth" || /unauthori[sz]ed|authenticat|(?:invalid|incorrect) (?:API key|(?:access )?token|credential)/i.test(message)) return "authentication failed";
  if (/\b403\b/.test(message)) return "access denied (HTTP 403)";
  if (/access denied|forbidden/i.test(message)) return "access denied";
  if (/\b50[0234]\b|service unavailable|bad gateway/i.test(message)) return "service unavailable";
  return code === 0 ? "CLI reported an error" : `exit ${code}`;
}
