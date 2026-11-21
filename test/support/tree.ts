import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Writes `{ "relative/path": "content" }` into a fresh temp dir and returns its path. */
export function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "factory-test-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
