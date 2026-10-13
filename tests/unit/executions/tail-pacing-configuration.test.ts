/**
 * Unit: the declarative tail-pacing configuration (executions module
 * domain, ACR-010 §3–§4; work order PCL-002 — every configuration
 * path, the fail-closed rejections incl. the timeout/terminal-failure
 * preservation gate, and the pure resolution functions).
 *
 * The happy paths per dimension, the closed vocabularies, the bounds,
 * the absence spellings, the preservation gate's every leg, and the
 * pure mechanics resolutions (the backoff schedule with injected
 * draws, the cooldown state and re-entry per failure class, the
 * progress-mode selection by the transport's typed capability facts,
 * and the mechanics record projected into the PCL-01 facts — validated
 * by the PCL-01 validation itself, read-only consumption).
 */

import { describe, expect, test } from "vitest";
import { createTailPacingResolver } from "../../../src/modules/executions/adapters/tail-pacing";
import { validateOptionalOutcomeLatencyFacts } from "../../../src/modules/executions/domain/outcome-latency-facts";
import type { TailPacingConfiguration } from "../../../src/modules/executions/domain/tail-pacing-configuration";
import {
  COOLDOWN_REENTRY_MODES,
  cooldownReentryAdmission,
  cooldownRuleFor,
  cooldownStateAtDispatch,
  MAX_BACKOFF_CEILING_MS,
  MAX_COOLDOWN_MS,
  MAX_JITTER_FRACTION,
  MAX_PACING_RETRIES,
  MAX_POLLING_INTERVAL_MS,
  MIN_POLLING_INTERVAL_MS,
  PROGRESS_PREFERENCES,
  progressDeliveryFactsOf,
  resolveProgressDelivery,
  resolveTailPacing,
  retryBackoffDelayMs,
  TailPacingConfigurationError,
  TERMINAL_PACING_FAILURE_CLASSES,
  validateTailPacingConfiguration,
} from "../../../src/modules/executions/domain/tail-pacing-configuration";

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

const TRACED_CONTRACT = {
  attemptTimeoutMs: 60_000,
  dispatchBudgetMs: 300_000,
} as const;

/** A valid retry pacing: 2 retries, linear 250ms base, 5s ceiling, 10% jitter. */
const RETRY_PACING = {
  maxRetries: 2,
  backoff: { shape: "linear", baseMs: 250, ceilingMs: 5_000, jitterFraction: 0.1 },
  retryableFailureClasses: ["provider-5xx", "provider-throttle", "connection-error"],
} as const;

/** A valid cooldown discipline: a throttle cools longer than a 5xx, explicit re-entry. */
const COOLDOWN_DISCIPLINE = {
  rules: [
    { failureClass: "provider-throttle", cooldownMs: 45_000, reentry: "expiry" },
    {
      failureClass: "provider-5xx",
      cooldownMs: 10_000,
      reentry: "early-probe",
      probeAtFraction: 0.5,
    },
  ],
} as const;

/** A valid progress delivery: stream where the transport supports it, 250ms polled fallback. */
const PROGRESS_DELIVERY = {
  preference: "event-stream-else-polled",
  pollingIntervalMs: 250,
} as const;

const FULL_CONFIGURATION: TailPacingConfiguration = {
  version: 1,
  retryPacing: RETRY_PACING,
  cooldownDiscipline: COOLDOWN_DISCIPLINE,
  progressDelivery: PROGRESS_DELIVERY,
  timeoutContract: TRACED_CONTRACT,
};

describe("unit: the declarative tail-pacing configuration (PCL-002 — the data plane)", () => {
  // -------------------------------------------------------------------------
  // The configuration boundary: happy paths + absence
  // -------------------------------------------------------------------------

  test("the full configuration validates (every dimension authored)", () => {
    expect(validateTailPacingConfiguration(FULL_CONFIGURATION)).toEqual({ valid: true });
  });

  test("each dimension is independently optional (on/off per dimension through the configuration alone)", () => {
    const retryOnly = { version: 1, retryPacing: RETRY_PACING, timeoutContract: TRACED_CONTRACT };
    const cooldownOnly = {
      version: 1,
      cooldownDiscipline: COOLDOWN_DISCIPLINE,
      timeoutContract: TRACED_CONTRACT,
    };
    const progressOnly = {
      version: 1,
      progressDelivery: PROGRESS_DELIVERY,
      timeoutContract: TRACED_CONTRACT,
    };
    expect(validateTailPacingConfiguration(retryOnly)).toEqual({ valid: true });
    expect(validateTailPacingConfiguration(cooldownOnly)).toEqual({ valid: true });
    expect(validateTailPacingConfiguration(progressOnly)).toEqual({ valid: true });
    // The contract alone is a valid (all-off) configuration: nothing is
    // armed, but the declared contract is well-formed.
    expect(
      validateTailPacingConfiguration({ version: 1, timeoutContract: TRACED_CONTRACT }),
    ).toEqual({ valid: true });
  });

  test("the absence spellings resolve UNARMED (undefined AND null are both the absent spelling)", () => {
    expect(resolveTailPacing(undefined)).toEqual({ armed: false });
    expect(resolveTailPacing(null)).toEqual({ armed: false });
    expect(resolveTailPacing(FULL_CONFIGURATION).armed).toBe(true);
  });

  test("a non-object configuration is rejected typed", () => {
    expect(validateTailPacingConfiguration(7)).toEqual({
      valid: false,
      reason: "tailPacingConfiguration must be an object (the closed configuration block)",
    });
  });

  test("the version is closed: exactly 1 (never coerced, never defaulted forward)", () => {
    const verdict = validateTailPacingConfiguration({ ...FULL_CONFIGURATION, version: 2 });
    expect(verdict.valid).toBe(false);
    expect(verdict.valid === false && verdict.reason).toContain(
      "tailPacingConfiguration.version must be one of 1: 2",
    );
  });

  test("the timeout contract is REQUIRED when any dimension is authored (the gate is never ambient)", () => {
    for (const partial of [
      { version: 1, retryPacing: RETRY_PACING },
      { version: 1, cooldownDiscipline: COOLDOWN_DISCIPLINE },
      { version: 1, progressDelivery: PROGRESS_DELIVERY },
    ] as const) {
      const verdict = validateTailPacingConfiguration(partial);
      expect(verdict.valid).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        "timeoutContract is required when any pacing dimension is authored",
      );
    }
  });

  // -------------------------------------------------------------------------
  // The retry-pacing paths (shape, bounds, closed vocabularies)
  // -------------------------------------------------------------------------

  test("retry pacing rejects out-of-bounds and malformed shapes, naming the field", () => {
    const cases: readonly [string, unknown, string][] = [
      [
        "maxRetries above the bound",
        { ...RETRY_PACING, maxRetries: MAX_PACING_RETRIES + 1 },
        "retryPacing.maxRetries",
      ],
      ["maxRetries negative", { ...RETRY_PACING, maxRetries: -1 }, "retryPacing.maxRetries"],
      [
        "unknown backoff shape",
        { ...RETRY_PACING, backoff: { ...RETRY_PACING.backoff, shape: "fibonacci" } },
        "retryPacing.backoff.shape must be one of",
      ],
      [
        "base above the bound",
        { ...RETRY_PACING, backoff: { ...RETRY_PACING.backoff, baseMs: 60_001 } },
        "retryPacing.backoff.baseMs",
      ],
      [
        "ceiling above the bound",
        {
          ...RETRY_PACING,
          backoff: { ...RETRY_PACING.backoff, ceilingMs: MAX_BACKOFF_CEILING_MS + 1 },
        },
        "retryPacing.backoff.ceilingMs",
      ],
      [
        "ceiling below base",
        { ...RETRY_PACING, backoff: { ...RETRY_PACING.backoff, ceilingMs: 100 } },
        "ceilingMs must not be below baseMs",
      ],
      [
        "jitter above the bound",
        {
          ...RETRY_PACING,
          backoff: { ...RETRY_PACING.backoff, jitterFraction: MAX_JITTER_FRACTION + 0.01 },
        },
        "retryPacing.backoff.jitterFraction",
      ],
      [
        "jitter negative",
        { ...RETRY_PACING, backoff: { ...RETRY_PACING.backoff, jitterFraction: -0.1 } },
        "retryPacing.backoff.jitterFraction",
      ],
      [
        "unknown failure class",
        { ...RETRY_PACING, retryableFailureClasses: ["provider-503"] },
        "must be one of",
      ],
      [
        "duplicate failure class",
        { ...RETRY_PACING, retryableFailureClasses: ["provider-5xx", "provider-5xx"] },
        "must not contain duplicates",
      ],
    ];
    for (const [name, mutation, reasonSubstring] of cases) {
      const verdict = validateTailPacingConfiguration({
        version: 1,
        retryPacing: mutation,
        timeoutContract: TRACED_CONTRACT,
      });
      expect(verdict.valid, name).toBe(false);
      expect(verdict.valid === false && verdict.reason, name).toContain(reasonSubstring);
    }
  });

  test("THE TERMINAL-FAILURE PRESERVATION GATE: a terminal class declared retryable is rejected typed", () => {
    expect([...TERMINAL_PACING_FAILURE_CLASSES]).toEqual(["budget-exhausted", "policy-denied"]);
    for (const terminalClass of TERMINAL_PACING_FAILURE_CLASSES) {
      const verdict = validateTailPacingConfiguration({
        version: 1,
        retryPacing: { ...RETRY_PACING, retryableFailureClasses: ["provider-5xx", terminalClass] },
        timeoutContract: TRACED_CONTRACT,
      });
      expect(verdict.valid, `${terminalClass}: rejected`).toBe(false);
      expect(verdict.valid === false && verdict.reason).toContain(
        `cannot include the terminal failure class ${terminalClass}`,
      );
      expect(verdict.valid === false && verdict.reason).toContain(
        "masking a terminal failure as success is the automatic-void shape",
      );
    }
  });

  // -------------------------------------------------------------------------
  // The cooldown-discipline paths (failure-class-aware, explicit re-entry)
  // -------------------------------------------------------------------------

  test("cooldown rules reject unknown classes, duplicates, out-of-bounds durations and incoherent probe shapes", () => {
    const cases: readonly [string, unknown, string][] = [
      [
        "unknown failure class",
        { rules: [{ failureClass: "provider-503", cooldownMs: 1000, reentry: "expiry" }] },
        "must be one of",
      ],
      [
        "duplicate class rules",
        {
          rules: [
            { failureClass: "provider-throttle", cooldownMs: 1000, reentry: "expiry" },
            { failureClass: "provider-throttle", cooldownMs: 2000, reentry: "expiry" },
          ],
        },
        "must not carry duplicate rules for provider-throttle",
      ],
      [
        "duration above the bound",
        {
          rules: [
            { failureClass: "provider-5xx", cooldownMs: MAX_COOLDOWN_MS + 1, reentry: "expiry" },
          ],
        },
        "cooldownMs must be in",
      ],
      [
        "duration negative",
        { rules: [{ failureClass: "provider-5xx", cooldownMs: -1, reentry: "expiry" }] },
        "cooldownMs must be in",
      ],
      [
        "unknown re-entry mode",
        { rules: [{ failureClass: "provider-5xx", cooldownMs: 1000, reentry: "whenever" }] },
        "reentry must be one of",
      ],
      [
        "probe fraction riding expiry",
        {
          rules: [
            {
              failureClass: "provider-5xx",
              cooldownMs: 1000,
              reentry: "expiry",
              probeAtFraction: 0.5,
            },
          ],
        },
        "probeAtFraction cannot ride reentry expiry",
      ],
      [
        "early-probe without a fraction",
        { rules: [{ failureClass: "provider-5xx", cooldownMs: 1000, reentry: "early-probe" }] },
        "probeAtFraction must be a finite number",
      ],
      [
        "early-probe fraction above 1",
        {
          rules: [
            {
              failureClass: "provider-5xx",
              cooldownMs: 1000,
              reentry: "early-probe",
              probeAtFraction: 1.5,
            },
          ],
        },
        "probeAtFraction must be in",
      ],
    ];
    for (const [name, mutation, reasonSubstring] of cases) {
      const verdict = validateTailPacingConfiguration({
        version: 1,
        cooldownDiscipline: mutation,
        timeoutContract: TRACED_CONTRACT,
      });
      expect(verdict.valid, name).toBe(false);
      expect(verdict.valid === false && verdict.reason, name).toContain(reasonSubstring);
    }
  });

  // -------------------------------------------------------------------------
  // The progress-delivery paths (preference + declared interval)
  // -------------------------------------------------------------------------

  test("progress delivery rejects unknown preferences and out-of-bounds intervals", () => {
    expect([...PROGRESS_PREFERENCES]).toEqual(["event-stream-else-polled", "polled-only"]);
    const cases: readonly [string, unknown, string][] = [
      [
        "unknown preference",
        { preference: "stream-always", pollingIntervalMs: 250 },
        "preference must be one of",
      ],
      [
        "interval below the bound",
        { preference: "polled-only", pollingIntervalMs: MIN_POLLING_INTERVAL_MS - 1 },
        "pollingIntervalMs must be in",
      ],
      [
        "interval above the bound",
        { preference: "polled-only", pollingIntervalMs: MAX_POLLING_INTERVAL_MS + 1 },
        "pollingIntervalMs must be in",
      ],
      [
        "non-integer interval",
        { preference: "polled-only", pollingIntervalMs: 250.5 },
        "pollingIntervalMs must be an integer",
      ],
    ];
    for (const [name, mutation, reasonSubstring] of cases) {
      const verdict = validateTailPacingConfiguration({
        version: 1,
        progressDelivery: mutation,
        timeoutContract: TRACED_CONTRACT,
      });
      expect(verdict.valid, name).toBe(false);
      expect(verdict.valid === false && verdict.reason, name).toContain(reasonSubstring);
    }
  });

  // -------------------------------------------------------------------------
  // THE TIMEOUT-PRESERVATION GATE (the cross-dimension legs)
  // -------------------------------------------------------------------------

  test("THE TIMEOUT GATE G1: a retry schedule whose worst case exceeds the declared budget is rejected", () => {
    // (2 + 1) * 60_000 + 2 * 5_000 = 190_000 fits 300_000 (the fixture is valid).
    expect(
      validateTailPacingConfiguration({
        version: 1,
        retryPacing: RETRY_PACING,
        timeoutContract: TRACED_CONTRACT,
      }),
    ).toEqual({ valid: true });
    // A budget of 150_000 cannot fit the worst case 190_000.
    const verdict = validateTailPacingConfiguration({
      version: 1,
      retryPacing: RETRY_PACING,
      timeoutContract: { attemptTimeoutMs: 60_000, dispatchBudgetMs: 150_000 },
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.valid === false && verdict.reason).toContain(
      "violates the timeout/terminal-failure preservation gate",
    );
    expect(verdict.valid === false && verdict.reason).toContain(
      "190000 exceeds the declared dispatchBudgetMs 150000",
    );
  });

  test("THE TIMEOUT GATE G2: a polling interval beyond the per-attempt timeout is rejected", () => {
    const verdict = validateTailPacingConfiguration({
      version: 1,
      progressDelivery: { preference: "polled-only", pollingIntervalMs: 5_000 },
      timeoutContract: { attemptTimeoutMs: 4_000, dispatchBudgetMs: 60_000 },
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.valid === false && verdict.reason).toContain(
      "progressDelivery.pollingIntervalMs 5000 exceeds the declared attemptTimeoutMs 4000",
    );
  });

  test("the timeout contract's own coherence (budget below one attempt is incoherent)", () => {
    const verdict = validateTailPacingConfiguration({
      version: 1,
      timeoutContract: { attemptTimeoutMs: 60_000, dispatchBudgetMs: 30_000 },
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.valid === false && verdict.reason).toContain(
      "dispatchBudgetMs must not be below attemptTimeoutMs",
    );
  });

  test("the frozen check order is deterministic (the same input yields the byte-identical first rejection)", () => {
    const malformed = {
      version: 9,
      retryPacing: { ...RETRY_PACING, maxRetries: 99 },
    };
    for (let index = 0; index < 5; index += 1) {
      expect(validateTailPacingConfiguration(malformed)).toEqual({
        valid: false,
        reason: "tailPacingConfiguration.version must be one of 1: 9",
      });
    }
  });

  // -------------------------------------------------------------------------
  // The pure mechanics resolutions (data → the applied quantities)
  // -------------------------------------------------------------------------

  test("the backoff schedule: bounded, shaped, ceiling-clamped, jittered with the INJECTED draw", () => {
    const linear = { ...RETRY_PACING, backoff: { ...RETRY_PACING.backoff, jitterFraction: 0 } };
    // Linear: base * attempt (the queue plane's own deterministic shape).
    expect(retryBackoffDelayMs(linear, 1, 0.5)).toBe(250);
    expect(retryBackoffDelayMs(linear, 2, 0.5)).toBe(500);
    expect(retryBackoffDelayMs(linear, 3, 0.5)).toBe(750);
    // Exponential: base * 2^(attempt-1), clamped at the declared ceiling.
    const exponential = {
      ...RETRY_PACING,
      backoff: { shape: "exponential", baseMs: 250, ceilingMs: 5_000, jitterFraction: 0 },
    } as const;
    expect(retryBackoffDelayMs(exponential, 1, 0.5)).toBe(250);
    expect(retryBackoffDelayMs(exponential, 2, 0.5)).toBe(500);
    expect(retryBackoffDelayMs(exponential, 3, 0.5)).toBe(1_000);
    expect(retryBackoffDelayMs(exponential, 5, 0.5)).toBe(4_000);
    expect(retryBackoffDelayMs(exponential, 6, 0.5)).toBe(5_000); // 8000 clamped at the ceiling
    // Jitter: symmetric ±10% around the schedule; the ceiling STILL binds.
    const jittered = {
      ...RETRY_PACING,
      backoff: { ...RETRY_PACING.backoff, baseMs: 4_900, ceilingMs: 5_000, jitterFraction: 0.1 },
    };
    expect(retryBackoffDelayMs(jittered, 1, 0)).toBe(4_410); // 4900 * (1 - 0.1)
    expect(retryBackoffDelayMs(jittered, 1, 1)).toBe(5_000); // 5390 clamped at the ceiling
    expect(retryBackoffDelayMs(jittered, 1, 0.5)).toBe(4_900); // the deterministic schedule
    // Deterministic given the draw: the same draw always yields the same delay.
    expect(retryBackoffDelayMs(jittered, 1, 0.25)).toBe(retryBackoffDelayMs(jittered, 1, 0.25));
  });

  test("the cooldown rule lookup and the cooldown state at dispatch (the PCL-01 vocabulary)", () => {
    expect(cooldownRuleFor(COOLDOWN_DISCIPLINE, "provider-throttle")?.cooldownMs).toBe(45_000);
    expect(cooldownRuleFor(COOLDOWN_DISCIPLINE, "connection-error")).toBeNull();
    expect(cooldownRuleFor(undefined, "provider-5xx")).toBeNull();
    // An unkeyed class cools nothing (absence by omission).
    expect(cooldownStateAtDispatch(COOLDOWN_DISCIPLINE, "connection-error", 0)).toEqual({
      kind: "none",
    });
    // An active throttle cooldown names its class and remaining time.
    expect(cooldownStateAtDispatch(COOLDOWN_DISCIPLINE, "provider-throttle", 5_000)).toEqual({
      kind: "active",
      failureClass: "provider-throttle",
      remainingMs: 40_000,
    });
    // An expired cooldown is the none state.
    expect(cooldownStateAtDispatch(COOLDOWN_DISCIPLINE, "provider-throttle", 45_000)).toEqual({
      kind: "none",
    });
    // No discipline authored: everything is none.
    expect(cooldownStateAtDispatch(undefined, "provider-5xx", 0)).toEqual({ kind: "none" });
  });

  test("the EXPLICIT re-entry admission (expiry vs early-probe — a probe is one dispatch, never a stream)", () => {
    expect([...COOLDOWN_REENTRY_MODES]).toEqual(["expiry", "early-probe"]);
    // No rule: admissible (the class cools nothing).
    expect(cooldownReentryAdmission(COOLDOWN_DISCIPLINE, "connection-error", 0)).toEqual({
      admissible: true,
      basis: "no-rule",
    });
    // Expiry: held until the full duration elapses.
    expect(cooldownReentryAdmission(COOLDOWN_DISCIPLINE, "provider-throttle", 44_999)).toEqual({
      admissible: false,
      basis: "cooldown-active",
      failureClass: "provider-throttle",
      remainingMs: 1,
    });
    expect(cooldownReentryAdmission(COOLDOWN_DISCIPLINE, "provider-throttle", 45_000)).toEqual({
      admissible: true,
      basis: "expired",
    });
    // Early-probe at half the duration: held before, admissible from the probe point.
    expect(cooldownReentryAdmission(COOLDOWN_DISCIPLINE, "provider-5xx", 4_999)).toEqual({
      admissible: false,
      basis: "cooldown-active",
      failureClass: "provider-5xx",
      remainingMs: 1,
    });
    expect(cooldownReentryAdmission(COOLDOWN_DISCIPLINE, "provider-5xx", 5_000)).toEqual({
      admissible: true,
      basis: "probe",
    });
    // A zero-duration cooldown is always expired.
    expect(
      cooldownReentryAdmission(
        { rules: [{ failureClass: "provider-5xx", cooldownMs: 0, reentry: "expiry" }] },
        "provider-5xx",
        0,
      ),
    ).toEqual({ admissible: true, basis: "expired" });
  });

  test("the progress resolution: the transport's typed capability facts drive the selection (the ACR-009 pattern)", () => {
    // A supporting transport + the admitting preference → event-stream.
    expect(resolveProgressDelivery(PROGRESS_DELIVERY, { eventStream: true })).toEqual({
      mode: "event-stream",
    });
    // An unsupported transport → the honest polled fallback with the declared interval.
    expect(resolveProgressDelivery(PROGRESS_DELIVERY, { eventStream: false })).toEqual({
      mode: "polled",
      pollingIntervalMs: 250,
    });
    // The conservative preference polls even where the transport could stream.
    expect(
      resolveProgressDelivery(
        { preference: "polled-only", pollingIntervalMs: 500 },
        { eventStream: true },
      ),
    ).toEqual({ mode: "polled", pollingIntervalMs: 500 });
  });

  test("THE MECHANICS RECORD: the applied mechanics project into the PCL-01 facts and PASS the PCL-01 validation (read-only consumption)", () => {
    // Polled: the interval is a measured latency fact.
    const polledFacts = progressDeliveryFactsOf(
      { mode: "polled", pollingIntervalMs: 250 },
      { kind: "active", failureClass: "provider-throttle", remainingMs: 40_000 },
    );
    expect(polledFacts).toEqual({
      mode: "polled",
      pollingInterval: { kind: "measured", milliseconds: 250 },
      cooldownAtDispatch: {
        kind: "active",
        failureClass: "provider-throttle",
        remainingMs: 40_000,
      },
    });
    // Event-stream: NO polling interval (the PCL-01 incoherent-shape law).
    const streamFacts = progressDeliveryFactsOf({ mode: "event-stream" }, { kind: "none" });
    expect(streamFacts).toEqual({ mode: "event-stream", cooldownAtDispatch: { kind: "none" } });
    expect(JSON.stringify(streamFacts)).not.toContain("pollingInterval");
    // Both shapes pass the PCL-01 facts validation at the boundary —
    // the read-only consumption is mechanically proven.
    expect(validateOptionalOutcomeLatencyFacts(buildFactsWithProgress(polledFacts))).toEqual({
      valid: true,
    });
    expect(validateOptionalOutcomeLatencyFacts(buildFactsWithProgress(streamFacts))).toEqual({
      valid: true,
    });
  });

  // -------------------------------------------------------------------------
  // The wired seam (the adapter): absence-equivalent, fail-closed
  // -------------------------------------------------------------------------

  test("the resolver is INERT when no configuration is authored (the absent verdicts)", () => {
    const absent = createTailPacingResolver({});
    expect(absent.configuration).toBeNull();
    expect(absent.retryDelayFor(2)).toBeUndefined();
    expect(absent.retryAdmits("provider-5xx")).toBe(false);
    expect(absent.cooldownAtDispatch("provider-throttle", 0)).toEqual({ kind: "none" });
    expect(absent.admitCooldownReentry("provider-throttle", 0)).toEqual({
      admissible: true,
      basis: "no-rule",
    });
    expect(absent.resolveProgress({ eventStream: true })).toBeNull();
    expect(absent.progressFacts({ eventStream: true }, { kind: "none" })).toBeNull();
    // The null spelling is the same absent state.
    const nullSpelling = createTailPacingResolver({ configuration: null });
    expect(nullSpelling.retryDelayFor(2)).toBeUndefined();
    expect(nullSpelling.resolveProgress({ eventStream: true })).toBeNull();
  });

  test("the resolver ARMS a valid configuration and resolves every dimension", () => {
    let draw = 0.5;
    const resolver = createTailPacingResolver({
      configuration: FULL_CONFIGURATION,
      jitterDraw: () => draw,
    });
    expect(resolver.configuration).toBe(FULL_CONFIGURATION);
    expect(resolver.retryDelayFor(1)).toBe(250);
    expect(resolver.retryAdmits("provider-5xx")).toBe(true);
    expect(resolver.retryAdmits("policy-denied")).toBe(false);
    expect(resolver.cooldownAtDispatch("provider-throttle", 5_000)).toEqual({
      kind: "active",
      failureClass: "provider-throttle",
      remainingMs: 40_000,
    });
    expect(resolver.admitCooldownReentry("provider-5xx", 6_000)).toEqual({
      admissible: true,
      basis: "probe",
    });
    expect(resolver.resolveProgress({ eventStream: true })).toEqual({ mode: "event-stream" });
    expect(resolver.resolveProgress({ eventStream: false })).toEqual({
      mode: "polled",
      pollingIntervalMs: 250,
    });
    // The mechanics record over the resolver's own resolutions.
    expect(resolver.progressFacts({ eventStream: false }, { kind: "none" })).toEqual({
      mode: "polled",
      pollingInterval: { kind: "measured", milliseconds: 250 },
      cooldownAtDispatch: { kind: "none" },
    });
    // The injected draw drives the jitter (0 → the low edge).
    draw = 0;
    expect(resolver.retryDelayFor(1)).toBe(225); // 250 * (1 - 0.1)
  });

  test("the resolver FAILS CLOSED on a malformed configuration at construction (typed, never a default)", () => {
    let thrown: unknown = null;
    try {
      createTailPacingResolver({
        configuration: {
          ...FULL_CONFIGURATION,
          retryPacing: { ...RETRY_PACING, retryableFailureClasses: ["budget-exhausted"] },
        },
        jitterDraw: () => 0.5,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TailPacingConfigurationError);
    expect((thrown as TailPacingConfigurationError).reason).toContain(
      "cannot include the terminal failure class budget-exhausted",
    );
  });

  test("the resolver REQUIRES the injected draw when retry pacing is authored (the entropy source is never ambient)", () => {
    expect(() =>
      createTailPacingResolver({
        configuration: { version: 1, retryPacing: RETRY_PACING, timeoutContract: TRACED_CONTRACT },
      }),
    ).toThrow(/requires an injected jitterDraw/);
    // Absent retry pacing: no draw needed.
    expect(() =>
      createTailPacingResolver({
        configuration: {
          version: 1,
          progressDelivery: PROGRESS_DELIVERY,
          timeoutContract: TRACED_CONTRACT,
        },
      }),
    ).not.toThrow();
  });
});

/** Wrap one progress block in a minimal valid PCL-01 fact block (the riding-point shape). */
function buildFactsWithProgress(
  progress: ReturnType<typeof progressDeliveryFactsOf>,
): Parameters<typeof validateOptionalOutcomeLatencyFacts>[0] {
  return {
    outcomeClass: "succeeded-first-attempt",
    legs: [
      {
        legId: "dispatch-1",
        route: { provider: "neutral-a", model: "model-a" },
        firstByte: { kind: "measured", milliseconds: 120 },
        completion: { kind: "measured", milliseconds: 340 },
      },
    ],
    attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 2 },
    progress,
    cost: {
      totalIncludingDuplicates: { kind: "measured", microUsd: "1250", source: "settlement" },
      verification: { kind: "measured", microUsd: "80", source: "verification" },
    },
    resolved: true,
    verification: { kind: "proved", outcome: "pass", resultIds: ["vr-1"] },
    basis: {
      executionId: "exec-0001",
      route: { provider: "neutral-a", model: "model-a" },
      revision: 1,
      clockDiscipline: "wall-clock",
    },
  };
}
