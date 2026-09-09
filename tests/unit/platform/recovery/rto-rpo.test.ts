/**
 * Unit tests — the recovery-objectives document and the drill
 * evaluation (WORK-048 / D-07, acceptance criterion 7: "RTO/RPO
 * targets are documented with exact drill evidence for each
 * environment").
 *
 * The repository truth is `deploy/manifests/recovery-targets.json`;
 * these proofs pin the fail-closed parsing/evaluation discipline:
 * every drift (unknown schema, missing environments, unbounded or
 * non-numeric targets, unbounded prose) is a typed error — targets
 * are numbers with measurement procedures, never aspirational prose.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  evaluateDrillAgainstTarget,
  parseRecoveryTargets,
  RecoveryTargetError,
  recoveryTargetFor,
  type RecoveryDrillReport,
} from "../../../../src/platform/recovery/rto-rpo";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPOSITORY_TARGETS = readFileSync(
  resolve(REPO_ROOT, "deploy/manifests/recovery-targets.json"),
  "utf8",
);

const VALID_DOCUMENT = JSON.stringify({
  schemaVersion: 1,
  description: "fixture recovery objectives",
  note: "fixture note",
  targets: {
    local: {
      rtoTargetMs: 900_000,
      rpoTargetMs: 0,
      scope: "local loss",
      measurement: "local drill",
    },
  },
});

describe("recovery-targets parsing (repository truth, fail-closed)", () => {
  test("the repository document loads and covers the environment ladder", () => {
    const document = parseRecoveryTargets(REPOSITORY_TARGETS);
    expect(document.schemaVersion).toBe(1);
    for (const environment of ["local", "ci", "preview", "staging", "production"]) {
      const target = recoveryTargetFor(document, environment);
      expect(target.rtoTargetMs).toBeGreaterThan(0);
      expect(target.rpoTargetMs).toBeGreaterThanOrEqual(0);
      expect(target.scope.length).toBeGreaterThan(0);
      expect(target.measurement.length).toBeGreaterThan(0);
    }
  });

  test("a valid document parses with frozen targets", () => {
    const document = parseRecoveryTargets(VALID_DOCUMENT);
    expect(document.targets.local?.rtoTargetMs).toBe(900_000);
    expect(Object.isFrozen(document.targets)).toBe(true);
    expect(Object.isFrozen(document.targets.local)).toBe(true);
  });

  test("malformed documents fail closed with the typed error", () => {
    const cases: readonly [string, string][] = [
      ["not json", "{invalid"],
      ["not an object", "[]"],
      ["wrong schema version", JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), schemaVersion: 2 })],
      ["missing description", JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), description: "" })],
      ["missing note", JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), note: undefined })],
      [
        "empty targets",
        JSON.stringify({
          schemaVersion: 1,
          description: "d",
          note: "n",
          targets: {},
        }),
      ],
      [
        "non-numeric RTO",
        JSON.stringify({
          ...JSON.parse(VALID_DOCUMENT),
          targets: { local: { rtoTargetMs: "soon", rpoTargetMs: 0, scope: "s", measurement: "m" } },
        }),
      ],
      [
        "zero RTO",
        JSON.stringify({
          ...JSON.parse(VALID_DOCUMENT),
          targets: { local: { rtoTargetMs: 0, rpoTargetMs: 0, scope: "s", measurement: "m" } },
        }),
      ],
      [
        "negative RPO",
        JSON.stringify({
          ...JSON.parse(VALID_DOCUMENT),
          targets: { local: { rtoTargetMs: 1, rpoTargetMs: -1, scope: "s", measurement: "m" } },
        }),
      ],
      [
        "out-of-bound RTO",
        JSON.stringify({
          ...JSON.parse(VALID_DOCUMENT),
          targets: { local: { rtoTargetMs: 10 ** 12, rpoTargetMs: 0, scope: "s", measurement: "m" } },
        }),
      ],
      [
        "unbounded prose",
        JSON.stringify({
          ...JSON.parse(VALID_DOCUMENT),
          targets: {
            local: { rtoTargetMs: 1, rpoTargetMs: 0, scope: "x".repeat(501), measurement: "m" },
          },
        }),
      ],
      [
        "missing measurement",
        JSON.stringify({
          ...JSON.parse(VALID_DOCUMENT),
          targets: { local: { rtoTargetMs: 1, rpoTargetMs: 0, scope: "s" } },
        }),
      ],
    ];
    for (const [name, source] of cases) {
      expect(() => parseRecoveryTargets(source), name).toThrow(RecoveryTargetError);
    }
  });

  test("recoveryTargetFor fails closed for unknown environments", () => {
    const document = parseRecoveryTargets(VALID_DOCUMENT);
    expect(() => recoveryTargetFor(document, "production")).toThrow(
      /no recovery target is defined for environment "production"/,
    );
  });
});

describe("drill objective evaluation (measured claims, never prose)", () => {
  const target = {
    rtoTargetMs: 1000,
    rpoTargetMs: 100,
    scope: "fixture",
    measurement: "fixture",
  };

  const reportOf = (overrides: Partial<RecoveryDrillReport>): RecoveryDrillReport => ({
    scenarioId: "fixture",
    environment: "local",
    revision: "fixture",
    startedAt: "2026-09-09T00:00:00.000Z",
    finishedAt: "2026-09-09T00:00:02.000Z",
    phases: [
      {
        name: "phase",
        description: null,
        startedAt: "2026-09-09T00:00:00.000Z",
        finishedAt: "2026-09-09T00:00:01.000Z",
        durationMs: 1000,
        ok: true,
        error: null,
      },
    ],
    rtoMs: 500,
    rpoMs: 50,
    recovered: true,
    ...overrides,
  });

  test("a verified drill within target has zero breaches", () => {
    const evaluation = evaluateDrillAgainstTarget(reportOf({}), target);
    expect(evaluation.rtoWithinTarget).toBe(true);
    expect(evaluation.rpoWithinTarget).toBe(true);
    expect(evaluation.breaches).toEqual([]);
  });

  test("breached measurements are reported by name with the numbers", () => {
    const evaluation = evaluateDrillAgainstTarget(reportOf({ rtoMs: 2000, rpoMs: 200 }), target);
    expect(evaluation.rtoWithinTarget).toBe(false);
    expect(evaluation.rpoWithinTarget).toBe(false);
    expect(evaluation.breaches.join(" ")).toContain("measured RTO 2000ms exceeds the 1000ms target");
    expect(evaluation.breaches.join(" ")).toContain("measured RPO 200ms exceeds the 100ms target");
  });

  test("an unverified drill never declares objectives met (unmeasured RTO is a breach)", () => {
    const evaluation = evaluateDrillAgainstTarget(
      reportOf({ recovered: false, rtoMs: null }),
      target,
    );
    expect(evaluation.rtoWithinTarget).toBe(false);
    expect(evaluation.breaches.join(" ")).toContain("did not verify recovery");
    expect(evaluation.breaches.join(" ")).toContain("RTO was not measured");
  });

  test("a zero-loss scenario without an RPO anchor reports the unmeasured RPO", () => {
    const evaluation = evaluateDrillAgainstTarget(reportOf({ rpoMs: null }), target);
    expect(evaluation.rpoWithinTarget).toBe(false);
    expect(evaluation.breaches.join(" ")).toContain("RPO was not measured");
  });
});
