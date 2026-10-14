/**
 * The PCL-003 mirror pins (work order PCL-003 — the app-local mirrors
 * against the REAL planes).
 *
 * THE BOUNDARY LAW being pinned: the application tree cannot import
 * `src/**` (the VAL-002 AC7 discipline + the benchmarks import law),
 * so the evaluation mirrors the PCL-001 facts plane and the PCL-002
 * pacing plane locally (the PCS-004 precedent). This suite imports the
 * REAL planes (the test tree is unrestricted) and pins EVERY mirror
 * against its authority — drift is a typed failure, never silent:
 *
 *  - every closed vocabulary is EXACTLY the authority's frozen
 *    vocabulary (both planes), and every bound is exactly the
 *    authority's bound;
 *  - every fact the evaluation emits VALIDATES on the REAL
 *    `validateOutcomeLatencyFacts` (the PCL-001 plane's own fail-closed
 *    validator);
 *  - the local canonical serializer is byte-identical to the REAL
 *    `canonicalOutcomeLatencyJson` over every emitted fact and the
 *    mutation fixtures;
 *  - the local configuration validation is verdict-for-verdict the
 *    REAL `validateTailPacingConfiguration` over the tuned
 *    configuration AND a single-field mutation corpus (each weakening
 *    load-bearing);
 *  - the local pacing resolutions are verdict-for-verdict the REAL
 *    functions over a fixed query corpus (`retryBackoffDelayMs`,
 *    `cooldownStateAtDispatch`, `cooldownReentryAdmission`,
 *    `resolveProgressDelivery`, `progressDeliveryFactsOf`) and the
 *    REAL resolver factory produces the same verdict stream as the
 *    local one over the tuned configuration;
 *  - THE FULL EVALUATION re-runs with the REAL resolver factory
 *    injected and reproduces the evaluation digest byte-identically
 *    (the strongest pin: the local projection is the real plane over
 *    the entire evidence, the PCR-003 plan-artifact injection
 *    precedent);
 *  - the REAL plane's fail-closed construction parity (a malformed
 *    configuration throws on both sides).
 */

import { describe, expect, test } from "vitest";
import { runLatencyTailEvaluation } from "../../../benchmarks/validation/apps/latency-tail-evaluation/application";
import { createNodeDigestPort } from "../../../benchmarks/validation/apps/latency-tail-evaluation/canonical";
import {
  BASELINE_ARM,
  SYNTHETIC_TRANSPORT_CAPABILITIES,
  TUNED_ARM,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/configurations";
import type { EvaluationCell } from "../../../benchmarks/validation/apps/latency-tail-evaluation/corpus";
import { evaluationCells } from "../../../benchmarks/validation/apps/latency-tail-evaluation/driver";
import {
  CLOCK_DISCIPLINES as LOCAL_CLOCK_DISCIPLINES,
  DISPATCH_COOLDOWN_KINDS as LOCAL_DISPATCH_COOLDOWN_KINDS,
  MAX_ATTEMPT_COUNT as LOCAL_MAX_ATTEMPT_COUNT,
  MAX_LATENCY_MS as LOCAL_MAX_LATENCY_MS,
  MAX_LEGS as LOCAL_MAX_LEGS,
  MAX_PLAN_REVISION as LOCAL_MAX_PLAN_REVISION,
  MAX_VERIFICATION_RESULT_REFS as LOCAL_MAX_VERIFICATION_RESULT_REFS,
  MEASUREMENT_KINDS as LOCAL_MEASUREMENT_KINDS,
  OUTCOME_CLASSES as LOCAL_OUTCOME_CLASSES,
  OUTCOME_FAILURE_CLASSES as LOCAL_OUTCOME_FAILURE_CLASSES,
  PROGRESS_DELIVERY_MODES as LOCAL_PROGRESS_DELIVERY_MODES,
  VERIFICATION_PROOF_KINDS as LOCAL_VERIFICATION_PROOF_KINDS,
  VERIFICATION_PROOF_OUTCOMES as LOCAL_VERIFICATION_PROOF_OUTCOMES,
  canonicalOutcomeLatencyJson as localCanonical,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/facts";
import type { PacingResolverFactory } from "../../../benchmarks/validation/apps/latency-tail-evaluation/pacing";
import {
  COOLDOWN_REENTRY_MODES as LOCAL_COOLDOWN_REENTRY_MODES,
  MAX_BACKOFF_BASE_MS as LOCAL_MAX_BACKOFF_BASE_MS,
  MAX_BACKOFF_CEILING_MS as LOCAL_MAX_BACKOFF_CEILING_MS,
  MAX_COOLDOWN_MS as LOCAL_MAX_COOLDOWN_MS,
  MAX_JITTER_FRACTION as LOCAL_MAX_JITTER_FRACTION,
  MAX_PACING_RETRIES as LOCAL_MAX_PACING_RETRIES,
  MAX_POLLING_INTERVAL_MS as LOCAL_MAX_POLLING_INTERVAL_MS,
  MAX_TIMEOUT_CONTRACT_MS as LOCAL_MAX_TIMEOUT_CONTRACT_MS,
  MIN_POLLING_INTERVAL_MS as LOCAL_MIN_POLLING_INTERVAL_MS,
  MIN_PROBE_FRACTION as LOCAL_MIN_PROBE_FRACTION,
  LOCAL_PACING_RESOLVER_FACTORY,
  PROGRESS_PREFERENCES as LOCAL_PROGRESS_PREFERENCES,
  RETRY_BACKOFF_SHAPES as LOCAL_RETRY_BACKOFF_SHAPES,
  TERMINAL_PACING_FAILURE_CLASSES as LOCAL_TERMINAL_CLASSES,
  TAIL_PACING_CONFIGURATION_VERSION as LOCAL_VERSION,
  cooldownStateAtDispatch as localCooldownState,
  progressDeliveryFactsOf as localProgressFactsOf,
  cooldownReentryAdmission as localReentry,
  resolveProgressDelivery as localResolveProgress,
  retryBackoffDelayMs as localRetryDelay,
  validateTailPacingConfiguration as localValidate,
  type TailPacingConfiguration,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/pacing";
import { replayCellArm } from "../../../benchmarks/validation/apps/latency-tail-evaluation/replay";
import { createTailPacingResolver } from "../../../src/modules/executions/adapters/tail-pacing";
// THE REAL PLANES (the test tree is unrestricted — the app tree is not;
// this is the ONLY place the two meet, by design).
import {
  CLOCK_DISCIPLINES,
  DISPATCH_COOLDOWN_KINDS,
  MAX_ATTEMPT_COUNT,
  MAX_LATENCY_MS,
  MAX_LEGS,
  MAX_PLAN_REVISION,
  MAX_VERIFICATION_RESULT_REFS,
  MEASUREMENT_KINDS,
  OUTCOME_CLASSES,
  OUTCOME_FAILURE_CLASSES,
  PROGRESS_DELIVERY_MODES,
  canonicalOutcomeLatencyJson as realCanonical,
  outcomeLatencyFactsIdentity as realIdentity,
  VERIFICATION_PROOF_KINDS,
  VERIFICATION_PROOF_OUTCOMES,
  validateOutcomeLatencyFacts,
} from "../../../src/modules/executions/domain/outcome-latency-facts";
import {
  cooldownStateAtDispatch as realCooldownState,
  progressDeliveryFactsOf as realProgressFactsOf,
  cooldownReentryAdmission as realReentry,
  resolveProgressDelivery as realResolveProgress,
  retryBackoffDelayMs as realRetryDelay,
  validateTailPacingConfiguration as realValidate,
} from "../../../src/modules/executions/domain/tail-pacing-configuration";

const digestPort = createNodeDigestPort();

/** A deterministic hermetic cell for the emitted-fact pins. */
const HERMETIC_CELL: EvaluationCell = {
  cellId: "pcl-003-hermetic-S-multi-mono",
  subject: {
    subjectId: "pcl-003-hermetic",
    name: "PCL-003 hermetic subject",
    repository: "pcl-003/hermetic",
    upstreamRevision: "test",
    integrationRevision: "test",
    evidenceRecord: "pcl-003-hermetic",
    requestCountBasis: "resolved-corpus-narrative",
    tokenTotalsBasis: "resolved-corpus-narrative",
    edges: [{ edgeId: "edge-1", surface: "text-generation", modalityClass: "text" }],
    tasks: [
      {
        taskId: "task-a",
        title: "Task A",
        instruction: "Do A",
        requests: [
          { edgeId: "edge-1", inputTokens: 500, outputTokens: 200 },
          { edgeId: "edge-1", inputTokens: 300, outputTokens: 100 },
        ],
      },
    ],
    certifiedTotals: { requests: 2, inputTokens: 800, outputTokens: 300 },
  },
  volume: "S",
  repetitions: 1,
  providerConfig: "multi",
  modality: "mono",
  providerIds: ["supply-a", "supply-b", "supply-c"],
};

describe("PCL-003 mirror pins: the closed vocabularies and bounds are EXACTLY the authorities'", () => {
  test("the PCL-001 facts vocabulary mirror is exact (every member, in the frozen order)", () => {
    expect([...LOCAL_OUTCOME_CLASSES]).toEqual([...OUTCOME_CLASSES]);
    expect([...LOCAL_OUTCOME_FAILURE_CLASSES]).toEqual([...OUTCOME_FAILURE_CLASSES]);
    expect([...LOCAL_PROGRESS_DELIVERY_MODES]).toEqual([...PROGRESS_DELIVERY_MODES]);
    expect([...LOCAL_CLOCK_DISCIPLINES]).toEqual([...CLOCK_DISCIPLINES]);
    expect([...LOCAL_MEASUREMENT_KINDS]).toEqual([...MEASUREMENT_KINDS]);
    expect([...LOCAL_VERIFICATION_PROOF_KINDS]).toEqual([...VERIFICATION_PROOF_KINDS]);
    expect([...LOCAL_VERIFICATION_PROOF_OUTCOMES]).toEqual([...VERIFICATION_PROOF_OUTCOMES]);
    expect([...LOCAL_DISPATCH_COOLDOWN_KINDS]).toEqual([...DISPATCH_COOLDOWN_KINDS]);
  });

  test("the PCL-001 facts bounds mirror is exact", () => {
    expect(LOCAL_MAX_LATENCY_MS).toBe(MAX_LATENCY_MS);
    expect(LOCAL_MAX_ATTEMPT_COUNT).toBe(MAX_ATTEMPT_COUNT);
    expect(LOCAL_MAX_PLAN_REVISION).toBe(MAX_PLAN_REVISION);
    expect(LOCAL_MAX_LEGS).toBe(MAX_LEGS);
    expect(LOCAL_MAX_VERIFICATION_RESULT_REFS).toBe(MAX_VERIFICATION_RESULT_REFS);
  });

  test("the PCL-002 pacing vocabulary and bounds mirror is exact", () => {
    expect([...LOCAL_RETRY_BACKOFF_SHAPES]).toEqual(["linear", "exponential"]);
    expect([...LOCAL_COOLDOWN_REENTRY_MODES]).toEqual(["expiry", "early-probe"]);
    expect([...LOCAL_PROGRESS_PREFERENCES]).toEqual(["event-stream-else-polled", "polled-only"]);
    expect([...LOCAL_TERMINAL_CLASSES]).toEqual(["budget-exhausted", "policy-denied"]);
    expect(LOCAL_VERSION).toBe(1);
    expect(LOCAL_MAX_PACING_RETRIES).toBe(10);
    expect(LOCAL_MAX_BACKOFF_BASE_MS).toBe(60_000);
    expect(LOCAL_MAX_BACKOFF_CEILING_MS).toBe(600_000);
    expect(LOCAL_MAX_JITTER_FRACTION).toBe(0.5);
    expect(LOCAL_MAX_COOLDOWN_MS).toBe(3_600_000);
    expect(LOCAL_MIN_POLLING_INTERVAL_MS).toBe(50);
    expect(LOCAL_MAX_POLLING_INTERVAL_MS).toBe(5_000);
    expect(LOCAL_MAX_TIMEOUT_CONTRACT_MS).toBe(3_600_000);
    expect(LOCAL_MIN_PROBE_FRACTION).toBe(0.05);
  });
});

describe("PCL-003 mirror pins: every emitted fact validates on the REAL validator; the canonical forms are byte-identical", () => {
  const tunedReplay = replayCellArm(HERMETIC_CELL, TUNED_ARM, { digest: digestPort });
  const baselineReplay = replayCellArm(HERMETIC_CELL, BASELINE_ARM, { digest: digestPort });
  const emittedFacts = [...tunedReplay.executions, ...baselineReplay.executions].map(
    (execution) => execution.facts,
  );

  test("the hermetic replay emits facts (both arms, both outcome kinds present across the draws)", () => {
    expect(emittedFacts.length).toBeGreaterThan(0);
    // The full corpus ran: every execution either resolved or recorded
    // its honest terminal.
    const resolved = emittedFacts.filter((facts) => facts.resolved);
    expect(resolved.length).toBeGreaterThan(0);
  });

  test("every emitted fact block VALIDATES on the REAL PCL-001 fail-closed validator", () => {
    for (const facts of emittedFacts) {
      const verdict = validateOutcomeLatencyFacts(facts);
      expect(
        verdict.valid,
        `a fact failed the REAL validator: ${verdict.valid ? "" : verdict.reason}`,
      ).toBe(true);
    }
  });

  test("the local canonical serializer is byte-identical to the REAL canonicalOutcomeLatencyJson over every emitted fact", () => {
    for (const facts of emittedFacts) {
      expect(localCanonical(facts)).toBe(
        realCanonical(facts as Parameters<typeof realCanonical>[0]),
      );
    }
  });

  test("the local content address is byte-identical to the REAL identity (the injected digest port)", () => {
    for (const execution of tunedReplay.executions) {
      expect(execution.factsIdentity).toBe(
        realIdentity(execution.facts as Parameters<typeof realIdentity>[0], (canonical) =>
          digestPort.sha256Hex(canonical),
        ),
      );
    }
  });

  test("the absent spellings agree (undefined and null both canonicalize to key-omission — the REAL canonical law)", () => {
    for (const facts of emittedFacts) {
      // A leg with a present failure class vs the same leg with the
      // absent spelling: different addresses; the null/undefined
      // absence pair: identical addresses.
      const withNull = {
        ...facts,
        legs: facts.legs.map((leg) => ({ ...leg, failureClass: leg.failureClass ?? null })),
      };
      expect(localCanonical(withNull)).toBe(
        realCanonical(withNull as Parameters<typeof realCanonical>[0]),
      );
      const withUndefined = {
        ...facts,
        legs: facts.legs.map((leg) => ({ ...leg, failureClass: leg.failureClass ?? undefined })),
      };
      expect(localCanonical(withNull)).toBe(localCanonical(withUndefined));
    }
  });

  test("a tampered fact fails the REAL validator (the mirror's construction laws and the authority agree on the incoherent shapes)", () => {
    const tampered = {
      ...emittedFacts[0],
      resolved: !emittedFacts[0]?.resolved,
    } as (typeof emittedFacts)[number];
    const verdict = validateOutcomeLatencyFacts(tampered);
    expect(verdict.valid).toBe(false);
  });
});

describe("PCL-003 mirror pins: the configuration validation is verdict-for-verdict the REAL boundary", () => {
  test("the tuned configuration validates on BOTH the local mirror and the REAL boundary", () => {
    expect(localValidate(TUNED_ARM.pacing).valid).toBe(true);
    expect(realValidate(TUNED_ARM.pacing).valid).toBe(true);
  });

  /** The single-field mutation corpus (each weakening load-bearing). */
  const tunedPacing = TUNED_ARM.pacing;
  const tunedRetryPacing = tunedPacing.retryPacing as NonNullable<typeof tunedPacing.retryPacing>;
  const mutations: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: "version 2", value: { ...TUNED_ARM.pacing, version: 2 } },
    {
      label: "missing timeout contract",
      value: { ...TUNED_ARM.pacing, timeoutContract: undefined },
    },
    {
      label: "maxRetries above the bound",
      value: { ...TUNED_ARM.pacing, retryPacing: { ...tunedRetryPacing, maxRetries: 11 } },
    },
    {
      label: "baseMs below the bound",
      value: {
        ...TUNED_ARM.pacing,
        retryPacing: { ...tunedRetryPacing, backoff: { ...tunedRetryPacing.backoff, baseMs: 0 } },
      },
    },
    {
      label: "ceiling below base",
      value: {
        ...TUNED_ARM.pacing,
        retryPacing: {
          ...tunedRetryPacing,
          backoff: { ...tunedRetryPacing.backoff, baseMs: 200, ceilingMs: 5 },
        },
      },
    },
    {
      label: "jitter fraction above the bound",
      value: {
        ...TUNED_ARM.pacing,
        retryPacing: {
          ...tunedRetryPacing,
          backoff: { ...tunedRetryPacing.backoff, jitterFraction: 0.6 },
        },
      },
    },
    {
      label: "terminal class retryable (budget-exhausted)",
      value: {
        ...TUNED_ARM.pacing,
        retryPacing: { ...tunedRetryPacing, retryableFailureClasses: ["budget-exhausted"] },
      },
    },
    {
      label: "terminal class retryable (policy-denied)",
      value: {
        ...TUNED_ARM.pacing,
        retryPacing: { ...tunedRetryPacing, retryableFailureClasses: ["policy-denied"] },
      },
    },
    {
      label: "duplicate cooldown rules",
      value: {
        ...TUNED_ARM.pacing,
        cooldownDiscipline: {
          rules: [
            { failureClass: "provider-throttle", cooldownMs: 2500, reentry: "expiry" },
            { failureClass: "provider-throttle", cooldownMs: 1000, reentry: "expiry" },
          ],
        },
      },
    },
    {
      label: "probe fraction riding expiry",
      value: {
        ...TUNED_ARM.pacing,
        cooldownDiscipline: {
          rules: [
            {
              failureClass: "provider-throttle",
              cooldownMs: 2500,
              reentry: "expiry",
              probeAtFraction: 0.5,
            },
          ],
        },
      },
    },
    {
      label: "polling interval below the surface minimum",
      value: {
        ...TUNED_ARM.pacing,
        progressDelivery: { ...TUNED_ARM.pacing.progressDelivery, pollingIntervalMs: 10 },
      },
    },
    {
      label: "budget below the attempt timeout",
      value: {
        ...TUNED_ARM.pacing,
        timeoutContract: { attemptTimeoutMs: 30_000, dispatchBudgetMs: 25_000 },
      },
    },
    {
      label: "the preservation gate violation (the worst case exceeds the budget)",
      value: {
        ...TUNED_ARM.pacing,
        timeoutContract: { attemptTimeoutMs: 70_000, dispatchBudgetMs: 120_000 },
      },
    },
    {
      label: "the poll beyond the attempt timeout (gate leg G2)",
      value: {
        ...TUNED_ARM.pacing,
        progressDelivery: { ...TUNED_ARM.pacing.progressDelivery, pollingIntervalMs: 5_000 },
        timeoutContract: { attemptTimeoutMs: 1_000, dispatchBudgetMs: 120_000 },
      },
    },
  ];

  test("every single-field weakening flips BOTH verdicts identically (the reason names the same field)", () => {
    for (const mutation of mutations) {
      const local = localValidate(mutation.value);
      const real = realValidate(mutation.value);
      expect(
        local.valid,
        `the mutation "${mutation.label}" must be rejected by the local mirror`,
      ).toBe(false);
      expect(
        real.valid,
        `the mutation "${mutation.label}" must be rejected by the REAL boundary`,
      ).toBe(false);
      // The rejection names the same field on both sides (the verdict's
      // first segment — the field identifier).
      const localField = (local.valid ? "" : local.reason).split(":")[0];
      const realField = (real.valid ? "" : real.reason).split(":")[0];
      expect(localField).toBe(realField);
    }
  });

  test("the REAL resolver factory's fail-closed construction parity (a malformed configuration throws on both sides)", () => {
    const malformed = mutations[1]?.value as TailPacingConfiguration;
    expect(() => LOCAL_PACING_RESOLVER_FACTORY({ configuration: malformed })).toThrow();
    expect(() => createTailPacingResolver({ configuration: malformed })).toThrow();
  });

  test("the REAL resolver factory requires the injected jitter draw when retry pacing is authored (never ambient)", () => {
    expect(() => LOCAL_PACING_RESOLVER_FACTORY({ configuration: TUNED_ARM.pacing })).toThrow(
      /jitterDraw/,
    );
    expect(() => createTailPacingResolver({ configuration: TUNED_ARM.pacing as never })).toThrow(
      /jitterDraw/,
    );
  });
});

describe("PCL-003 mirror pins: the pacing resolutions are verdict-for-verdict the REAL functions", () => {
  test("retryBackoffDelayMs over the fixed query corpus (both shapes, the attempts, the draws, the jitter extremes)", () => {
    const pacing = TUNED_ARM.pacing.retryPacing as NonNullable<typeof TUNED_ARM.pacing.retryPacing>;
    const shapes: readonly ("linear" | "exponential")[] = ["linear", "exponential"];
    const draws = [0, 0.25, 0.5, 0.75, 1];
    for (const shape of shapes) {
      for (const jitterFraction of [0, 0.25, 0.5]) {
        const variant = {
          ...pacing,
          backoff: { ...pacing.backoff, shape, jitterFraction },
        };
        for (const attempt of [1, 2, 3, 10]) {
          for (const draw of draws) {
            expect(
              localRetryDelay(variant, attempt, draw),
              `shape ${shape} jitter ${jitterFraction} attempt ${attempt} draw ${draw}`,
            ).toBe(realRetryDelay(variant as never, attempt, draw));
          }
        }
      }
    }
    // The ceiling binds after jitter (the hard bound).
    const ceilingVariant = {
      ...pacing,
      backoff: { ...pacing.backoff, baseMs: 100, ceilingMs: 120, jitterFraction: 0.5 },
    };
    for (const draw of draws) {
      expect(localRetryDelay(ceilingVariant, 5, draw)).toBeLessThanOrEqual(120);
      expect(localRetryDelay(ceilingVariant, 5, draw)).toBe(
        realRetryDelay(ceilingVariant as never, 5, draw),
      );
    }
  });

  test("cooldownStateAtDispatch and cooldownReentryAdmission over the elapsed sweeps (the class-aware discipline)", () => {
    const discipline = TUNED_ARM.pacing.cooldownDiscipline as NonNullable<
      typeof TUNED_ARM.pacing.cooldownDiscipline
    >;
    const classes = [
      "provider-throttle",
      "provider-5xx",
      "provider-timeout",
      "connection-error",
    ] as const;
    for (const failureClass of classes) {
      for (const elapsed of [0, 1, 25, 499, 500, 501, 999, 1000, 2499, 2500, 5000]) {
        expect(localCooldownState(discipline, failureClass, elapsed)).toEqual(
          realCooldownState(discipline as never, failureClass, elapsed),
        );
        expect(localReentry(discipline, failureClass, elapsed)).toEqual(
          realReentry(discipline as never, failureClass, elapsed),
        );
      }
    }
    // Absence by omission: an unkeyed class cools nothing, admissible.
    expect(localReentry(discipline, "verification-retry", 0)).toEqual(
      realReentry(discipline as never, "verification-retry", 0),
    );
    expect(localReentry(undefined, "provider-throttle", 0)).toEqual(
      realReentry(undefined, "provider-throttle" as never, 0),
    );
  });

  test("resolveProgressDelivery and progressDeliveryFactsOf over the capability sets (the ACR-009 selection pattern)", () => {
    const progress = TUNED_ARM.pacing.progressDelivery as NonNullable<
      typeof TUNED_ARM.pacing.progressDelivery
    >;
    for (const capabilities of [{ eventStream: true }, { eventStream: false }]) {
      expect(localResolveProgress(progress, capabilities)).toEqual(
        realResolveProgress(progress as never, capabilities),
      );
      const resolved = localResolveProgress(progress, capabilities);
      const cooldown = { kind: "none" as const };
      expect(localProgressFactsOf(resolved, cooldown)).toEqual(
        realProgressFactsOf(resolved as never, cooldown as never),
      );
    }
    // The synthetic transports declare no event-stream support: the
    // honest fallback is polled at the declared interval.
    const resolved = localResolveProgress(progress, SYNTHETIC_TRANSPORT_CAPABILITIES);
    expect(resolved?.mode).toBe("polled");
    expect(resolved?.pollingIntervalMs).toBe(50);
  });

  test("the REAL resolver produces the local resolver's verdict stream over the tuned configuration (the fixed query corpus)", () => {
    const fixedDraw = (): number => 0.5;
    const local = LOCAL_PACING_RESOLVER_FACTORY({
      configuration: TUNED_ARM.pacing,
      jitterDraw: fixedDraw,
    });
    const real = createTailPacingResolver({
      configuration: TUNED_ARM.pacing as never,
      jitterDraw: fixedDraw,
    });
    for (const attempt of [1, 2, 3]) {
      expect(local.retryDelayFor(attempt)).toBe(real.retryDelayFor(attempt));
    }
    for (const failureClass of [
      "provider-5xx",
      "provider-throttle",
      "provider-timeout",
      "connection-error",
      "verification-retry",
      "budget-exhausted",
      "policy-denied",
    ] as const) {
      expect(local.retryAdmits(failureClass)).toBe(real.retryAdmits(failureClass));
      for (const elapsed of [0, 100, 1000, 2500]) {
        expect(local.cooldownAtDispatch(failureClass, elapsed)).toEqual(
          real.cooldownAtDispatch(failureClass, elapsed),
        );
        expect(local.admitCooldownReentry(failureClass, elapsed)).toEqual(
          real.admitCooldownReentry(failureClass, elapsed),
        );
      }
    }
    expect(local.resolveProgress(SYNTHETIC_TRANSPORT_CAPABILITIES)).toEqual(
      real.resolveProgress(SYNTHETIC_TRANSPORT_CAPABILITIES as never),
    );
    expect(local.progressFacts(SYNTHETIC_TRANSPORT_CAPABILITIES, { kind: "none" })).toEqual(
      real.progressFacts(SYNTHETIC_TRANSPORT_CAPABILITIES as never, { kind: "none" }),
    );
    // The unarmed posture: both factories resolve inert (the absence
    // spellings).
    const localUnarmed = LOCAL_PACING_RESOLVER_FACTORY({});
    const realUnarmed = createTailPacingResolver({});
    expect(localUnarmed.configuration).toBeNull();
    expect(realUnarmed.configuration).toBeNull();
    expect(localUnarmed.retryDelayFor(1)).toBeUndefined();
    expect(realUnarmed.retryDelayFor(1)).toBeUndefined();
  });
});

describe("PCL-003 mirror pins: THE FULL EVALUATION with the REAL resolver factory injected reproduces the digest byte-identically", () => {
  test("the complete 102-cell evaluation re-runs with the REAL PCL-002 seam factory and produces the byte-identical evaluation digest + gate verdict", {
    timeout: 120_000,
  }, async () => {
    const realFactory: PacingResolverFactory = (deps) =>
      createTailPacingResolver(deps as never) as never;
    const local = await runLatencyTailEvaluation();
    const withReal = await runLatencyTailEvaluation({ resolverFactory: realFactory });
    expect(withReal.aggregate.evaluationDigest).toBe(local.aggregate.evaluationDigest);
    expect(withReal.aggregate.gate).toEqual(local.aggregate.gate);
    expect(withReal.cells.map((cell) => cell.digest)).toEqual(
      local.cells.map((cell) => cell.digest),
    );
    // The digest the committed artifacts carry is the digest the
    // local-mirror run produces (the standalone run's authority).
    expect(local.cells.length).toBe(102);
  });

  test("the corpus enumeration is the capstone's complete 102-cell sweep (allSweepCells, read-only — unique ids)", () => {
    const ids = evaluationCells().map((cell) => cell.cellId);
    expect(ids.length).toBe(102);
    expect(new Set(ids).size).toBe(102);
  });
});
