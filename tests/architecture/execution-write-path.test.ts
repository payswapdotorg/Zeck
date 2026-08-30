/**
 * Architecture gate: execution single-write-path + provenance flow
 * (WORK-006; checkpoint EXECUTION-PROVENANCE proof class "static",
 * acceptance criterion 2 "no alternative write path").
 *
 * Runs the shared scanner over the REAL src tree:
 *   * exactly one execution-row UPDATE site (the SQL adapter's transition
 *     method) and one event INSERT site (appendEvent);
 *   * zero ledger/verification mutation sites;
 *   * zero executions-table references outside the module;
 *   * the transition service is the only caller of the mutation ports —
 *     provenance fields flow only through the single transition path.
 *
 * The physical (dynamic) halves of the same boundary — append-only
 * triggers, gapless sequences, terminal immutability, completion binding —
 * are proven against real PostgreSQL in
 * tests/integration/postgres/executions-schema.test.ts; the mutation
 * (discrimination) proofs live in
 * tests/discrimination/execution-write-path.discrimination.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  executionWritePathViolations,
  hasCanonicalWriteSites,
  type WritePathFile,
} from "../discrimination/lib/execution-write-path";

function loadSourceFiles(root: string, dir: string): WritePathFile[] {
  const files: WritePathFile[] = [];
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

test("execution state has exactly ONE write path; provenance flows only through the transition service", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  // Scanner sanity over the real tree.
  expect(hasCanonicalWriteSites(files)).toBe(true);
  const violations = executionWritePathViolations(files);
  expect(violations).toEqual([]);
});

test("the execution store port exposes no update/delete surface for events or verification results (append-only API)", () => {
  const files = loadSourceFiles(process.cwd(), "src/modules/executions/ports");
  const portSource = files
    .map((f) => f.content)
    .join("\n")
    .replace(/updateExecutionForTransition/g, "");
  const forbidden = /updateEvent|deleteEvent|updateVerification|deleteVerification/;
  expect(forbidden.test(portSource)).toBe(false);
});
