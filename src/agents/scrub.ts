/** Replaces every known secret value in text the factory keeps, such as a transcript. */
export function scrubValues(text: string, secrets: string[]): string {
  return secrets
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((out, s) => out.split(s).join("***"), text);
}

/** Why a CLI failed, safe to keep: scrubbed, on one line (so it can't forge a workflow command), capped at 300 characters. */
export function failureDetail(text: string | undefined, secrets: string[], fallback: string): string {
  const said = scrubValues(text ?? "", secrets).replace(/\s+/g, " ").trim().slice(0, 300);
  return said || fallback;
}
