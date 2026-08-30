/**
 * Architecture gate: policy admission before dispatch (WORK-007; checkpoint
 * contract POLICY-BEFORE-DISPATCH proof class "static"; acceptance
 * criterion 4).
 *
 * Runs the shared scanner over the REAL src tree:
 *   * the executions authorize branch consults the REQUIRED authorization
 *     seam BEFORE any mutation-port call (no gate, no authorize write —
 *     dispatch is impossible before a policy allow);
 *   * the policies authority fails closed with no configured set
 *     (deny-by-default) and ships no default-allow factory;
 *   * the two seam adapters (executions authorize seam, models dispatch
 *     seam) delegate to the authority — they hold no decision logic.
 *
 * The dynamic halves (denial blocks at CREATED with a durable ledger
 * record; admission ordering; dispatch denials) live in the unit suites and
 * the real-PostgreSQL policy-admission suite; the mutation (discrimination)
 * proofs live in tests/discrimination/policy-admission.discrimination.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  hasCanonicalPolicyGate,
  POLICY_GATE_CANONICAL_PATHS,
  type PolicyGateFile,
  policyBeforeDispatchViolations,
} from "../discrimination/lib/policy-admission";

function loadSourceFiles(root: string, dir: string): PolicyGateFile[] {
  const files: PolicyGateFile[] = [];
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

test("policy admission precedes the authorize write; deny-by-default; no default-allow anywhere", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  expect(hasCanonicalPolicyGate(files)).toBe(true);
  expect(policyBeforeDispatchViolations(files)).toEqual([]);
});

test("the protected surface files exist (scanner sanity)", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  const paths = new Set(files.map((file) => file.path));
  for (const canonical of POLICY_GATE_CANONICAL_PATHS) {
    expect(paths.has(canonical), canonical).toBe(true);
  }
});
