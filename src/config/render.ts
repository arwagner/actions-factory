import { Document, isPair, isScalar, type Pair, visit } from "yaml";
import type { LoadResult, Root } from "./load.js";
import defs from "./schema/defs.schema.json" with { type: "json" };

const TOP_ORDER = ["schemaVersion", "template", ...Object.keys(defs.$defs.topLevel.properties)];
const TASK_ORDER = Object.keys(defs.$defs.task.properties);

/**
 * The merged config as Markdown for a run summary or `show-config`: the
 * layer stack, any errors, then the config as YAML with each field's layer
 * as a comment. Collapsed unless there are errors.
 */
export function renderConfig(result: LoadResult): string {
  const stack = result.layers.map((l) => l.name).join(" → ") || "no layers";
  const lines = [`<details${result.ok ? "" : " open"}>`, `<summary>Factory config: ${stack}</summary>`, ""];
  if (result.errors.length > 0) {
    lines.push("**Errors**", "");
    for (const e of result.errors) {
      const where = [e.path ? `\`${e.path}\`` : "", e.layer ? `(${e.layer})` : ""].filter(Boolean).join(" ");
      lines.push(`- ${where}: ${e.message}`);
    }
    lines.push("");
  }
  if (Object.keys(result.config).length > 0) {
    lines.push("```yaml", annotatedYaml(result).trimEnd(), "```", "");
  }
  lines.push("</details>");
  return lines.join("\n");
}

function annotatedYaml(result: LoadResult): string {
  const doc = new Document(inSchemaOrder(shortenPaths(result.config, result.roots)));
  visit(doc, {
    Pair(_, pair, path) {
      const keys = [...path.filter(isPair), pair].map((p) => String((p as Pair).key));
      const layer = result.provenance[keys.join(".")];
      if (!layer) return;
      if (isScalar(pair.value)) pair.value.comment = ` ${layer}`;
      else if (isScalar(pair.key)) pair.key.commentBefore = ` ${layer}`;
    },
  });
  return doc.toString({ singleQuote: true, lineWidth: 0 });
}

/** Replaces each checkout's absolute path with its short label, so runner paths don't leak into the summary. */
function shortenPaths<T>(value: T, roots: Root[]): T {
  const byLength = [...roots].sort((a, b) => b.path.length - a.path.length);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const root = byLength.find((r) => v.startsWith(`${r.path}/`));
      return root ? `${root.label}${v.slice(root.path.length)}` : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

function inSchemaOrder(config: Record<string, unknown>): Record<string, unknown> {
  const ordered = sortKeys(config, TOP_ORDER);
  const tasks = ordered.tasks as Record<string, Record<string, unknown>> | undefined;
  if (tasks) {
    ordered.tasks = Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, sortKeys(task, TASK_ORDER)]));
  }
  return ordered;
}

function sortKeys<T extends Record<string, unknown>>(map: T, order: string[]): T {
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => rank(a) - rank(b))) as T;
}
