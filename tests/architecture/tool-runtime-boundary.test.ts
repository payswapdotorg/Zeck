/**
 * Architecture gate: the governed tool runtime boundary (WORK-010;
 * checkpoint contracts POLICY-BEFORE-DISPATCH, EXTERNAL-SIDE-EFFECTS,
 * EXECUTION-PROVENANCE, BUDGET-INTEGRITY, TENANT-ISOLATION — proof class
 * "static").
 *
 * Runs the shared scanner over the REAL src tree:
 *   * the admission chain order is pinned (tenant/scope → registry →
 *     POLICY gate → budget (fail-closed for costed tools) → capability →
 *     dispatch) — no gate, no dispatch;
 *   * the durable intent + canonical ledger events surround the adapter
 *     execution (§14 intent-before-effect; execution ledger evidence);
 *   * the three authority seams are REQUIRED and their adapters delegate
 *     to the real authorities (no second policy engine, no second
 *     capability registry, no second ledger);
 *   * the tools module ships no default-allow admission, no no-op ledger,
 *     never imports models/agents and never references the executions
 *     tables.
 *
 * The dynamic halves live in tests/unit/tools and
 * tests/integration/postgres/tools-*; the mutation (discrimination)
 * proofs live in tests/discrimination/tool-runtime.discrimination.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  hasCanonicalToolRuntime,
  TOOL_RUNTIME_CANONICAL_PATHS,
  type ToolBoundaryFile,
  toolRuntimeViolations,
} from "../discrimination/lib/tool-runtime";

function loadSourceFiles(root: string, dir: string): ToolBoundaryFile[] {
  const files: ToolBoundaryFile[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...loadSourceFiles(root, relative));
    } else if (entry.name.endsWith(".ts")) {
      files.push({ path: relative, content: readFileSync(join(root, relative), "utf8") });
    }
  }
  return files;
}

test("the governed tool runtime keeps every authority boundary (admission order, durable intent, canonical ledger, required seams)", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  expect(hasCanonicalToolRuntime(files)).toBe(true);
  const violations = toolRuntimeViolations(files);
  expect(violations).toEqual([]);
});

test("the protected surface files exist (scanner sanity)", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  const paths = new Set(files.map((file) => file.path));
  for (const canonical of TOOL_RUNTIME_CANONICAL_PATHS) {
    expect(paths.has(canonical), canonical).toBe(true);
  }
});

test("the tools module stays model/agent-independent (deterministic-first, no provider fabric dependency)", () => {
  const files = loadSourceFiles(process.cwd(), "src/modules/tools");
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) {
    expect(file.content, file.path).not.toMatch(/models\/public|agents\/public/);
    // No provider SDK leakage into the tools module.
    expect(file.content, file.path).not.toMatch(
      /from ["'](openai|@anthropic-ai|groq-sdk|@mistralai|cohere-ai)["']/,
    );
  }
});

test("tool adapters are structurally incapable of authority mutation (the dispatch shape carries no authority surface)", () => {
  const files = loadSourceFiles(process.cwd(), "src/modules/tools/ports");
  const adapterPort = files.find((file) => file.path.endsWith("tool-adapter.ts"));
  expect(adapterPort).toBeDefined();
  // Comments may MENTION authority; the TYPE SHAPES may not carry it.
  const codeOnly = (adapterPort?.content ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // The adapter receives ONLY (dispatch, context) and returns observations.
  expect(codeOnly).toContain("execute(dispatch: ToolDispatch, context: ToolDispatchContext)");
  // The dispatch/context shapes carry no stores, services or authority handles.
  expect(codeOnly).not.toMatch(/Store\b|Service\b|Authority\b|Ledger\b/);
});
