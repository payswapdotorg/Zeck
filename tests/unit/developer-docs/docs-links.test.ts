/**
 * Documentation link integrity (DEP-020 acceptance criterion 5).
 *
 * Walks every markdown file under docs/developer/** and examples/**,
 * plus the machine-readable JSON artifacts, and validates:
 *  - every Markdown link target resolves to an existing file
 *    (relative links resolve from the containing file; external URLs
 *    are out of scope);
 *  - same-file and cross-file anchors resolve to a heading in the
 *    target document;
 *  - code fences are balanced (a broken fence hides content from
 *    renderers and agents alike);
 *  - backtick-quoted REPOSITORY PATHS in the developer docs resolve
 *    to existing files — the critical "read this file" pointers an
 *    agent follows must never dangle.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function walkFiles(root: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        visit(full);
      } else if (extensions.some((extension) => entry.endsWith(extension))) {
        found.push(full);
      }
    }
  };
  visit(root);
  return found;
}

const DOC_FILES = [
  ...walkFiles(join(REPOSITORY_ROOT, "docs", "developer"), [".md"]),
  ...walkFiles(join(REPOSITORY_ROOT, "examples"), [".md"]),
];

/** Extract Markdown links: [text](target) with target ≠ a pure external URL. */
function extractMarkdownLinks(
  content: string,
): { readonly text: string; readonly target: string }[] {
  const links: { text: string; target: string }[] = [];
  const pattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match = pattern.exec(content);
  while (match !== null) {
    const target = match[2]?.trim() ?? "";
    if (
      target.length > 0 &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(target) &&
      !target.startsWith("mailto:")
    ) {
      links.push({ text: match[1] ?? "", target });
    }
    match = pattern.exec(content);
  }
  return links;
}

/** Extract backtick-quoted repository paths from a known-root prefix set. */
function extractBacktickRepoPaths(content: string): string[] {
  const paths: string[] = [];
  const pattern =
    /`((?:docs|src|sdk|examples|tests|deploy|benchmarks|spec|cli|apps)\/[A-Za-z0-9._/-]+)`/g;
  let match = pattern.exec(content);
  while (match !== null) {
    const candidate = match[1];
    if (candidate !== undefined && !candidate.includes("*")) {
      paths.push(candidate);
    }
    match = pattern.exec(content);
  }
  return paths;
}

/** GitHub-style heading anchor (lowercase, spaces → dashes, punctuation dropped). */
function headingAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const heading = /^#{1,6}\s+(.*)$/gm;
  let match = heading.exec(content);
  while (match !== null) {
    const text = match[1] ?? "";
    const anchor = text
      .toLowerCase()
      .replace(/`/g, "")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    if (anchor.length > 0) {
      anchors.add(anchor);
    }
    match = heading.exec(content);
  }
  return anchors;
}

describe("the developer documentation's internal links resolve", () => {
  test("the kit discovered markdown files to check", () => {
    expect(DOC_FILES.length).toBeGreaterThanOrEqual(18);
  });

  for (const file of DOC_FILES) {
    const relative = file.slice(REPOSITORY_ROOT.length + 1);
    test(`links resolve in ${relative}`, () => {
      const content = readFileSync(file, "utf8");
      const problems: string[] = [];

      for (const link of extractMarkdownLinks(content)) {
        const [pathPart, anchor] = link.target.split("#");
        if (pathPart === undefined) {
          continue;
        }
        if (pathPart.length === 0) {
          // Same-file anchor.
          if (anchor !== undefined && !headingAnchors(content).has(anchor)) {
            problems.push(`anchor #${anchor} not found in the same file`);
          }
          continue;
        }
        const resolved = resolve(dirname(file), pathPart);
        if (!existsSync(resolved)) {
          problems.push(`link target does not exist: ${link.target}`);
          continue;
        }
        if (anchor !== undefined && resolved.endsWith(".md")) {
          const targetContent = readFileSync(resolved, "utf8");
          if (!headingAnchors(targetContent).has(anchor)) {
            problems.push(`anchor #${anchor} not found in ${pathPart}`);
          }
        }
      }

      // Code fences must balance (odd count = unclosed fence).
      const fenceCount = (content.match(/^```/gm) ?? []).length;
      if (fenceCount % 2 !== 0) {
        problems.push(`unbalanced code fences (${fenceCount} fence markers)`);
      }

      expect(problems).toEqual([]);
    });
  }
});

describe("the developer documentation's backtick repository pointers exist", () => {
  const GUIDE_FILES = walkFiles(join(REPOSITORY_ROOT, "docs", "developer"), [".md"]);

  test("the guide set was discovered", () => {
    expect(GUIDE_FILES.length).toBeGreaterThanOrEqual(18);
  });

  for (const file of GUIDE_FILES) {
    const relative = file.slice(REPOSITORY_ROOT.length + 1);
    test(`repo paths exist in ${relative}`, () => {
      const content = readFileSync(file, "utf8");
      const problems: string[] = [];
      for (const repoPath of extractBacktickRepoPaths(content)) {
        if (!existsSync(join(REPOSITORY_ROOT, repoPath))) {
          problems.push(`backtick path does not exist: ${repoPath}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  test("the machine artifacts' cross-reference paths exist", () => {
    const machineDirectory = join(REPOSITORY_ROOT, "docs", "developer", "machine");
    const problems: string[] = [];
    for (const entry of readdirSync(machineDirectory)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const content = readFileSync(join(machineDirectory, entry), "utf8");
      for (const repoPath of extractBacktickRepoPaths(content)) {
        if (!existsSync(join(REPOSITORY_ROOT, repoPath))) {
          problems.push(`${entry}: referenced path does not exist: ${repoPath}`);
        }
      }
      // JSON must parse (schema sanity for the machine layer).
      expect(() => JSON.parse(content)).not.toThrow();
    }
    expect(problems).toEqual([]);
  });
});
