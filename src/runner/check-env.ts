/** Lines of a multi-line value shorter than this aren't masked: a one-character mask hides that character everywhere (#30). */
const MIN_LINE = 3;

// The dotenv npm package's grammar (v16 `parse()`), as used by the #30 spike.
const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/** Parses `FACTORY_CHECK_ENV`: one `NAME=value` per line, dotenv rules. */
export function parseDotenv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const text = source.replace(/\r\n?/g, "\n");
  LINE.lastIndex = 0;
  for (let m = LINE.exec(text); m !== null; m = LINE.exec(text)) {
    let value = (m[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    values[m[1]] = value;
  }
  return values;
}

/**
 * The `::add-mask::` commands for every value, escaped so the runner registers exactly the value: `%` first,
 * then CR and LF. A multi-line value is masked one line at a time, never whole.
 */
export function maskCommands(values: Record<string, string>): { commands: string[]; warnings: string[] } {
  const commands: string[] = [];
  const warnings: string[] = [];
  const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const [name, value] of Object.entries(values)) {
    if (value === "") continue;
    if (!/[\r\n]/.test(value)) {
      commands.push(`::add-mask::${escape(value)}`);
      continue;
    }
    value.split(/\r?\n|\r/).forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      if (trimmed.length < MIN_LINE) {
        warnings.push(`::warning::FACTORY_CHECK_ENV ${name} line ${i + 1} is shorter than ${MIN_LINE} characters and is not masked`);
      } else {
        commands.push(`::add-mask::${escape(trimmed)}`);
      }
    });
  }
  return { commands, warnings };
}

/** Removes every known value (and every maskable line of one) from text the factory keeps, such as check output. */
export function scrub(text: string, values: Record<string, string>): string {
  const secrets = Object.values(values)
    .flatMap((v) => [v, ...v.split(/\r?\n|\r/).map((l) => l.trim())])
    .filter((s) => s.length >= MIN_LINE)
    .sort((a, b) => b.length - a.length);
  return secrets.reduce((out, s) => out.split(s).join("***"), text);
}
