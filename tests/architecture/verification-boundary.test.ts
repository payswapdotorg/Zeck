/**
 * Architecture gate: the verification authority boundary (WORK-013;
 * checkpoint contracts VERIFICATION-SEPARATION, POLICY-BEFORE-DISPATCH,
 * EXECUTION-PROVENANCE, TENANT-ISOLATION, IDENTITY-IDEMPOTENCY,
 * AUTH-PRESERVATION — proof class "static").
 *
 * Runs the shared scanner over the REAL src tree:
 *   * the admission chain order is pinned (tenant/scope binding → POLICY
 *     gate with fail-closed denial → durable intent + canonical ledger
 *     event → evaluation) — no gate, no evaluation;
 *   * the conclusion evidence (journal + ledger envelope) precedes the
 *     completion transition, which happens only under criteriaMet;
 *   * INCONCLUSIVE is never coerced to PASS; revision binding is
 *     load-bearing; human evaluation is policy-gated and attributable;
 *     candidate comparison is planner-gated with explicit selection;
 *   * the model-judge adapter maps only criterion-BOUND judgments
 *     (provider success / self-certification can never produce PASS);
 *   * the module ships no default-allow admission, no executions-table
 *     access, no policy authority, no execution lifecycle vocabulary
 *     (no second state machine), no provider identifiers in domain
 *     contracts, and its deterministic evaluators import no models
 *     surface.
 *
 * The dynamic halves live in tests/unit/verification and
 * tests/integration/postgres/verification-*; the mutation (discrimination)
 * proofs live in tests/discrimination/verification-authority.discrimination.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  hasCanonicalVerificationAuthority,
  VERIFICATION_CANONICAL_PATHS,
  type VerificationBoundaryFile,
  verificationAuthorityViolations,
} from "../discrimination/lib/verification-authority";

function loadSourceFiles(root: string, dir: string): VerificationBoundaryFile[] {
  const files: VerificationBoundaryFile[] = [];
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

test("the verification authority keeps every boundary (admission order, durable intent, canonical ledger, evidence-before-completion, no second authority)", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  expect(hasCanonicalVerificationAuthority(files)).toBe(true);
  const violations = verificationAuthorityViolations(files);
  expect(violations).toEqual([]);
});

test("the protected surface files exist (scanner sanity)", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  const paths = new Set(files.map((file) => file.path));
  for (const canonical of VERIFICATION_CANONICAL_PATHS) {
    expect(paths.has(canonical), canonical).toBe(true);
  }
});

test("the verification step-event vocabulary is owned by the executions module (single event-vocabulary authority)", () => {
  const eventDomain = readFileSync(
    join(process.cwd(), "src/modules/executions/domain/event.ts"),
    "utf8",
  );
  for (const command of [
    "verification-requested",
    "verification-recorded",
    "human-evaluation-requested",
    "human-decision-recorded",
    "comparison-recorded",
  ]) {
    expect(eventDomain.includes(`"${command}"`), command).toBe(true);
  }
  // And the verification module produces them only through the ledger
  // seam (no direct envelope writes).
  const files = loadSourceFiles(process.cwd(), "src/modules/verification");
  for (const file of files) {
    expect(file.content.includes("appendEvent"), file.path).toBe(false);
  }
});
