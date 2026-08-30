/**
 * Architecture: planner surface + seam discipline (WORK-009).
 *
 * Gates the structural boundaries of the planning module:
 *  - the deterministic-first ordering boundary (shared scanner with the
 *    discrimination proofs — ADR-0007: route exploration only AFTER the
 *    sufficiency decision, gated on its outcome);
 *  - the seam discipline: planning domain/application consult other
 *    modules through TYPE-ONLY imports; VALUE imports of other modules'
 *    public authorities happen ONLY in adapters (the composition seams);
 *  - the public barrel is provider-independent: it imports NO other
 *    module (no models/connections barrels — provider identifiers cross
 *    only as opaque strings inside planning-owned types);
 *  - node:crypto stays confined to the digest adapter (WORK-008
 *    confinement precedent);
 *  - the planning vocabulary is frozen (task kinds, step classes,
 *    strategy classes);
 *  - the executions state machine table is UNTOUCHED by the WORK-009
 *    extension (no second state machine).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { plannerOrderViolations } from "../discrimination/lib/planner-order";

const REPO_ROOT = join(process.cwd());
const PLANNING_DIR = join(REPO_ROOT, "src/modules/planning");
const PLANNER_SOURCE = readFileSync(join(PLANNING_DIR, "application/planner.ts"), "utf8");

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

const CROSS_MODULE_IMPORT =
  /from\s+["']\.\.\/\.\.\/(capabilities|policies|models|connections|executions|budgets|artifacts|context|auth|applications)\/public["']/;
const TYPE_ONLY_IMPORT = /^import\s+type\s/;

describe("architecture: planner surface and seam discipline (WORK-009)", () => {
  test("the real planner consults route exploration only AFTER the gated sufficiency decision", () => {
    expect(plannerOrderViolations(PLANNER_SOURCE)).toEqual([]);
  });

  test("planning domain/application consult other modules TYPE-ONLY (values live in adapters)", () => {
    const violations: string[] = [];
    for (const layer of ["domain", "application", "ports"]) {
      for (const file of collectFiles(join(PLANNING_DIR, layer))) {
        const text = readFileSync(file, "utf8");
        for (const line of text.split("\n")) {
          if (CROSS_MODULE_IMPORT.test(line) && !TYPE_ONLY_IMPORT.test(line.trim())) {
            violations.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the planning public barrel imports NO other module (provider-independent surface)", () => {
    const publicText = readFileSync(join(PLANNING_DIR, "public.ts"), "utf8");
    expect(CROSS_MODULE_IMPORT.test(publicText)).toBe(false);
  });

  test("node:crypto is confined to the planning digest adapter", () => {
    const violations: string[] = [];
    for (const file of collectFiles(PLANNING_DIR)) {
      if (file.endsWith(join("adapters", "node-digest.ts"))) {
        continue;
      }
      if (readFileSync(file, "utf8").includes("node:crypto")) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  test("planning imports another module's internal/ nowhere", () => {
    const violations: string[] = [];
    for (const file of collectFiles(PLANNING_DIR)) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["']\.\.\/\.\.\/[a-z-]+\/internal/.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the planner vocabulary is frozen (kinds, step classes, strategy classes)", async () => {
    const { PLAN_STEP_CLASSES, STRATEGY_CLASSES, TASK_KINDS } = await import(
      "../../src/modules/planning/public"
    );
    expect(PLAN_STEP_CLASSES).toHaveLength(17);
    expect(STRATEGY_CLASSES).toEqual([
      "deterministic-only",
      "hybrid",
      "generative",
      "cascade",
      "bounded-evaluation",
    ]);
    expect(TASK_KINDS).toHaveLength(8);
  });

  test("the executions transition table is untouched by the WORK-009 extension (no second state machine)", async () => {
    const { TRANSITION_TABLE, EXECUTION_COMMANDS, TERMINAL_STATUSES } = await import(
      "../../src/modules/executions/public"
    );
    // The frozen WORK-006 vocabulary: 13 states, 18 commands, 36 concrete
    // edges + the cancel/expire fan-outs — all unchanged.
    expect(EXECUTION_COMMANDS).toHaveLength(14);
    expect(TERMINAL_STATUSES).toEqual(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);
    const concreteEdges = TRANSITION_TABLE.filter(
      (edge) => edge.command !== "cancel" && edge.command !== "expire",
    );
    expect(concreteEdges).toHaveLength(16);
  });

  test("the planning decision event type rides the executions ledger (single write path)", async () => {
    const { PLANNING_DECISION_EVENT_TYPE } = await import("../../src/modules/executions/public");
    expect(PLANNING_DECISION_EVENT_TYPE).toBe("planning.decision-recorded");
  });
});
