/**
 * VAL-001 acceptance criterion 5: the cumulative validation report
 * structure exists and separates observed facts, failures, hypotheses,
 * recommendations and NOT RUN boundaries — in the projection AND in the
 * maintained document.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  groupBySection,
  projectReport,
  REPORT_SECTIONS,
  recordHypothesis,
  type SubmissionRecord,
} from "../../../benchmarks/validation";

const REPO_ROOT = join(process.cwd());

const submission: SubmissionRecord = {
  workOrder: "VAL-010",
  baseRevision: "90ceeddd1c6e5553254eaaade3155be391670787",
  finalHead: "1111111111111111111111111111111111111111",
  branch: "work/VAL-010-text-apps",
  pullRequest: 43,
  changedFiles: ["benchmarks/validation/apps/text.ts"],
  battery: [
    { command: "bun run test:unit", outcome: "pass", detail: "all green" },
    { command: "corpus run voice", outcome: "fail", detail: "provider unreachable" },
  ],
  issues: [
    {
      reproduction: "corpus run voice",
      impact: "voice workload unvalidated",
      rootCause: ["external"],
      viableSolutions: ["surface access gap"],
      recommendedSolution: "surface the missing provider access requirement",
      classification: "external-limitation",
      verificationEvidence: "provider run recorded after access arrives",
    },
  ],
  notRun: [{ surface: "voice provider", reason: "no usable test access yet" }],
  evidenceRefs: ["spec/validation-work-orders/VAL-010-evidence.md"],
};

describe("validation: cumulative report projection (VAL-001 AC5)", () => {
  test("the projection separates the five mandated sections", () => {
    const grouped = groupBySection(projectReport([submission]));
    expect(Object.keys(grouped).sort()).toEqual([...REPORT_SECTIONS].sort());
    expect(grouped["observed-facts"].length).toBeGreaterThan(0);
    expect(grouped.failures.length).toBeGreaterThan(0);
    expect(grouped.recommendations.length).toBeGreaterThan(0);
    expect(grouped["not-run"].length).toBeGreaterThan(0);
  });

  test("a failed battery command lands in BOTH facts and failures", () => {
    const grouped = groupBySection(projectReport([submission]));
    expect(grouped["observed-facts"].some((entry) => entry.text.includes("corpus run voice"))).toBe(
      true,
    );
    expect(grouped.failures.some((entry) => entry.text.includes("corpus run voice"))).toBe(true);
  });

  test("every projected entry carries provenance (auditable back to exact evidence)", () => {
    for (const entry of projectReport([submission])) {
      expect(entry.source).toContain("VAL-010@");
    }
  });

  test("a NOT RUN boundary never converts into a pass (discrimination)", () => {
    const grouped = groupBySection(projectReport([submission]));
    const notRun = grouped["not-run"].map((entry) => entry.text);
    expect(notRun.some((text) => text.startsWith("NOT RUN"))).toBe(true);
    expect(notRun.every((text) => text.startsWith("NOT RUN"))).toBe(true);
    expect(notRun.every((text) => !text.includes("outcome: pass"))).toBe(true);
  });

  test("hypotheses are recorded explicitly, never derived from battery output", () => {
    const hypothesis = recordHypothesis(
      "VAL-010@111111111111",
      "cache hit-rate rise may explain the cost drop",
    );
    const grouped = groupBySection([...projectReport([submission]), hypothesis]);
    expect(grouped.hypotheses).toHaveLength(1);
    expect(() => recordHypothesis("source", "")).toThrow();
  });
});

describe("validation: the maintained report document (VAL-001 AC5)", () => {
  test("docs/VALIDATION-REPORT.md carries the five separation sections", () => {
    const text = readFileSync(join(REPO_ROOT, "docs/VALIDATION-REPORT.md"), "utf8");
    expect(text).toContain("## Observed facts");
    expect(text).toContain("## Failures and root causes");
    expect(text).toContain("## Hypotheses (open)");
    expect(text).toContain("## Recommendations");
    expect(text).toContain("## NOT RUN boundaries");
  });

  test("the report document references the validation laboratory and the state authority", () => {
    const text = readFileSync(join(REPO_ROOT, "docs/VALIDATION-REPORT.md"), "utf8");
    expect(text).toContain("benchmarks/validation/");
    expect(text).toContain("spec/validation-state/");
  });
});
