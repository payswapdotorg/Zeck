/**
 * Discrimination: the outcome-latency typed-facts plane (executions module
 * domain, ACR-010 §2; work order PCL-001 — the per-failure-class evidence
 * plane).
 *
 * Proves the weakened protections FAIL (the discrimination discipline —
 * tests/unit proves the happy paths; this suite proves each protection is
 * load-bearing):
 *
 *  - S1 ABSENCE EQUIVALENCE DISCRIMINATED: the three absence spellings
 *    (key-omitted, undefined, null) select byte-identical verdicts at the
 *    optional seam and byte-identical skip verdicts at the boundary — a
 *    spelling difference can never change behavior; plus the fixed-corpus
 *    replay pin (deterministic verdicts, sha256-pinned — the plane is NEW,
 *    so the pinned digest is the capture of THIS module's own verdict
 *    stream; the pre-change behavior it must preserve is the ABSENCE,
 *    pinned by the absence lines and the architecture confinement law).
 *  - S2 THE MUTATION RECORD: every field mutation that would weaken the
 *    plane (unknown vocabulary members, out-of-bounds values, the
 *    non-reconciled census, the incoherent outcome class, a polling
 *    interval riding an event stream, an unattributed basis) is rejected
 *    by pure validation, by the optional seam, and at the boundary — and
 *    each rejection is LOAD-BEARING (the unmutated fixture passes, the
 *    single mutation flips the verdict, naming the field).
 *  - S3 THE BOUNDARY DISCRIMINATION: a malformed side is never compared
 *    (invalid beats mismatched — a hand-rolled weak check that skips
 *    pre-validation produces a misleading mismatch verdict where the pure
 *    check fails closed); identity mismatches name both sides; re-runs
 *    are byte-identical.
 *  - S4 NO SILENT DEFAULTING: unknown enum members never default to a
 *    member; the honest not-run never collapses into a measured zero;
 *    a polling interval on an event stream is rejected, never dropped.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  OutcomeLatencyFacts,
  OutcomeLatencyLeg,
} from "../../src/modules/executions/domain/outcome-latency-facts";
import {
  canonicalOutcomeLatencyJson,
  checkOutcomeLatencyBoundary,
  outcomeLatencyFactsIdentity,
  validateOptionalOutcomeLatencyFacts,
  validateOutcomeLatencyFacts,
} from "../../src/modules/executions/domain/outcome-latency-facts";

const sha256 = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

const cleanLeg: OutcomeLatencyLeg = {
  legId: "dispatch-1",
  route: { provider: "neutral-a", model: "model-a" },
  firstByte: { kind: "measured", milliseconds: 120 },
  completion: { kind: "measured", milliseconds: 340 },
};

const timeoutLeg: OutcomeLatencyLeg = {
  legId: "dispatch-1",
  route: { provider: "neutral-a", model: "model-a" },
  failureClass: "provider-timeout",
  firstByte: { kind: "measured", milliseconds: 30000 },
  completion: { kind: "not-run", owner: "execution adapter" },
};

const validFacts: OutcomeLatencyFacts = {
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

const failedFacts: OutcomeLatencyFacts = {
  ...validFacts,
  outcomeClass: "failed-terminal",
  legs: [
    timeoutLeg,
    {
      legId: "dispatch-2",
      route: { provider: "neutral-b", model: "model-b" },
      failureClass: "provider-5xx",
      firstByte: { kind: "measured", milliseconds: 400 },
      completion: { kind: "measured", milliseconds: 900 },
    },
  ],
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
    ...validFacts.basis,
    executionId: "exec-0002",
    revision: 7,
    clockDiscipline: "monotonic",
  },
};

const record = { executionId: "exec-0001", planRevision: 3 };

describe("discrimination: outcome-latency typed facts (PCL-001 — the evidence plane)", () => {
  // -------------------------------------------------------------------------
  // S1 — absence equivalence discriminated
  // -------------------------------------------------------------------------

  test("S1a the three absence spellings select byte-identical optional-seam verdicts", () => {
    const noKey = validFacts;
    const undefinedSpelling = { ...validFacts, outcomeLatencyFacts: undefined };
    const nullSpelling = { ...validFacts, outcomeLatencyFacts: null };
    const verdicts = [
      validateOptionalOutcomeLatencyFacts(undefined),
      validateOptionalOutcomeLatencyFacts(null),
    ];
    expect(new Set(verdicts.map((verdict) => JSON.stringify(verdict))).size).toBe(1);
    expect(JSON.stringify(verdicts[0])).toBe(JSON.stringify({ valid: true }));
    // The three spellings are indistinguishable to every consumer of the
    // seam — and the surrounding record shape is irrelevant to it.
    expect(noKey).toBeDefined();
    expect(undefinedSpelling.outcomeLatencyFacts).toBeUndefined();
    expect(nullSpelling.outcomeLatencyFacts).toBeNull();
  });

  test("S1b the three absence spellings select byte-identical boundary skip verdicts", () => {
    const verdicts = [
      checkOutcomeLatencyBoundary({ facts: undefined, record }),
      checkOutcomeLatencyBoundary({ facts: null, record }),
      checkOutcomeLatencyBoundary({ facts: undefined, record: undefined }),
      checkOutcomeLatencyBoundary({ facts: null, record: null }),
    ];
    expect(JSON.stringify(verdicts[0])).toBe(JSON.stringify(verdicts[1]));
    expect(JSON.stringify(verdicts[2])).toBe(JSON.stringify(verdicts[3]));
    expect(verdicts[0]).toEqual({ kind: "skipped", reason: "facts-absent" });
    expect(verdicts[2]).toEqual({ kind: "skipped", reason: "both-sides-absent" });
  });

  test("S1c the fixed-corpus replay is deterministic and sha256-pinned (the verdict stream)", () => {
    // The corpus: two valid blocks and every weakening mutation of S2,
    // replayed through the optional seam AND the boundary. The pinned
    // digest captures THIS module's verdict stream (the plane is new —
    // there is no pre-change module to replay; the pre-change behavior
    // preserved is the ABSENCE, pinned by S1a/S1b and the architecture
    // confinement law). Any future drift in any verdict changes the
    // stream and fails this pin.
    const corpus: readonly (OutcomeLatencyFacts | null | undefined)[] = [
      validFacts,
      failedFacts,
      undefined,
      null,
      { ...validFacts, outcomeClass: "succeeded" } as never,
      { ...validFacts, resolved: false },
      {
        ...validFacts,
        attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 5 },
      },
      { ...validFacts, basis: { ...validFacts.basis, executionId: "" } },
      { ...validFacts, basis: { ...validFacts.basis, clockDiscipline: "ambient" } as never },
      {
        ...validFacts,
        cost: {
          ...validFacts.cost,
          verification: { kind: "measured", microUsd: "-1", source: "ledger" } as never,
        },
      },
      {
        ...failedFacts,
        progress: { ...failedFacts.progress, mode: "event-stream", pollingInterval: undefined },
      },
      { ...failedFacts, legs: [{ ...timeoutLeg, failureClass: "provider-503" } as never] },
    ];
    const lines = corpus.map(
      (facts, index) =>
        `${index}\t${JSON.stringify(validateOptionalOutcomeLatencyFacts(facts))}\t${JSON.stringify(
          checkOutcomeLatencyBoundary({ facts, record }),
        )}`,
    );
    expect(lines).toHaveLength(12);
    const replay = () => sha256(`${lines.join("\n")}\n`);
    // Byte-identical across re-computations (pure and total).
    expect(replay()).toBe(replay());
    expect(sha256(`${lines.join("\n")}\n`)).toBe(
      "a6d5524c4c96adb54cf37b972dcd25aafc4824fa3b4a52b2451ca498de7a1589",
    );
  });

  // -------------------------------------------------------------------------
  // S2 — the mutation record (every weakening is rejected, load-bearing)
  // -------------------------------------------------------------------------

  test("S2a the mutation record: each single-field weakening flips the verdict, naming the field", () => {
    // [name, mutation, reason-substring] — the unmutated fixture passes
    // (load-bearing), each mutation is rejected by the pure validator AND
    // the optional seam AND the boundary (invalid side facts).
    const mutations: readonly [string, Record<string, unknown>, string][] = [
      [
        "unknown outcome class",
        { outcomeClass: "succeeded" },
        "outcomeLatencyFacts.outcomeClass must be one of",
      ],
      [
        "unknown failure class",
        { legs: [{ ...timeoutLeg, failureClass: "provider-503" }] },
        "legs[legId=dispatch-1].failureClass must be one of",
      ],
      [
        "unknown progress mode",
        { progress: { mode: "streaming", cooldownAtDispatch: { kind: "none" } } },
        "progress.mode must be one of",
      ],
      [
        "unknown clock discipline",
        { basis: { ...validFacts.basis, clockDiscipline: "ambient" } },
        "basis.clockDiscipline must be one of",
      ],
      [
        "unknown measurement kind",
        { legs: [{ ...cleanLeg, firstByte: { kind: "estimated", milliseconds: 5 } }] },
        "firstByte.kind must be one of",
      ],
      [
        "out-of-bound latency",
        { legs: [{ ...cleanLeg, firstByte: { kind: "measured", milliseconds: -1 } }] },
        "firstByte.milliseconds must be a finite number",
      ],
      [
        "unbounded cost",
        {
          cost: {
            ...validFacts.cost,
            verification: { kind: "measured", microUsd: "1000000000000000000", source: "ledger" },
          },
        },
        "verification.microUsd must be an integer micro-USD string",
      ],
      [
        "the non-reconciled census (failure hiding)",
        { attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 5 } },
        "the exact outcome-census reconciliation",
      ],
      [
        "the incoherent outcome class",
        { attemptCensus: { original: 1, retry: 1, fallback: 0, verification: 1, attempts: 3 } },
        "succeeded-first-attempt is incoherent with the attempt census",
      ],
      ["the unresolved success", { resolved: false }, "resolved is incoherent with outcomeClass"],
      [
        "the resolved terminal failure (failure hiding)",
        { ...failedFacts, resolved: true },
        "a terminal failure never records resolved",
      ],
      [
        "a polling interval riding an event stream",
        {
          progress: {
            mode: "event-stream",
            pollingInterval: { kind: "measured", milliseconds: 100 },
            cooldownAtDispatch: { kind: "none" },
          },
        },
        "cannot ride progress.mode event-stream",
      ],
      [
        "polled without the applied interval",
        { progress: { mode: "polled", cooldownAtDispatch: { kind: "none" } } },
        "pollingInterval is required when progress.mode is polled",
      ],
      [
        "the unattributed fact",
        { basis: undefined },
        "basis is required on every outcome-latency fact",
      ],
    ];
    // The unmutated fixture passes — every rejection below is load-bearing.
    expect(validateOutcomeLatencyFacts(validFacts)).toEqual({ valid: true });
    for (const [name, mutation, reasonSubstring] of mutations) {
      const mutated = { ...validFacts, ...mutation } as OutcomeLatencyFacts;
      const verdict = validateOutcomeLatencyFacts(mutated);
      expect(verdict.valid, `${name}: pure validation rejects`).toBe(false);
      expect(
        verdict.valid === false && verdict.reason,
        `${name}: reason names the field`,
      ).toContain(reasonSubstring);
      const seamVerdict = validateOptionalOutcomeLatencyFacts(mutated);
      expect(seamVerdict.valid, `${name}: the optional seam rejects`).toBe(false);
      expect(JSON.stringify(seamVerdict)).toBe(JSON.stringify(verdict));
      const boundaryVerdict = checkOutcomeLatencyBoundary({ facts: mutated, record });
      expect(boundaryVerdict.kind, `${name}: the boundary fails closed`).toBe("invalid");
      expect(boundaryVerdict.kind === "invalid" && boundaryVerdict.side).toBe("facts");
    }
  });

  test("S2b a mutated field is the CAUSE (the mutation flips the verdict, the unmutated passes)", () => {
    const censusMutation = {
      ...validFacts,
      attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 5 },
    };
    expect(validateOutcomeLatencyFacts(censusMutation).valid).toBe(false);
    expect(
      validateOutcomeLatencyFacts({
        ...censusMutation,
        attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 2 },
      }),
    ).toEqual({ valid: true });
    // The failure-hiding mutation is exactly the dropped-attempt shape:
    // three attempts vanished from the total while the census claims 2.
    expect(
      validateOutcomeLatencyFacts({
        ...failedFacts,
        attemptCensus: { original: 1, retry: 0, fallback: 1, verification: 0, attempts: 1 },
      }).valid,
    ).toBe(false);
    expect(
      validateOutcomeLatencyFacts({
        ...failedFacts,
        attemptCensus: { original: 1, retry: 0, fallback: 1, verification: 0, attempts: 2 },
      }),
    ).toEqual({ valid: true });
  });

  // -------------------------------------------------------------------------
  // S3 — the boundary discrimination
  // -------------------------------------------------------------------------

  test("S3a a malformed side is never compared — invalid beats mismatched (a weak check misleads)", () => {
    const malformed = { ...validFacts, outcomeClass: "succeeded" } as never;
    // The real check fails closed on the facts side BEFORE comparing ids
    // (the record's executionId deliberately mismatches too).
    expect(
      checkOutcomeLatencyBoundary({
        facts: malformed,
        record: { executionId: "exec-9999", planRevision: 9 },
      }),
    ).toEqual({
      kind: "invalid",
      side: "facts",
      reason:
        "outcomeLatencyFacts.outcomeClass must be one of succeeded-first-attempt|succeeded-after-retry|succeeded-on-fallback|failed-terminal: succeeded",
    });
    // A hand-rolled WEAK check that skips pre-validation compares the
    // malformed block and reports a misleading mismatch — exactly the
    // weakened protection this plane must never exhibit.
    const weakCheck = (
      facts: { basis?: { executionId?: string } },
      rec: { executionId: string },
    ) => (facts.basis?.executionId === rec.executionId ? "compatible" : "incompatible");
    expect(weakCheck(malformed as never, { executionId: "exec-9999" })).toBe("incompatible");
    expect(weakCheck(malformed as never, { executionId: "exec-0001" })).toBe("compatible");
  });

  test("S3b a malformed record side fails closed, never compared", () => {
    expect(
      checkOutcomeLatencyBoundary({
        facts: validFacts,
        record: { executionId: "", planRevision: 3 },
      }),
    ).toEqual({
      kind: "invalid",
      side: "record",
      reason: "outcomeRecord.executionId must be a bounded non-empty identity (<=128): ",
    });
    expect(checkOutcomeLatencyBoundary({ facts: validFacts, record: 7 as never })).toEqual({
      kind: "invalid",
      side: "record",
      reason: "outcomeRecord must be the record identity {executionId, planRevision}: 7",
    });
  });

  test("S3c identity mismatches name BOTH sides in the frozen field order, byte-identically", () => {
    const first = checkOutcomeLatencyBoundary({
      facts: validFacts,
      record: { executionId: "exec-9999", planRevision: 9 },
    });
    expect(first).toEqual({
      kind: "incompatible",
      mismatches: [
        {
          field: "execution-id",
          factsBasis: validFacts.basis,
          factsValue: "exec-0001",
          recordValue: "exec-9999",
        },
        {
          field: "plan-revision",
          factsBasis: validFacts.basis,
          factsValue: "3",
          recordValue: "9",
        },
      ],
    });
    for (let index = 0; index < 5; index += 1) {
      expect(
        JSON.stringify(
          checkOutcomeLatencyBoundary({
            facts: validFacts,
            record: { executionId: "exec-9999", planRevision: 9 },
          }),
        ),
      ).toBe(JSON.stringify(first));
    }
  });

  // -------------------------------------------------------------------------
  // S4 — no silent defaulting
  // -------------------------------------------------------------------------

  test("S4a unknown enum members are rejected, never coerced to a member", () => {
    for (const [name, mutation, expected] of [
      ["outcome class", "succeeded", "succeeded-first-attempt"],
      ["failure class", "provider-503", "provider-5xx"],
      ["progress mode", "streaming", "polled"],
      ["clock discipline", "ambient", "wall-clock"],
      ["measurement kind", "estimated", "measured"],
    ] as const) {
      const verdict = validateOutcomeLatencyFacts({
        ...validFacts,
        ...(name === "outcome class" ? { outcomeClass: mutation } : {}),
        ...(name === "failure class" ? { legs: [{ ...timeoutLeg, failureClass: mutation }] } : {}),
        ...(name === "progress mode"
          ? { progress: { mode: mutation, cooldownAtDispatch: { kind: "none" } } }
          : {}),
        ...(name === "clock discipline"
          ? { basis: { ...validFacts.basis, clockDiscipline: mutation } }
          : {}),
        ...(name === "measurement kind"
          ? { legs: [{ ...cleanLeg, firstByte: { kind: mutation, milliseconds: 5 } }] }
          : {}),
      } as never);
      expect(verdict.valid, `${name}: rejected, never defaulted`).toBe(false);
      // The nearest tempting member never silently substitutes.
      expect(verdict.valid === false && verdict.reason).toContain(mutation);
      expect(expected).toBeTruthy();
    }
  });

  test("S4b the honest not-run never collapses into a measured zero (the placeholder trap)", () => {
    const notRun = {
      ...failedFacts,
      legs: [
        { ...timeoutLeg, completion: { kind: "not-run", owner: "execution adapter" } },
        failedFacts.legs[1],
      ],
    } as OutcomeLatencyFacts;
    const measuredZero = {
      ...failedFacts,
      legs: [
        { ...timeoutLeg, completion: { kind: "measured", milliseconds: 0 } },
        failedFacts.legs[1],
      ],
    } as OutcomeLatencyFacts;
    expect(validateOutcomeLatencyFacts(notRun)).toEqual({ valid: true });
    expect(validateOutcomeLatencyFacts(measuredZero)).toEqual({ valid: true });
    expect(canonicalOutcomeLatencyJson(notRun)).not.toBe(canonicalOutcomeLatencyJson(measuredZero));
    expect(outcomeLatencyFactsIdentity(notRun, sha256)).not.toBe(
      outcomeLatencyFactsIdentity(measuredZero, sha256),
    );
  });

  test("S4c a polling interval on an event stream is rejected, never silently dropped", () => {
    const carrying = {
      ...validFacts,
      progress: {
        mode: "event-stream",
        pollingInterval: { kind: "measured", milliseconds: 100 },
        cooldownAtDispatch: { kind: "none" },
      },
    };
    expect(validateOutcomeLatencyFacts(carrying).valid).toBe(false);
    // The clean event-stream fact's canonical form carries no polling
    // interval key at all — absence is key-omission.
    expect(canonicalOutcomeLatencyJson(validFacts)).not.toContain("pollingInterval");
  });
});
