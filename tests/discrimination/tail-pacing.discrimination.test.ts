/**
 * Discrimination: the declarative tail-pacing configuration (executions
 * module domain + the wired seam, ACR-010 §3–§4; work order PCL-002).
 *
 * Proves the weakened protections FAIL (the discrimination discipline —
 * tests/unit proves the happy paths; this suite proves each protection
 * is load-bearing and each mechanics dimension discriminates ON/OFF
 * through the DECLARED configuration alone — never an ambient flag):
 *
 *  - D1 ABSENCE DISCRIMINATION AT THE SEAM: for every mechanics
 *    dimension, the absent dependency and the authored-but-dimension-
 *    omitted configuration produce BYTE-IDENTICAL verdicts (both are
 *    the absent spelling — the default-off law), and only AUTHORITY the
 *    dimension (a declared configuration field) flips the verdicts.
 *    No ambient input participates: two resolvers over the same
 *    configuration and the same draw produce byte-identical verdict
 *    streams.
 *  - D2 THE MUTATION RECORD: every single-field weakening of a valid
 *    configuration (unknown vocabulary members, out-of-bounds values,
 *    the terminal-failure-masking retryable set, the timeout-violating
 *    schedule, the incoherent probe shapes) flips the validation
 *    verdict AND the seam construction fails closed — each rejection
 *    is LOAD-BEARING (the unmutated fixture passes).
 *  - D3 NO SILENT DEFAULTING: an unknown enum member never coerces to
 *    a member; a dimension omitted is ABSENT, never a hidden default
 *    posture; the preservation gate's rejections name both sides'
 *    numbers.
 *  - D4 THE MECHANICS TABLE (the fixed-corpus replay pin): the seam's
 *    full verdict stream over a fixed query corpus, evaluated under
 *    the absent / partial / armed configurations, is deterministic and
 *    sha256-pinned — any drift in any resolution changes the table and
 *    fails the pin; the ARMED table differs from the ABSENT table
 *    exactly on the declared dimensions (the on/off discrimination).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createTailPacingResolver } from "../../src/modules/executions/adapters/tail-pacing";
import type {
  DispatchCooldownState,
  OutcomeFailureClass,
} from "../../src/modules/executions/domain/outcome-latency-facts";
import { OUTCOME_FAILURE_CLASSES } from "../../src/modules/executions/domain/outcome-latency-facts";
import type { TailPacingConfiguration } from "../../src/modules/executions/domain/tail-pacing-configuration";
import { validateTailPacingConfiguration } from "../../src/modules/executions/domain/tail-pacing-configuration";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// The fixtures (the unit suite's own vocabulary — hermetic, declared)
// ---------------------------------------------------------------------------

const TRACED_CONTRACT = { attemptTimeoutMs: 60_000, dispatchBudgetMs: 300_000 } as const;

const RETRY_PACING = {
  maxRetries: 2,
  backoff: { shape: "linear", baseMs: 250, ceilingMs: 5_000, jitterFraction: 0.1 },
  retryableFailureClasses: ["provider-5xx", "provider-throttle", "connection-error"],
} as const;

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

const FIXED_DRAW = (): number => 0.5;

/** The fixed seam-query corpus (the verdict stream — deterministic given the configuration). */
const QUERY_CORPUS = [
  "retryDelay:1",
  "retryDelay:2",
  "retryDelay:3",
  "retryAdmits:provider-5xx",
  "retryAdmits:provider-throttle",
  "retryAdmits:provider-timeout",
  "retryAdmits:connection-error",
  "retryAdmits:verification-retry",
  "retryAdmits:budget-exhausted",
  "retryAdmits:policy-denied",
  "cooldown:provider-throttle:0",
  "cooldown:provider-throttle:10000",
  "cooldown:provider-throttle:44999",
  "cooldown:provider-5xx:0",
  "cooldown:provider-5xx:4999",
  "cooldown:provider-5xx:5000",
  "cooldown:connection-error:0",
  "reentry:provider-throttle:44999",
  "reentry:provider-throttle:45000",
  "reentry:provider-5xx:4999",
  "reentry:provider-5xx:5000",
  "reentry:connection-error:0",
  "progress:eventStream=true",
  "progress:eventStream=false",
  "facts:eventStream=true:none",
  "facts:eventStream=false:active-throttle-5000",
] as const;

/** The corpus's failure-class token → the vocabulary member (checked against the closed PCL-01 vocabulary, never cast). */
const FAILURE_CLASS_BY_TOKEN = new Map<string, OutcomeFailureClass>(
  OUTCOME_FAILURE_CLASSES.map((member) => [member, member] as const),
);
function failureClassOf(token: string | undefined): OutcomeFailureClass {
  const member = token === undefined ? undefined : FAILURE_CLASS_BY_TOKEN.get(token);
  if (member === undefined) {
    throw new Error(`unknown failure-class token in the query corpus: ${token}`);
  }
  return member;
}

function verdictStream(configuration: TailPacingConfiguration | null | undefined): string {
  const resolver = createTailPacingResolver({
    ...(configuration === undefined ? {} : { configuration }),
    ...(configuration?.retryPacing === undefined ? {} : { jitterDraw: FIXED_DRAW }),
  });
  const lines: string[] = [];
  for (const query of QUERY_CORPUS) {
    const [kind, a, b, c] = query.split(":");
    switch (kind) {
      case "retryDelay":
        lines.push(`${query}\t${JSON.stringify(resolver.retryDelayFor(Number(a)))}`);
        break;
      case "retryAdmits":
        lines.push(`${query}\t${JSON.stringify(resolver.retryAdmits(failureClassOf(a)))}`);
        break;
      case "cooldown":
        lines.push(
          `${query}\t${JSON.stringify(resolver.cooldownAtDispatch(failureClassOf(a), Number(b)))}`,
        );
        break;
      case "reentry":
        lines.push(
          `${query}\t${JSON.stringify(resolver.admitCooldownReentry(failureClassOf(a), Number(b)))}`,
        );
        break;
      case "progress":
        lines.push(
          `${query}\t${JSON.stringify(resolver.resolveProgress({ eventStream: a === "eventStream=true" }))}`,
        );
        break;
      case "facts": {
        const cooldown: DispatchCooldownState =
          b === "active-throttle-5000"
            ? { kind: "active", failureClass: "provider-throttle", remainingMs: 5_000 }
            : { kind: "none" };
        lines.push(
          `${query}\t${JSON.stringify(
            resolver.progressFacts({ eventStream: a === "eventStream=true" }, cooldown),
          )}`,
        );
        break;
      }
      default:
        throw new Error(`unknown query kind ${kind} (${c})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

describe("discrimination: the declarative tail-pacing configuration (PCL-002 — on/off via the declared configuration only)", () => {
  // -------------------------------------------------------------------------
  // D1 — the absence discrimination at the seam (default-off, per dimension)
  // -------------------------------------------------------------------------

  test("D1a the absent dependency and the dimension-omitted configuration are BYTE-IDENTICAL (both the absent spelling)", () => {
    const absentStream = verdictStream(undefined);
    // A configuration with NO dimension authored (the contract alone):
    // every verdict is the absent spelling, byte-identical to no
    // configuration at all.
    const allOffStream = verdictStream({
      version: 1,
      timeoutContract: TRACED_CONTRACT,
    });
    expect(allOffStream).toBe(absentStream);
    // Each dimension omitted individually: only THAT dimension's
    // verdicts are absent; the others stay armed (below). The null
    // spelling matches the undefined spelling.
    const nullStream = createTailPacingResolver({ configuration: null });
    expect(nullStream.retryDelayFor(1)).toBeUndefined();
    expect(nullStream.resolveProgress({ eventStream: true })).toBeNull();
  });

  test("D1b each mechanics dimension flips ON only through its declared configuration field", () => {
    const absent = createTailPacingResolver({});
    // Retry pacing only: the retry verdicts arm, the others stay absent.
    const retryOnly = createTailPacingResolver({
      configuration: { version: 1, retryPacing: RETRY_PACING, timeoutContract: TRACED_CONTRACT },
      jitterDraw: FIXED_DRAW,
    });
    expect(retryOnly.retryDelayFor(1)).toBe(250);
    expect(absent.retryDelayFor(1)).toBeUndefined();
    expect(retryOnly.cooldownAtDispatch("provider-throttle", 0)).toEqual({ kind: "none" });
    expect(retryOnly.resolveProgress({ eventStream: true })).toBeNull();
    // Cooldown discipline only.
    const cooldownOnly = createTailPacingResolver({
      configuration: {
        version: 1,
        cooldownDiscipline: COOLDOWN_DISCIPLINE,
        timeoutContract: TRACED_CONTRACT,
      },
    });
    expect(cooldownOnly.retryDelayFor(1)).toBeUndefined();
    expect(cooldownOnly.cooldownAtDispatch("provider-throttle", 0)).toEqual({
      kind: "active",
      failureClass: "provider-throttle",
      remainingMs: 45_000,
    });
    expect(cooldownOnly.resolveProgress({ eventStream: true })).toBeNull();
    // Progress delivery only.
    const progressOnly = createTailPacingResolver({
      configuration: {
        version: 1,
        progressDelivery: PROGRESS_DELIVERY,
        timeoutContract: TRACED_CONTRACT,
      },
    });
    expect(progressOnly.retryDelayFor(1)).toBeUndefined();
    expect(progressOnly.cooldownAtDispatch("provider-throttle", 0)).toEqual({ kind: "none" });
    expect(progressOnly.resolveProgress({ eventStream: true })).toEqual({ mode: "event-stream" });
  });

  test("D1c no ambient input participates: same configuration + same draw → byte-identical verdict streams", () => {
    const first = verdictStream(FULL_CONFIGURATION);
    const second = verdictStream(FULL_CONFIGURATION);
    expect(second).toBe(first);
    // The verdicts are a function of the DECLARED configuration only —
    // the only seam input beyond it is the injected jitter draw (the
    // composition's own entropy source, tested here at a fixed draw).
    expect(first).not.toBe(verdictStream(undefined));
  });

  // -------------------------------------------------------------------------
  // D2 — the mutation record (every weakening is rejected, load-bearing)
  // -------------------------------------------------------------------------

  test("D2a the unmutated fixture passes — every rejection below is load-bearing", () => {
    expect(validateTailPacingConfiguration(FULL_CONFIGURATION)).toEqual({ valid: true });
    expect(() =>
      createTailPacingResolver({ configuration: FULL_CONFIGURATION, jitterDraw: FIXED_DRAW }),
    ).not.toThrow();
  });

  test("D2b each single-field weakening flips the validation verdict AND fails the seam closed, naming the field", () => {
    // Each mutator hands the seam an intentionally out-of-contract
    // product (the runtime gate is what must catch it — the typed
    // surface is what a mis-typed composer would have to defeat).
    const mutations: readonly [string, (config: TailPacingConfiguration) => unknown, string][] = [
      ["the wrong version", (c) => ({ ...c, version: 2 }), "version must be one of 1"],
      [
        "the missing timeout contract (the gate is never ambient)",
        (c) => ({ version: 1, retryPacing: c.retryPacing }) as TailPacingConfiguration,
        "timeoutContract is required",
      ],
      [
        "the terminal-failure-masking retryable set",
        (c) => ({
          ...c,
          retryPacing: {
            ...RETRY_PACING,
            retryableFailureClasses: ["policy-denied"],
          },
        }),
        "cannot include the terminal failure class policy-denied",
      ],
      [
        "the unknown backoff shape",
        (c) => ({
          ...c,
          retryPacing: { ...RETRY_PACING, backoff: { ...RETRY_PACING.backoff, shape: "poly" } },
        }),
        "backoff.shape must be one of linear|exponential",
      ],
      [
        "the ceiling below the base",
        (c) => ({
          ...c,
          retryPacing: { ...RETRY_PACING, backoff: { ...RETRY_PACING.backoff, ceilingMs: 100 } },
        }),
        "ceilingMs must not be below baseMs",
      ],
      [
        "the timeout-violating retry schedule",
        (c) => ({
          ...c,
          timeoutContract: { attemptTimeoutMs: 60_000, dispatchBudgetMs: 100_000 },
        }),
        "violates the timeout/terminal-failure preservation gate",
      ],
      [
        "the polling interval beyond the attempt timeout",
        (c) => ({
          ...c,
          progressDelivery: { preference: "polled-only", pollingIntervalMs: 5_000 },
          timeoutContract: { attemptTimeoutMs: 4_000, dispatchBudgetMs: 60_000 },
        }),
        "pollingIntervalMs 5000 exceeds the declared attemptTimeoutMs 4000",
      ],
      [
        "the duplicate cooldown rule",
        (c) => ({
          ...c,
          cooldownDiscipline: {
            rules: [...COOLDOWN_DISCIPLINE.rules, { ...COOLDOWN_DISCIPLINE.rules[0] }],
          },
        }),
        "must not carry duplicate rules for provider-throttle",
      ],
      [
        "the probe fraction riding expiry",
        (c) => ({
          ...c,
          cooldownDiscipline: {
            rules: [
              {
                failureClass: "provider-5xx",
                cooldownMs: 1000,
                reentry: "expiry",
                probeAtFraction: 0.5,
              },
            ],
          },
        }),
        "probeAtFraction cannot ride reentry expiry",
      ],
      [
        "the unknown progress preference",
        (c) => ({
          ...c,
          progressDelivery: { preference: "best-effort", pollingIntervalMs: 250 },
        }),
        "preference must be one of event-stream-else-polled|polled-only",
      ],
      [
        "the incoherent budget (below one attempt)",
        (c) => ({
          ...c,
          timeoutContract: { attemptTimeoutMs: 60_000, dispatchBudgetMs: 59_999 },
        }),
        "dispatchBudgetMs must not be below attemptTimeoutMs",
      ],
    ];
    for (const [name, mutate, reasonSubstring] of mutations) {
      const mutated = mutate(FULL_CONFIGURATION);
      const verdict = validateTailPacingConfiguration(mutated);
      expect(verdict.valid, `${name}: validation rejects`).toBe(false);
      expect(verdict.valid === false && verdict.reason, `${name}: names the field`).toContain(
        reasonSubstring,
      );
      // The seam fails closed on the same mutation (never a silent
      // default, never a partial arm).
      expect(
        () =>
          createTailPacingResolver({
            configuration: mutated as TailPacingConfiguration,
            jitterDraw: FIXED_DRAW,
          }),
        `${name}: the seam fails closed`,
      ).toThrow(reasonSubstring);
    }
  });

  // -------------------------------------------------------------------------
  // D3 — no silent defaulting
  // -------------------------------------------------------------------------

  test("D3a unknown enum members never coerce to a member (the honest rejection names the value)", () => {
    const cases: readonly [string, unknown][] = [
      [
        "backoff shape",
        {
          version: 1,
          retryPacing: {
            ...RETRY_PACING,
            backoff: { ...RETRY_PACING.backoff, shape: "geometric" },
          },
          timeoutContract: TRACED_CONTRACT,
        },
      ],
      [
        "re-entry mode",
        {
          version: 1,
          cooldownDiscipline: {
            rules: [{ failureClass: "provider-5xx", cooldownMs: 1000, reentry: "adaptive" }],
          },
          timeoutContract: TRACED_CONTRACT,
        },
      ],
      [
        "progress preference",
        {
          version: 1,
          progressDelivery: { preference: "hybrid", pollingIntervalMs: 250 },
          timeoutContract: TRACED_CONTRACT,
        },
      ],
    ];
    for (const [name, config] of cases) {
      const verdict = validateTailPacingConfiguration(config);
      expect(verdict.valid, `${name}: rejected, never defaulted`).toBe(false);
    }
  });

  test("D3b a dimension omitted is ABSENT, never a hidden default posture (the reverse mutation arms it)", () => {
    // Omitted cooldown discipline → no cooldown state, ever.
    const noCooldown = createTailPacingResolver({
      configuration: { version: 1, retryPacing: RETRY_PACING, timeoutContract: TRACED_CONTRACT },
      jitterDraw: FIXED_DRAW,
    });
    expect(noCooldown.cooldownAtDispatch("provider-throttle", 0)).toEqual({ kind: "none" });
    expect(noCooldown.admitCooldownReentry("provider-throttle", 0)).toEqual({
      admissible: true,
      basis: "no-rule",
    });
    // Authoring the dimension arms it — the flip is the configuration's
    // alone.
    const withCooldown = createTailPacingResolver({
      configuration: {
        version: 1,
        retryPacing: RETRY_PACING,
        cooldownDiscipline: COOLDOWN_DISCIPLINE,
        timeoutContract: TRACED_CONTRACT,
      },
      jitterDraw: FIXED_DRAW,
    });
    expect(withCooldown.cooldownAtDispatch("provider-throttle", 0)).toEqual({
      kind: "active",
      failureClass: "provider-throttle",
      remainingMs: 45_000,
    });
    expect(withCooldown.admitCooldownReentry("provider-throttle", 0)).toEqual({
      admissible: false,
      basis: "cooldown-active",
      failureClass: "provider-throttle",
      remainingMs: 45_000,
    });
  });

  // -------------------------------------------------------------------------
  // D4 — the mechanics table (the fixed-corpus replay pin)
  // -------------------------------------------------------------------------

  test("D4 the seam's verdict stream is deterministic and sha256-pinned; the ARMED table differs from the ABSENT table exactly on the declared dimensions", () => {
    const absentTable = verdictStream(undefined);
    const armedTable = verdictStream(FULL_CONFIGURATION);
    // Byte-identical re-computation (pure and total given the draw).
    expect(sha256(absentTable)).toBe(sha256(verdictStream(undefined)));
    expect(sha256(armedTable)).toBe(sha256(verdictStream(FULL_CONFIGURATION)));
    // The pinned digests (any drift in any resolution changes the
    // table and fails the pin).
    expect(sha256(absentTable)).toBe(
      "3f860824bee3607790d52ad8661a9972c4e5c31515c96a252776fff60bbafef6",
    );
    expect(sha256(armedTable)).toBe(
      "639c113e31a64e98f56cac4be529575b19d9f7827c4d8fbd765551968a0b1642",
    );
    // THE ON/OFF DISCRIMINATION: the armed table differs from the
    // absent table (the mechanics are armed), and EVERY differing line
    // is a declared dimension's verdict (retry delay, retry admission,
    // cooldown, re-entry, progress) — no line differs by ambient input.
    const absentLines = absentTable.split("\n");
    const armedLines = armedTable.split("\n");
    expect(absentLines).toHaveLength(armedLines.length);
    const differing = absentLines
      .map((line, index) => [line, armedLines[index] as string] as const)
      .filter(([a, b]) => a !== b);
    // 26 queries; the absent spellings that stay absent under the armed
    // configuration are exactly the non-declared ones (connection-error
    // cooldown, verification-retry admission). Every other declared
    // dimension's verdict changed.
    expect(differing.length).toBeGreaterThan(10);
    for (const [absentLine, armedLine] of differing) {
      const query = absentLine.split("\t")[0];
      expect(armedLine.startsWith(`${query}\t`), `${query}: the query column is stable`).toBe(true);
    }
  });
});
