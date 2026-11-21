/** Replaces every known secret value in text the factory keeps, such as a transcript. */
export function scrubValues(text: string, secrets: string[]): string {
  return secrets
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((out, s) => out.split(s).join("***"), text);
}
