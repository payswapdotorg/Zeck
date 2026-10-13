/**
 * Unit: the outcome-latency typed-facts plane (executions module domain,
 * ACR-010 §2; work order PCL-001 — the per-failure-class evidence
 * plane).
 *
 * Covers EXHAUSTIVELY: every closed-vocabulary member (the acceptance
 * matrices loop over the frozen arrays), every fail-closed boundary
 * (unknown members, out-of-bound values, incoherent shapes — each with
 * the exact reason), the provenance incoherence rejections, the digest
 * determinism (byte-identical re-runs, permuted input order, pinned
 * canonical form, injected digest), and the absence-equivalence
 * discipline (undefined and null are BOTH the absent spelling).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  AttemptCensus,
  OutcomeLatencyFacts,
  OutcomeLatencyLeg,
  OutcomeRecordIdentity,
} from "../../../src/modules/executions/domain/outcome-latency-facts";
import {
  CLOCK_DISCIPLINES,
  canonicalOutcomeLatencyJson,
  checkOutcomeLatencyBoundary,
  DISPATCH_COOLDOWN_KINDS,
  MAX_ATTEMPT_COUNT,
  MAX_LATENCY_MS,
  MAX_LEGS,
  MAX_PLAN_REVISION,
  MAX_VERIFICATION_RESULT_REFS,
  MEASUREMENT_KINDS,
  OUTCOME_CLASSES,
  OUTCOME_FAILURE_CLASSES,
  outcomeLatencyFactsIdentity,
  PROGRESS_DELIVERY_MODES,
  VERIFICATION_PROOF_KINDS,
  VERIFICATION_PROOF_OUTCOMES,
  validateOptionalOutcomeLatencyFacts,
  validateOutcomeLatencyFacts,
} from "../../../src/modules/executions/domain/outcome-latency-facts";

const sha256 = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

/** A clean route leg (no failure encountered — the absent failure class). */
const cleanLeg: OutcomeLatencyLeg = {
  legId: "dispatch-1",
  route: { provider: "neutral-a", model: "model-a" },
  firstByte: { kind: "measured", milliseconds: 120 },
  completion: { kind: "measured", milliseconds: 340 },
};

/** A timed-out route leg (completion honestly NOT RUN with an owner). */
const timeoutLeg: OutcomeLatencyLeg = {
  legId: "dispatch-1",
  route: { provider: "neutral-a", model: "model-a" },
  failureClass: "provider-timeout",
  firstByte: { kind: "measured", milliseconds: 30000 },
  completion: { kind: "not-run", owner: "execution adapter" },
};

/** A failed fallback route leg. */
const fallbackLeg: OutcomeLatencyLeg = {
  legId: "dispatch-2",
  route: { provider: "neutral-b", model: "model-b" },
  failureClass: "provider-5xx",
  firstByte: { kind: "measured", milliseconds: 400 },
  completion: { kind: "measured", milliseconds: 900 },
};

/** A coherent succeeded-first-attempt fixture (event-stream, one clean leg). */
const firstAttemptFacts: OutcomeLatencyFacts = {
  outcomeClass: "succeeded-first-attempt",
  legs: [cleanLeg],
  attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 2 },
  progress: { mode: "event-stream", cooldownAtDispatch: { kind: "none" } },
  cost: {
    totalIncludingDuplicates: {
      kind: "measured",
      microUsd: "1250",
      source: "execution settlement ledger",
    },
    verification: { kind: "measured", microUsd: "80", source: "verification journal" },
  },
  resolved: true,
  verification: { kind: "proved", outcome: "pass", resultIds: ["vr-1"] },
  basis: {
    executionId: "exec-0001",
    route: { provider: "neutral-a", model: "model-a" },
    revision: 3,
    clockDiscipline: "wall-clock",
  },
};

/** A coherent failed-terminal fixture (a timeout leg, a 5xx fallback leg, polled). */
const failedTerminalFacts: OutcomeLatencyFacts = {
  outcomeClass: "failed-terminal",
  legs: [timeoutLeg, fallbackLeg],
  attemptCensus: { original: 1, retry: 0, fallback: 1, verification: 0, attempts: 2 },
  progress: {
    mode: "polled",
    pollingInterval: { kind: "measured", milliseconds: 250 },
    cooldownAtDispatch: { kind: "active", failureClass: "provider-throttle", remainingMs: 45000 },
  },
  cost: {
    totalIncludingDuplicates: {
      kind: "measured",
      microUsd: "3100",
      source: "execution settlement ledger",
    },
    verification: { kind: "not-run", owner: "verification service" },
  },
  resolved: false,
  verification: { kind: "not-run", owner: "verification service" },
  basis: {
    executionId: "exec-0002",
    route: { provider: "neutral-a", model: "model-a" },
    revision: 7,
    clockDiscipline: "monotonic",
  },
};

/** A census coherent with the given outcome class (the plain meanings). */
function censusFor(outcomeClass: string): AttemptCensus {
  if (outcomeClass === "succeeded-first-attempt") {
    return { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 2 };
  }
  if (outcomeClass === "succeeded-after-retry") {
    return { original: 1, retry: 1, fallback: 0, verification: 1, attempts: 3 };
  }
  if (outcomeClass === "succeeded-on-fallback") {
    return { original: 1, retry: 0, fallback: 1, verification: 1, attempts: 3 };
  }
  return { original: 1, retry: 0, fallback: 1, verification: 0, attempts: 2 };
}

function resolvedFor(outcomeClass: string): boolean {
  return outcomeClass !== "failed-terminal";
}

// ---------------------------------------------------------------------------
// The closed vocabularies
// ---------------------------------------------------------------------------

describe("outcome latency facts — the closed vocabularies", () => {
  test("the outcome-class vocabulary is pinned exactly (widening is a reviewed change)", () => {
    expect([...OUTCOME_CLASSES]).toEqual([
      "succeeded-first-attempt",
      "succeeded-after-retry",
      "succeeded-on-fallback",
      "failed-terminal",
    ]);
  });

  test("the per-leg failure-class taxonomy is pinned exactly (the closed seven)", () => {
    expect([...OUTCOME_FAILURE_CLASSES]).toEqual([
      "provider-5xx",
      "provider-timeout",
      "provider-throttle",
      "connection-error",
      "verification-retry",
      "budget-exhausted",
      "policy-denied",
    ]);
  });

  test("the progress-delivery-mode vocabulary is pinned exactly", () => {
    expect([...PROGRESS_DELIVERY_MODES]).toEqual(["event-stream", "polled"]);
  });

  test("the measurement-kind vocabulary is pinned exactly (measured | honest not-run)", () => {
    expect([...MEASUREMENT_KINDS]).toEqual(["measured", "not-run"]);
  });

  test("the verification-proof vocabulary is pinned exactly (proved | not-run)", () => {
    expect([...VERIFICATION_PROOF_KINDS]).toEqual(["proved", "not-run"]);
  });

  test("the verification-proof outcome vocabulary is pinned exactly", () => {
    expect([...VERIFICATION_PROOF_OUTCOMES]).toEqual(["pass", "fail", "inconclusive"]);
  });

  test("the dispatch-cooldown vocabulary is pinned exactly", () => {
    expect([...DISPATCH_COOLDOWN_KINDS]).toEqual(["none", "active"]);
  });

  test("the clock-discipline vocabulary is pinned exactly", () => {
    expect([...CLOCK_DISCIPLINES]).toEqual(["wall-clock", "monotonic"]);
  });

  test("the bounded-value bounds are pinned (typed, unit-bound)", () => {
    expect(MAX_LATENCY_MS).toBe(3_600_000);
    expect(MAX_ATTEMPT_COUNT).toBe(1000);
    expect(MAX_PLAN_REVISION).toBe(2_147_483_647);
    expect(MAX_LEGS).toBe(100);
    expect(MAX_VERIFICATION_RESULT_REFS).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed validation of the closed block — every member, every boundary
// ---------------------------------------------------------------------------

describe("outcome latency facts — fail-closed validation of the closed block", () => {
  test("a non-object is rejected (never a permissive default)", () => {
    expect(validateOutcomeLatencyFacts(null)).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts must be an object (the closed fact block)",
    });
    expect(validateOutcomeLatencyFacts("facts")).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts must be an object (the closed fact block)",
    });
  });

  test("an unknown outcome class fails closed with the exact reason", () => {
    expect(
      validateOutcomeLatencyFacts({ ...firstAttemptFacts, outcomeClass: "succeeded" }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.outcomeClass must be one of succeeded-first-attempt|succeeded-after-retry|succeeded-on-fallback|failed-terminal: succeeded",
    });
    expect(
      validateOutcomeLatencyFacts({ ...firstAttemptFacts, outcomeClass: "completed" as never }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.outcomeClass must be one of succeeded-first-attempt|succeeded-after-retry|succeeded-on-fallback|failed-terminal: completed",
    });
  });

  test("EVERY closed-vocabulary member is accepted (the 4x7x2x2 acceptance matrix)", () => {
    for (const outcomeClass of OUTCOME_CLASSES) {
      for (const failureClass of OUTCOME_FAILURE_CLASSES) {
        for (const mode of PROGRESS_DELIVERY_MODES) {
          for (const clockDiscipline of CLOCK_DISCIPLINES) {
            const facts: OutcomeLatencyFacts = {
              ...firstAttemptFacts,
              outcomeClass,
              legs: [
                {
                  legId: "dispatch-1",
                  route: { provider: "neutral-a", model: "model-a" },
                  failureClass,
                  firstByte: { kind: "measured", milliseconds: 120 },
                  completion: { kind: "measured", milliseconds: 340 },
                },
              ],
              attemptCensus: censusFor(outcomeClass),
              progress:
                mode === "polled"
                  ? {
                      mode,
                      pollingInterval: { kind: "measured", milliseconds: 250 },
                      cooldownAtDispatch: { kind: "none" },
                    }
                  : { mode, cooldownAtDispatch: { kind: "none" } },
              resolved: resolvedFor(outcomeClass),
              basis: { ...firstAttemptFacts.basis, clockDiscipline },
            };
            expect(
              validateOutcomeLatencyFacts(facts),
              `${outcomeClass}/${failureClass}/${mode}/${clockDiscipline}`,
            ).toEqual({ valid: true });
          }
        }
      }
    }
  });

  test("every measurement-kind member is accepted on every latency point", () => {
    for (const kind of MEASUREMENT_KINDS) {
      const firstByte =
        kind === "measured" ? { kind, milliseconds: 111 } : { kind, owner: "execution adapter" };
      const completion =
        kind === "measured" ? { kind, milliseconds: 222 } : { kind, owner: "execution adapter" };
      expect(
        validateOutcomeLatencyFacts({
          ...failedTerminalFacts,
          legs: [
            {
              legId: "dispatch-1",
              route: { provider: "neutral-a", model: "model-a" },
              failureClass: "provider-5xx",
              firstByte,
              completion,
            },
          ],
        }),
        `latency ${kind}`,
      ).toEqual({ valid: true });
      expect(
        validateOutcomeLatencyFacts({
          ...failedTerminalFacts,
          progress: {
            mode: "polled",
            pollingInterval:
              kind === "measured"
                ? { kind, milliseconds: 250 }
                : { kind, owner: "progress transport" },
            cooldownAtDispatch: { kind: "none" },
          },
        }),
        `polling interval ${kind}`,
      ).toEqual({ valid: true });
    }
  });

  test("every cost-line member is accepted on both cost lines", () => {
    for (const kind of MEASUREMENT_KINDS) {
      const line =
        kind === "measured"
          ? { kind, microUsd: "10", source: "execution settlement ledger" }
          : { kind, owner: "execution settlement ledger owner" };
      expect(
        validateOutcomeLatencyFacts({
          ...failedTerminalFacts,
          cost: { totalIncludingDuplicates: line, verification: line },
        }),
        `cost ${kind}`,
      ).toEqual({ valid: true });
    }
  });

  test("every verification-proof member and outcome is accepted", () => {
    for (const outcome of VERIFICATION_PROOF_OUTCOMES) {
      expect(
        validateOutcomeLatencyFacts({
          ...firstAttemptFacts,
          verification: { kind: "proved", outcome, resultIds: ["vr-1"] },
        }),
        `proved ${outcome}`,
      ).toEqual({ valid: true });
    }
    expect(
      validateOutcomeLatencyFacts({
        ...failedTerminalFacts,
        verification: { kind: "not-run", owner: "verification service" },
      }),
    ).toEqual({ valid: true });
  });

  test("every dispatch-cooldown member is accepted", () => {
    for (const kind of DISPATCH_COOLDOWN_KINDS) {
      const cooldownAtDispatch =
        kind === "none"
          ? { kind }
          : { kind, failureClass: "provider-throttle", remainingMs: 45000 };
      expect(
        validateOutcomeLatencyFacts({
          ...failedTerminalFacts,
          progress: {
            mode: "polled",
            pollingInterval: { kind: "measured", milliseconds: 250 },
            cooldownAtDispatch,
          },
        }),
        `cooldown ${kind}`,
      ).toEqual({ valid: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The legs plane — per-leg latencies and the failure-class taxonomy
// ---------------------------------------------------------------------------

describe("outcome latency facts — the route legs", () => {
  test("legs must be an array", () => {
    expect(validateOutcomeLatencyFacts({ ...firstAttemptFacts, legs: "dispatch-1" })).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts.legs must be an array of route legs",
    });
  });

  test("the leg census is bounded", () => {
    const legs = Array.from({ length: MAX_LEGS + 1 }, (_, index) => ({
      legId: `dispatch-${index}`,
      route: { provider: "neutral-a", model: "model-a" },
      firstByte: { kind: "measured", milliseconds: 120 },
      completion: { kind: "measured", milliseconds: 340 },
    }));
    expect(validateOutcomeLatencyFacts({ ...firstAttemptFacts, legs })).toEqual({
      valid: false,
      reason: `outcomeLatencyFacts.legs must hold at most ${MAX_LEGS} route legs (bounded): ${MAX_LEGS + 1}`,
    });
  });

  test("an empty leg census is representable (a pre-dispatch policy denial met no route)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...failedTerminalFacts,
        legs: [],
        attemptCensus: { original: 0, retry: 0, fallback: 0, verification: 0, attempts: 0 },
      }),
    ).toEqual({ valid: true });
  });

  test("a leg's failure class is ABSENT when it met no failure (undefined and null both spell it)", () => {
    expect(validateOutcomeLatencyFacts({ ...failedTerminalFacts, legs: [cleanLeg] })).toEqual({
      valid: true,
    });
    expect(
      validateOutcomeLatencyFacts({
        ...failedTerminalFacts,
        legs: [{ ...cleanLeg, failureClass: undefined }],
      }),
    ).toEqual({ valid: true });
    expect(
      validateOutcomeLatencyFacts({
        ...failedTerminalFacts,
        legs: [{ ...cleanLeg, failureClass: null }],
      }),
    ).toEqual({ valid: true });
  });

  test("an unknown leg failure class fails closed naming the leg (never a default)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...failedTerminalFacts,
        legs: [
          {
            ...timeoutLeg,
            failureClass: "provider-503",
          } as never,
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.legs[legId=dispatch-1].failureClass must be one of provider-5xx|provider-timeout|provider-throttle|connection-error|verification-retry|budget-exhausted|policy-denied: provider-503",
    });
  });

  test("every taxonomy member is accepted on a leg (the closed seven, exhaustively)", () => {
    for (const failureClass of OUTCOME_FAILURE_CLASSES) {
      expect(
        validateOutcomeLatencyFacts({
          ...failedTerminalFacts,
          legs: [{ ...timeoutLeg, failureClass } as never],
        }),
        failureClass,
      ).toEqual({ valid: true });
    }
  });

  test("leg identity and route slugs are bounded and neutral (fail-closed)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [{ ...cleanLeg, legId: "" }],
      }),
    ).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts.legs.legId must be a bounded non-empty identity (<=128): ",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [{ ...cleanLeg, route: { provider: "Neutral_A", model: "model-a" } }],
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.legs[legId=dispatch-1].route.provider must be a neutral route slug: Neutral_A",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [{ ...cleanLeg, route: { provider: "neutral-a", model: 7 } }],
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.legs[legId=dispatch-1].route.model must be a neutral route slug: 7",
    });
  });

  test("duplicate leg ids are rejected (the leg census reconciles by identity)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...failedTerminalFacts,
        legs: [timeoutLeg, { ...fallbackLeg, legId: "dispatch-1" }],
      }),
    ).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts.legs must not contain duplicate legId: dispatch-1",
    });
  });

  test("per-leg latency points are bounded, non-negative and finite (fail-closed)", () => {
    for (const milliseconds of [-1, NaN, Number.POSITIVE_INFINITY, "120", MAX_LATENCY_MS + 1]) {
      const verdict = validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [{ ...cleanLeg, firstByte: { kind: "measured", milliseconds } }],
      });
      expect(verdict.valid, `milliseconds ${String(milliseconds)}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        "outcomeLatencyFacts.legs[legId=dispatch-1].firstByte.milliseconds",
      );
      expect(verdict.valid === false && verdict.reason).toContain("must be a finite number in");
    }
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [{ ...cleanLeg, firstByte: { kind: "measured", milliseconds: 0 } }],
      }),
    ).toEqual({ valid: true });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [
          {
            ...cleanLeg,
            firstByte: { kind: "measured", milliseconds: MAX_LATENCY_MS },
          },
        ],
      }),
    ).toEqual({ valid: true });
  });

  test("an unknown measurement kind fails closed (never a default, never estimated)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [{ ...cleanLeg, firstByte: { kind: "estimated", milliseconds: 120 } }],
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.legs[legId=dispatch-1].firstByte.kind must be one of measured|not-run: estimated",
    });
  });

  test("the incoherent measurement shapes are rejected (measured carries no owner; not-run carries no milliseconds)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [
          {
            ...cleanLeg,
            firstByte: {
              kind: "measured",
              milliseconds: 120,
              owner: "execution adapter",
            } as never,
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.legs[legId=dispatch-1].firstByte: measured cannot carry an owner (the incoherent shape is rejected)",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        legs: [
          {
            ...cleanLeg,
            completion: { kind: "not-run", owner: "x", milliseconds: 5 } as never,
          },
        ],
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.legs[legId=dispatch-1].completion: not-run cannot carry milliseconds (the incoherent shape is rejected)",
    });
  });

  test("a not-run owner is bounded and non-empty (the honest unavailable state names its owner)", () => {
    const verdict = validateOutcomeLatencyFacts({
      ...failedTerminalFacts,
      legs: [{ ...timeoutLeg, completion: { kind: "not-run", owner: "" } }],
    });
    expect(verdict).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.legs[legId=dispatch-1].completion.owner must be a bounded non-empty owner (<=200): ",
    });
  });
});

// ---------------------------------------------------------------------------
// The attempt census — the duplicate-attempt truth, reconciled exactly
// ---------------------------------------------------------------------------

describe("outcome latency facts — the attempt census", () => {
  test("census counters are integers in bounds (fail-closed)", () => {
    for (const [field, value] of [
      ["original", -1],
      ["retry", 1.5],
      ["fallback", Number.MAX_SAFE_INTEGER],
      ["verification", "1"],
      ["attempts", NaN],
    ] as const) {
      const verdict = validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        attemptCensus: { ...firstAttemptFacts.attemptCensus, [field]: value } as never,
      });
      expect(verdict.valid, `${field}=${String(value)}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        `outcomeLatencyFacts.attemptCensus.${field}`,
      );
    }
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        attemptCensus: {
          original: MAX_ATTEMPT_COUNT,
          retry: 0,
          fallback: 0,
          verification: 0,
          attempts: MAX_ATTEMPT_COUNT,
        },
      }),
    ).toEqual({ valid: true });
  });

  test("the outcome census reconciles EXACTLY (attempts = original + retry + fallback + verification)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 5 },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.attemptCensus.attempts must equal original + retry + fallback + verification (the exact outcome-census reconciliation — no failure hiding): attempts=5, original+retry+fallback+verification=2",
    });
  });

  test("an outcome class incoherent with the census is rejected typed (the plain meanings)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        attemptCensus: { original: 1, retry: 1, fallback: 0, verification: 1, attempts: 3 },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.outcomeClass succeeded-first-attempt is incoherent with the attempt census (retry and fallback must be 0 — a first-attempt success retried or fell back nothing): retry=1, fallback=0",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        outcomeClass: "succeeded-after-retry",
        resolved: true,
        attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 2 },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.outcomeClass succeeded-after-retry is incoherent with the attempt census (retry must be >= 1 and fallback must be 0 — a success on fallback is succeeded-on-fallback): retry=0, fallback=0",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        outcomeClass: "succeeded-on-fallback",
        resolved: true,
        attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 2 },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.outcomeClass succeeded-on-fallback is incoherent with the attempt census (fallback must be >= 1): fallback=0",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        outcomeClass: "succeeded-after-retry",
        resolved: true,
        attemptCensus: { original: 1, retry: 1, fallback: 1, verification: 0, attempts: 3 },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.outcomeClass succeeded-after-retry is incoherent with the attempt census (retry must be >= 1 and fallback must be 0 — a success on fallback is succeeded-on-fallback): retry=1, fallback=1",
    });
  });

  test("a terminal failure carries no census constraint (any honest census, including all zeros)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...failedTerminalFacts,
        attemptCensus: { original: 3, retry: 2, fallback: 1, verification: 0, attempts: 6 },
      }),
    ).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// The progress-delivery mechanics and the cost truth
// ---------------------------------------------------------------------------

describe("outcome latency facts — progress delivery, cooldown and cost", () => {
  test("an unknown progress mode fails closed", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        progress: { ...firstAttemptFacts.progress, mode: "streaming" },
      }),
    ).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts.progress.mode must be one of event-stream|polled: streaming",
    });
  });

  test("polled REQUIRES the interval actually applied; event-stream FORBIDS it", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        progress: {
          mode: "polled",
          pollingInterval: undefined,
          cooldownAtDispatch: { kind: "none" },
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.progress.pollingInterval is required when progress.mode is polled (the interval actually applied): absent",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        progress: {
          mode: "polled",
          pollingInterval: null,
          cooldownAtDispatch: { kind: "none" },
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.progress.pollingInterval is required when progress.mode is polled (the interval actually applied): absent",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        progress: {
          mode: "event-stream",
          pollingInterval: { kind: "measured", milliseconds: 100 },
          cooldownAtDispatch: { kind: "none" },
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.progress.pollingInterval cannot ride progress.mode event-stream (the incoherent shape is rejected — event streams are not polled)",
    });
  });

  test("event-stream accepts both absence spellings for the interval", () => {
    for (const pollingInterval of [undefined, null]) {
      expect(
        validateOutcomeLatencyFacts({
          ...firstAttemptFacts,
          progress: { mode: "event-stream", pollingInterval, cooldownAtDispatch: { kind: "none" } },
        }),
        `interval ${String(pollingInterval)}`,
      ).toEqual({ valid: true });
    }
  });

  test("the cooldown state at dispatch is closed and bounded", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        progress: { mode: "event-stream", cooldownAtDispatch: { kind: "paused" } },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.progress.cooldownAtDispatch.kind must be one of none|active: paused",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        progress: {
          mode: "event-stream",
          cooldownAtDispatch: {
            kind: "none",
            failureClass: "provider-throttle",
          } as never,
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.progress.cooldownAtDispatch: none cannot carry a failureClass or remainingMs (the incoherent shape is rejected)",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        progress: {
          mode: "event-stream",
          cooldownAtDispatch: { kind: "active", failureClass: "throttle", remainingMs: 5 },
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.progress.cooldownAtDispatch.failureClass must be one of provider-5xx|provider-timeout|provider-throttle|connection-error|verification-retry|budget-exhausted|policy-denied: throttle",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        progress: {
          mode: "event-stream",
          cooldownAtDispatch: {
            kind: "active",
            failureClass: "provider-throttle",
            remainingMs: -1,
          },
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.progress.cooldownAtDispatch.remainingMs must be a finite number in [0, 3600000]: -1",
    });
  });

  test("cost lines are integer micro-USD with an explicit attribution source (the CostClaim discipline)", () => {
    for (const microUsd of ["-5", "1.5", "007", "1000000000000000000", 1250]) {
      const verdict = validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        cost: {
          ...firstAttemptFacts.cost,
          totalIncludingDuplicates: {
            kind: "measured",
            microUsd,
            source: "execution settlement ledger",
          } as never,
        },
      });
      expect(verdict.valid, `microUsd ${String(microUsd)}`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        "outcomeLatencyFacts.cost.totalIncludingDuplicates.microUsd",
      );
    }
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        cost: {
          ...firstAttemptFacts.cost,
          totalIncludingDuplicates: {
            kind: "measured",
            microUsd: "999999999999999999",
            source: "execution settlement ledger",
          },
        },
      }),
    ).toEqual({ valid: true });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        cost: {
          ...firstAttemptFacts.cost,
          totalIncludingDuplicates: { kind: "measured", microUsd: "0", source: "" },
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.cost.totalIncludingDuplicates.source must be a bounded non-empty attribution source (<=200): ",
    });
  });

  test("the incoherent cost-line shapes are rejected", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        cost: {
          ...firstAttemptFacts.cost,
          totalIncludingDuplicates: {
            kind: "measured",
            microUsd: "10",
            source: "ledger",
            owner: "ledger owner",
          } as never,
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.cost.totalIncludingDuplicates: measured cannot carry an owner (the incoherent shape is rejected)",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        cost: {
          ...firstAttemptFacts.cost,
          verification: { kind: "not-run", owner: "x", microUsd: "10" } as never,
        },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.cost.verification: not-run cannot carry microUsd or source (the incoherent shape is rejected)",
    });
  });
});

// ---------------------------------------------------------------------------
// Resolution and verification outcome
// ---------------------------------------------------------------------------

describe("outcome latency facts — resolution and verification outcome", () => {
  test("resolved is a boolean, fail-closed", () => {
    expect(validateOutcomeLatencyFacts({ ...firstAttemptFacts, resolved: "yes" as never })).toEqual(
      {
        valid: false,
        reason:
          "outcomeLatencyFacts.resolved must be a boolean (whether the outcome resolved): yes",
      },
    );
  });

  test("a succeeded outcome records its resolution; a terminal failure never does (no failure hiding)", () => {
    for (const outcomeClass of [
      "succeeded-first-attempt",
      "succeeded-after-retry",
      "succeeded-on-fallback",
    ] as const) {
      expect(
        validateOutcomeLatencyFacts({
          ...firstAttemptFacts,
          outcomeClass,
          attemptCensus: censusFor(outcomeClass),
          resolved: false,
        }),
        outcomeClass,
      ).toEqual({
        valid: false,
        reason: `outcomeLatencyFacts.resolved is incoherent with outcomeClass ${outcomeClass} (a succeeded outcome records resolved=true): resolved=false`,
      });
    }
    expect(validateOutcomeLatencyFacts({ ...failedTerminalFacts, resolved: true })).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.resolved is incoherent with outcomeClass failed-terminal (a terminal failure never records resolved — no failure hiding): resolved=true",
    });
  });

  test("verification is referenced, never duplicated (>= 1 bounded result reference when proved)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        verification: { kind: "partial", outcome: "pass" } as never,
      }),
    ).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts.verification.kind must be one of proved|not-run: partial",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        verification: { kind: "proved", outcome: "PASS", resultIds: ["vr-1"] } as never,
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.verification.outcome must be one of pass|fail|inconclusive: PASS",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        verification: { kind: "proved", outcome: "pass", resultIds: [] },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.verification.resultIds must reference at least one verification result when kind is proved (referenced, never duplicated)",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        verification: { kind: "proved", outcome: "pass", resultIds: ["vr-1", "vr-1"] },
      }),
    ).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts.verification.resultIds must not contain duplicates: vr-1",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        verification: {
          kind: "proved",
          outcome: "pass",
          resultIds: ["vr-1"],
          owner: "verification service",
        } as never,
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.verification: proved cannot carry an owner (the incoherent shape is rejected)",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...failedTerminalFacts,
        verification: {
          kind: "not-run",
          owner: "verification service",
          resultIds: ["vr-1"],
        } as never,
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.verification: not-run cannot carry an outcome or resultIds (the incoherent shape is rejected)",
    });
  });
});

// ---------------------------------------------------------------------------
// The explicit-basis provenance discipline
// ---------------------------------------------------------------------------

describe("outcome latency facts — the explicit-basis provenance discipline", () => {
  test("an unattributed fact is unrepresentable (the CostClaim explicit-basis discipline)", () => {
    const { basis: _basis, ...withoutBasis } = firstAttemptFacts;
    expect(validateOutcomeLatencyFacts(withoutBasis)).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.basis is required on every outcome-latency fact (the explicit-basis CostClaim discipline — an unattributed outcome-latency fact is unrepresentable)",
    });
  });

  test("basis identities, routes and revision are bounded and closed (fail-closed)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        basis: { ...firstAttemptFacts.basis, executionId: "" },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.basis.executionId must be a bounded non-empty identity (<=128): ",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        basis: { ...firstAttemptFacts.basis, route: { provider: "UPPER", model: "model-a" } },
      }),
    ).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts.basis.route.provider must be a neutral route slug: UPPER",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        basis: { ...firstAttemptFacts.basis, revision: -1 },
      }),
    ).toEqual({
      valid: false,
      reason: "outcomeLatencyFacts.basis.revision must be an integer in [0, 2147483647]: -1",
    });
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        basis: { ...firstAttemptFacts.basis, revision: MAX_PLAN_REVISION },
      }),
    ).toEqual({ valid: true });
  });

  test("the clock discipline is closed (an unknown label fails closed, never defaults)", () => {
    expect(
      validateOutcomeLatencyFacts({
        ...firstAttemptFacts,
        basis: { ...firstAttemptFacts.basis, clockDiscipline: "sidereal" },
      }),
    ).toEqual({
      valid: false,
      reason:
        "outcomeLatencyFacts.basis.clockDiscipline must be one of wall-clock|monotonic: sidereal",
    });
    for (const clockDiscipline of CLOCK_DISCIPLINES) {
      expect(
        validateOutcomeLatencyFacts({
          ...firstAttemptFacts,
          basis: { ...firstAttemptFacts.basis, clockDiscipline },
        }),
        clockDiscipline,
      ).toEqual({ valid: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism + content addressing (invariant 5)
// ---------------------------------------------------------------------------

describe("outcome latency facts — determinism and content-addressable identity", () => {
  test("the same facts always produce the byte-identical validation verdict", () => {
    const first = validateOutcomeLatencyFacts(firstAttemptFacts);
    for (let index = 0; index < 5; index += 1) {
      expect(JSON.stringify(validateOutcomeLatencyFacts(firstAttemptFacts))).toBe(
        JSON.stringify(first),
      );
    }
    const rejection = validateOutcomeLatencyFacts({ ...firstAttemptFacts, resolved: false });
    for (let index = 0; index < 5; index += 1) {
      expect(
        JSON.stringify(validateOutcomeLatencyFacts({ ...firstAttemptFacts, resolved: false })),
      ).toBe(JSON.stringify(rejection));
    }
  });

  test("input key order never changes the verdict (fields are addressed by name)", () => {
    const permuted = {
      basis: firstAttemptFacts.basis,
      verification: firstAttemptFacts.verification,
      resolved: firstAttemptFacts.resolved,
      cost: firstAttemptFacts.cost,
      progress: firstAttemptFacts.progress,
      attemptCensus: firstAttemptFacts.attemptCensus,
      legs: firstAttemptFacts.legs,
      outcomeClass: firstAttemptFacts.outcomeClass,
    };
    expect(JSON.stringify(validateOutcomeLatencyFacts(permuted))).toBe(
      JSON.stringify(validateOutcomeLatencyFacts(firstAttemptFacts)),
    );
  });

  test("the canonical form is deterministic and pinned (the tagged tuple)", () => {
    expect(canonicalOutcomeLatencyJson(firstAttemptFacts)).toBe(
      '["executions.outcome-latency-facts","succeeded-first-attempt",[[["completion",[["kind","measured"],["milliseconds",340]]],["firstByte",[["kind","measured"],["milliseconds",120]]],["legId","dispatch-1"],["route",[["model","model-a"],["provider","neutral-a"]]]]],[["attempts",2],["fallback",0],["original",1],["retry",0],["verification",1]],[["cooldownAtDispatch",[["kind","none"]]],["mode","event-stream"]],[["totalIncludingDuplicates",[["kind","measured"],["microUsd","1250"],["source","execution settlement ledger"]]],["verification",[["kind","measured"],["microUsd","80"],["source","verification journal"]]]],true,[["kind","proved"],["outcome","pass"],["resultIds",["vr-1"]]],[["clockDiscipline","wall-clock"],["executionId","exec-0001"],["revision",3],["route",[["model","model-a"],["provider","neutral-a"]]]]]',
    );
    expect(canonicalOutcomeLatencyJson(failedTerminalFacts)).toBe(
      '["executions.outcome-latency-facts","failed-terminal",[[["completion",[["kind","not-run"],["owner","execution adapter"]]],["failureClass","provider-timeout"],["firstByte",[["kind","measured"],["milliseconds",30000]]],["legId","dispatch-1"],["route",[["model","model-a"],["provider","neutral-a"]]]],[["completion",[["kind","measured"],["milliseconds",900]]],["failureClass","provider-5xx"],["firstByte",[["kind","measured"],["milliseconds",400]]],["legId","dispatch-2"],["route",[["model","model-b"],["provider","neutral-b"]]]]],[["attempts",2],["fallback",1],["original",1],["retry",0],["verification",0]],[["cooldownAtDispatch",[["failureClass","provider-throttle"],["kind","active"],["remainingMs",45000]]],["mode","polled"],["pollingInterval",[["kind","measured"],["milliseconds",250]]]],[["totalIncludingDuplicates",[["kind","measured"],["microUsd","3100"],["source","execution settlement ledger"]]],["verification",[["kind","not-run"],["owner","verification service"]]]],false,[["kind","not-run"],["owner","verification service"]],[["clockDiscipline","monotonic"],["executionId","exec-0002"],["revision",7],["route",[["model","model-a"],["provider","neutral-a"]]]]]',
    );
  });

  test("leg order and reference order are never identity (the canonical form sorts them)", () => {
    const reorderedLegs: OutcomeLatencyFacts = {
      ...failedTerminalFacts,
      legs: [...failedTerminalFacts.legs].reverse(),
    };
    expect(canonicalOutcomeLatencyJson(reorderedLegs)).toBe(
      canonicalOutcomeLatencyJson(failedTerminalFacts),
    );
    const reorderedRefs: OutcomeLatencyFacts = {
      ...firstAttemptFacts,
      verification: { kind: "proved", outcome: "pass", resultIds: ["vr-2", "vr-1"] },
    };
    expect(canonicalOutcomeLatencyJson(reorderedRefs)).toBe(
      canonicalOutcomeLatencyJson({
        ...firstAttemptFacts,
        verification: { kind: "proved", outcome: "pass", resultIds: ["vr-1", "vr-2"] },
      }),
    );
  });

  test("absence equivalence at the canonical level: key-omitted, undefined and null render byte-identically", () => {
    const keyOmitted = { ...failedTerminalFacts, legs: [cleanLeg] };
    const undefinedSpelling = {
      ...failedTerminalFacts,
      legs: [{ ...cleanLeg, failureClass: undefined }],
    };
    const nullSpelling = {
      ...failedTerminalFacts,
      legs: [{ ...cleanLeg, failureClass: null }],
    };
    const canonical = canonicalOutcomeLatencyJson(keyOmitted as OutcomeLatencyFacts);
    expect(canonicalOutcomeLatencyJson(undefinedSpelling as OutcomeLatencyFacts)).toBe(canonical);
    expect(canonicalOutcomeLatencyJson(nullSpelling as OutcomeLatencyFacts)).toBe(canonical);
    expect(
      new Set(
        [keyOmitted, undefinedSpelling, nullSpelling].map((facts) =>
          outcomeLatencyFactsIdentity(facts as OutcomeLatencyFacts, sha256),
        ),
      ).size,
    ).toBe(1);
  });

  test("every field participates in the content address (distinct facts → distinct identities)", () => {
    const base = outcomeLatencyFactsIdentity(firstAttemptFacts, sha256);
    const variants: readonly OutcomeLatencyFacts[] = [
      {
        ...firstAttemptFacts,
        outcomeClass: "succeeded-after-retry",
        attemptCensus: censusFor("succeeded-after-retry"),
      },
      {
        ...firstAttemptFacts,
        legs: [{ ...cleanLeg, failureClass: "provider-5xx" }],
      },
      {
        ...firstAttemptFacts,
        attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 0, attempts: 1 },
      },
      { ...firstAttemptFacts, resolved: false, outcomeClass: "failed-terminal" },
      { ...firstAttemptFacts, basis: { ...firstAttemptFacts.basis, executionId: "exec-9999" } },
      { ...firstAttemptFacts, basis: { ...firstAttemptFacts.basis, revision: 4 } },
      { ...firstAttemptFacts, basis: { ...firstAttemptFacts.basis, clockDiscipline: "monotonic" } },
      {
        ...firstAttemptFacts,
        verification: { kind: "proved", outcome: "fail", resultIds: ["vr-1"] },
      },
      {
        ...firstAttemptFacts,
        cost: {
          ...firstAttemptFacts.cost,
          verification: { kind: "measured", microUsd: "81", source: "verification journal" },
        },
      },
      {
        ...firstAttemptFacts,
        legs: [
          {
            ...cleanLeg,
            completion: { kind: "not-run", owner: "execution adapter" },
          },
        ],
      },
    ];
    const identities = new Set([base]);
    for (const variant of variants) {
      const identity = outcomeLatencyFactsIdentity(variant, sha256);
      expect(identity).not.toBe(base);
      identities.add(identity);
    }
    expect(identities.size).toBe(variants.length + 1);
  });

  test("a measured zero and an honest not-run are never the same fact (no placeholder collapse)", () => {
    const measuredZero = canonicalOutcomeLatencyJson({
      ...firstAttemptFacts,
      legs: [{ ...cleanLeg, firstByte: { kind: "measured", milliseconds: 0 } }],
    });
    const notRun = canonicalOutcomeLatencyJson({
      ...firstAttemptFacts,
      legs: [
        {
          ...cleanLeg,
          firstByte: { kind: "not-run", owner: "execution adapter" },
        },
      ],
    });
    expect(measuredZero).not.toBe(notRun);
  });

  test("the identity is the sha256 over the canonical form (deterministic, hex)", () => {
    const identity = outcomeLatencyFactsIdentity(firstAttemptFacts, sha256);
    expect(identity).toBe(sha256(canonicalOutcomeLatencyJson(firstAttemptFacts)));
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(outcomeLatencyFactsIdentity(firstAttemptFacts, sha256)).toBe(identity);
  });

  test("the digest is injected, never ambient (any digest function is legal input)", () => {
    expect(outcomeLatencyFactsIdentity(firstAttemptFacts, () => "digest-of")).toBe("digest-of");
  });
});

// ---------------------------------------------------------------------------
// The attachment-boundary check (pure, no wiring)
// ---------------------------------------------------------------------------

describe("outcome latency facts — the attachment-boundary check", () => {
  const record: OutcomeRecordIdentity = { executionId: "exec-0001", planRevision: 3 };

  test("absence of either side skips the check (absence-equivalent, both spellings)", () => {
    expect(checkOutcomeLatencyBoundary({ facts: undefined, record })).toEqual({
      kind: "skipped",
      reason: "facts-absent",
    });
    expect(checkOutcomeLatencyBoundary({ facts: null, record })).toEqual({
      kind: "skipped",
      reason: "facts-absent",
    });
    expect(checkOutcomeLatencyBoundary({ facts: firstAttemptFacts, record: undefined })).toEqual({
      kind: "skipped",
      reason: "record-absent",
    });
    expect(checkOutcomeLatencyBoundary({ facts: firstAttemptFacts, record: null })).toEqual({
      kind: "skipped",
      reason: "record-absent",
    });
    expect(checkOutcomeLatencyBoundary({ facts: undefined, record: undefined })).toEqual({
      kind: "skipped",
      reason: "both-sides-absent",
    });
  });

  test("a coherent basis attaches (compatible)", () => {
    expect(checkOutcomeLatencyBoundary({ facts: firstAttemptFacts, record })).toEqual({
      kind: "compatible",
    });
  });

  test("both sides are pre-validated fail-closed BEFORE comparison (a malformed side is never compared)", () => {
    const malformedFacts = { ...firstAttemptFacts, outcomeClass: "succeeded" } as never;
    // Even though the execution id ALSO mismatches, the invalid verdict
    // wins — the malformed side is never compared.
    expect(
      checkOutcomeLatencyBoundary({
        facts: malformedFacts,
        record: { executionId: "exec-9999", planRevision: 9 },
      }),
    ).toEqual({
      kind: "invalid",
      side: "facts",
      reason:
        "outcomeLatencyFacts.outcomeClass must be one of succeeded-first-attempt|succeeded-after-retry|succeeded-on-fallback|failed-terminal: succeeded",
    });
    expect(
      checkOutcomeLatencyBoundary({
        facts: firstAttemptFacts,
        record: { executionId: "", planRevision: 3 },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason: "outcomeRecord.executionId must be a bounded non-empty identity (<=128): ",
    });
    expect(
      checkOutcomeLatencyBoundary({
        facts: firstAttemptFacts,
        record: { executionId: "exec-0001", planRevision: -1 },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason: "outcomeRecord.planRevision must be an integer in [0, 2147483647]: -1",
    });
  });

  test("identity mismatches are typed, name BOTH sides, and report in the frozen field order", () => {
    expect(
      checkOutcomeLatencyBoundary({
        facts: firstAttemptFacts,
        record: { executionId: "exec-9999", planRevision: 9 },
      }),
    ).toEqual({
      kind: "incompatible",
      mismatches: [
        {
          field: "execution-id",
          factsBasis: firstAttemptFacts.basis,
          factsValue: "exec-0001",
          recordValue: "exec-9999",
        },
        {
          field: "plan-revision",
          factsBasis: firstAttemptFacts.basis,
          factsValue: "3",
          recordValue: "9",
        },
      ],
    });
    expect(
      checkOutcomeLatencyBoundary({
        facts: firstAttemptFacts,
        record: { executionId: "exec-0001", planRevision: 4 },
      }),
    ).toEqual({
      kind: "incompatible",
      mismatches: [
        {
          field: "plan-revision",
          factsBasis: firstAttemptFacts.basis,
          factsValue: "3",
          recordValue: "4",
        },
      ],
    });
  });

  test("the boundary verdict is byte-identical across re-runs (pure and total)", () => {
    const first = checkOutcomeLatencyBoundary({
      facts: firstAttemptFacts,
      record: { executionId: "exec-9999", planRevision: 9 },
    });
    for (let index = 0; index < 5; index += 1) {
      expect(
        JSON.stringify(
          checkOutcomeLatencyBoundary({
            facts: firstAttemptFacts,
            record: { executionId: "exec-9999", planRevision: 9 },
          }),
        ),
      ).toBe(JSON.stringify(first));
    }
  });
});

// ---------------------------------------------------------------------------
// The optional riding (the seam PCL-002 wires — absence-equivalent)
// ---------------------------------------------------------------------------

describe("outcome latency facts — the optional riding on outcome records", () => {
  test("undefined and null are BOTH the absent spelling — byte-identical valid verdicts", () => {
    expect(validateOptionalOutcomeLatencyFacts(undefined)).toEqual({ valid: true });
    expect(validateOptionalOutcomeLatencyFacts(null)).toEqual({ valid: true });
    expect(JSON.stringify(validateOptionalOutcomeLatencyFacts(undefined))).toBe(
      JSON.stringify(validateOptionalOutcomeLatencyFacts(null)),
    );
  });

  test("a present block is validated fail-closed (present-invalid never rides)", () => {
    expect(validateOptionalOutcomeLatencyFacts(firstAttemptFacts)).toEqual({ valid: true });
    const invalid = { ...firstAttemptFacts, outcomeClass: "succeeded" as never };
    expect(validateOptionalOutcomeLatencyFacts(invalid)).toEqual(
      validateOutcomeLatencyFacts(invalid),
    );
  });
});
