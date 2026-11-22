// Builds the GitHub wiki from docs/wiki/ (§13): the hand-written pages, a page per shipped template from its
// README, and the config reference from the JSON schema, each with the "generated, edit there" banner.
//
//   node scripts/wiki.ts <out-dir> <version>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Schema = Record<string, unknown>;

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Schema;

/** The shipped templates, in the order the wiki lists them. */
export const TEMPLATES = ["default", "full", "review-only", "spec-flow"];

/** The sidebar, in the §13 outline's order: [page, title], template pages indented under Templates. */
export const OUTLINE: Array<[string, string]> = [
  ["Home", "Home"],
  ["Getting-started", "Getting started"],
  ["Identity-and-tokens", "Identity and tokens"],
  ["How-it-works", "How it works"],
  ["Templates", "Templates"],
  ...TEMPLATES.map((t): [string, string] => [`Template-${t}`, `Template: ${t}`]),
  ["Customizing", "Customizing"],
  ["Config-reference", "Config reference"],
  ["Agents", "Agents"],
  ["Runner-environment", "Runner environment"],
  ["Schedules-and-limits", "Schedules and limits"],
  ["Safety", "Safety"],
  ["Observability", "Observability"],
  ["Versioning", "Versioning"],
  ["Troubleshooting", "Troubleshooting"],
];

const banner = (version: string, source: string) =>
  `> Generated from \`${source}\` at v${version}. Edit it there: changes made here are overwritten on the next release.\n\n`;

// ---------------------------------------------------------------------------------------------------------------
// Template pages

/** A template's README as a wiki page, with links to other templates' READMEs pointing at their pages. */
export function templatePage(name: string, version: string): string {
  const readme = read(`templates/${name}/README.md`).replace(/\]\(\.\.\/([a-z-]+)\/README\.md\)/g, "](Template-$1)");
  return banner(version, `templates/${name}/README.md`) + readme;
}

// ---------------------------------------------------------------------------------------------------------------
// Config reference

const defs = json("src/config/schema/defs.schema.json").$defs as Record<string, Schema>;

function resolve(schema: Schema): Schema {
  const ref = schema.$ref as string | undefined;
  if (!ref) return schema;
  const name = ref.split("/").pop()!;
  return { ...resolve(defs[name]), ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$ref")) };
}

function typeOf(schema: Schema): string {
  const s = resolve(schema);
  if ("const" in s) return `\`${JSON.stringify(s.const)}\``;
  if (Array.isArray(s.enum)) return s.enum.map((v) => `\`${v}\``).join(" \\| ");
  if (Array.isArray(s.oneOf)) return (s.oneOf as Schema[]).map(typeOf).join(" \\| ");
  if (Array.isArray(s.anyOf)) return (s.anyOf as Schema[]).map(typeOf).join(" \\| ");
  const type = s.type;
  if (Array.isArray(type)) return type.join(" \\| ");
  if (type === "array") return `list of ${typeOf((s.items as Schema) ?? {})}`;
  if (type === "object" && s.additionalProperties && typeof s.additionalProperties === "object") return "map";
  return (type as string | undefined) ?? "any";
}

const cell = (text: unknown) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function table(properties: Record<string, Schema>, prefix = ""): string[] {
  const rows = ["| Field | Type | Default | Description |", "|---|---|---|---|"];
  for (const [name, raw] of Object.entries(properties)) {
    const s = resolve(raw);
    const fallback = "default" in s ? `\`${JSON.stringify(s.default)}\`` : "";
    rows.push(`| \`${prefix}${name}\` | ${typeOf(raw)} | ${fallback} | ${cell(s.description)} |`);
  }
  return rows;
}

/** Every field of `factory.yml` and `template.yml`, with type, default and description, from the schema. */
export function configReference(version: string): string {
  const factory = json("src/config/schema/factory.schema.json");
  const template = json("src/config/schema/template.schema.json");
  const topLevel = defs.topLevel.properties as Record<string, Schema>;
  const task = defs.task.properties as Record<string, Schema>;
  const throttles = (topLevel.throttles as Schema).properties as Record<string, Schema>;
  const schedule = (task.schedule as Schema).properties as Record<string, Schema>;
  const hooks = resolve(task.hooks as Schema).properties as Record<string, Schema>;
  const lines = [
    banner(version, "src/config/schema/").trimEnd(),
    "",
    "Every field of `factory.yml` and `template.yml`. A field you leave out takes its default. Unknown fields are errors. The merge rule and layers are on [Customizing](Customizing).",
    "",
    "## factory.yml",
    "",
    ...table({ ...(factory.properties as Record<string, Schema>), ...topLevel }),
    "",
    "### throttles",
    "",
    ...table(throttles, "throttles."),
    "",
    "## template.yml",
    "",
    "A template's manifest. It can also set every top-level field above (except `schemaVersion` and `template`), as defaults its clients can override.",
    "",
    ...table(template.properties as Record<string, Schema>),
    "",
    "## Tasks: `tasks.<name>`",
    "",
    "In `factory.yml` or a template. Fields left out of a task take the top-level value where there is one (`agent`, `model`, `runsOn`, `container`).",
    "",
    ...table(task),
    "",
    "### schedule",
    "",
    ...table(schedule, "schedule."),
    "",
    "### writes",
    "",
    "What the task's plan may ask the factory to do. Anything not allowed here is refused.",
    "",
    ...table(defs.writes.properties as Record<string, Schema>, "writes."),
    "",
    "### outcomes: `outcomes.<name>`",
    "",
    "The agent picks exactly one outcome per item. Its labels are how one task hands off to the next.",
    "",
    ...table(defs.outcome.properties as Record<string, Schema>),
    "",
    "### hooks",
    "",
    ...table(hooks, "hooks."),
    "",
    "## Labels: `labels.<name>`",
    "",
    ...table(defs.labelSpec.properties as Record<string, Schema>),
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Build

export function buildWiki(out: string, version: string): string[] {
  mkdirSync(out, { recursive: true });
  const pages: string[] = [];
  const write = (page: string, content: string) => {
    writeFileSync(join(out, `${page}.md`), content);
    pages.push(page);
  };
  for (const file of readdirSync(join(root, "docs/wiki")).filter((f) => f.endsWith(".md"))) {
    write(file.replace(/\.md$/, ""), banner(version, `docs/wiki/${file}`) + read(`docs/wiki/${file}`));
  }
  for (const name of TEMPLATES) write(`Template-${name}`, templatePage(name, version));
  write("Config-reference", configReference(version));
  const sidebar = OUTLINE.map(([page, title]) => `${page.startsWith("Template-") ? "  " : ""}- [${title}](${page})`);
  writeFileSync(join(out, "_Sidebar.md"), `${sidebar.join("\n")}\n`);
  return pages;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, version] = process.argv.slice(2);
  if (!out || !version) throw new Error("usage: node scripts/wiki.ts <out-dir> <version>");
  console.log(buildWiki(out, version).join("\n"));
}
