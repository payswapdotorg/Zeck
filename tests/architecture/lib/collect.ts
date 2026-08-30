/** Collect real source files for the architecture tests. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceFile } from "./dependency-rules";

function walk(current: string, prefix: string, out: SourceFile[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const absolute = join(current, entry.name);
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(absolute, relative, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push({ path: relative, content: readFileSync(absolute, "utf8") });
    }
  }
}

/** Collect every TypeScript file under `<root>/src` as POSIX-relative paths. */
export function collectSourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  walk(join(root, "src"), "src", files);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Runtime dependencies declared in package.json (the default-allow list for src/). */
export function declaredRuntimePackages(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {});
}
