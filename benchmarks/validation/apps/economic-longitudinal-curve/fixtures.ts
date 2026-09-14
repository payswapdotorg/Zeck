/**
 * The economic-longitudinal-curve application's deterministic fixtures
 * (VAL-047, AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled world the curve driver and the app execute against:
 *
 *   * the RECORDED CURVE INPUTS — the digest-referenced bundles
 *     resolved from the pinned longitudinal ledgers + the imported
 *     VAL-045 attribution results through the same extractors the
 *     input-integrity oracle verifies against: never copies, never
 *     re-measurements, never re-pricings. The adversarial variants
 *     denature the honest bundles' shapes (the gaming surface the
 *     oracles catch): `regimeNormalizing` (the post-change points'
 *     references + claims pinned at the pre-change revision — the
 *     regime-normalizing catch), `extrapolating` (the fabricated
 *     beyond-evidence point appended — the no-extrapolation catch),
 *     `residualHiding` (the attribution bundles' claimed residuals
 *     zeroed — the residual-hiding catch), `remeasurement` (a
 *     re-measured model cost on the generation-2 bundle — the
 *     re-measurement masquerade catch), `postHocExclusion` (the
 *     pre-registered generation-4 point dropped from the executed set
 *     — the post-hoc exclusion catch). The ROW-level dishonest shapes
 *     (the cherry-picked window, the cohort-hiding declaration, the
 *     below-minimum verdict claim) live in the corpus's probe rows;
 *   * the fake accounting rails re-export (the REAL recorder +
 *     evaluation binding the driver seals the verified inputs through)
 *     and the fake ledger/lifecycle/submission-seam/tick-clock
 *     re-exports IMPORTED from the VAL-040 fixtures (never copied,
 *     never modified);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam (the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary, the
 *     fabrication knobs).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone (the recorded ledgers + the imported attribution economics are
 * themselves deterministic).
 */

import type { TransportImplementation } from "../../harness/harness";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  type TickClock,
} from "../economic-baseline/fixtures";
import {
  CURVE_CORPUS,
  curveLedgerById,
  fabricatedExtrapolatedPointOf,
  honestCurveInputsOf,
} from "./corpus";
import type {
  CurveAdversarialKind,
  CurveAttributionInput,
  CurveCorpusRow,
  CurvePointInput,
} from "./driver";
import { recordedCurvePointDigestOf } from "./driver";

/** The REAL accounting rails re-export (the driver's sealing binding). */
export { createRealAccountingRails } from "../economic-baseline/driver";
export { honestCurveInputsOf } from "./corpus";
export type { HonestCurveInputs } from "./corpus";
export type { TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The adversarial input knobs (the discrimination battery's fakes)
// ---------------------------------------------------------------------------

/** The adversarial input knobs (each names the criterion it must FAIL). */
export interface CurveAdversarialInputKnobs {
  /** The post-change points pinned at the pre-change model revision (the regime normalizing). */
  readonly regimeNormalizing?: boolean;
  /** The fabricated beyond-evidence point appended (the extrapolation). */
  readonly extrapolating?: boolean;
  /** The attribution bundles' claimed residuals zeroed (the residual hiding). */
  readonly residualHiding?: boolean;
  /** A re-measured model cost on the generation-2 bundle (the re-measurement masquerade). */
  readonly remeasurement?: boolean;
  /** The pre-registered generation-4 point dropped from the executed set (the post-hoc exclusion). */
  readonly postHocExclusion?: boolean;
  /** A claimed estimate cost basis on every point (the estimate/measure catch). */
  readonly estimateBasis?: boolean;
}

/**
 * Apply one adversarial shape to the honest curve inputs (PURE). The
 * variants denature the bundles' REFERENCES and CLAIMS (outside the
 * recorded facts where possible — the gaming surface); the
 * re-measurement knob denatures the FACTS themselves (the integrity
 * catch's surface).
 */
export function applyCurveAdversarialVariant(
  inputs: readonly CurvePointInput[],
  attribution: readonly CurveAttributionInput[],
  knobs: CurveAdversarialInputKnobs,
): {
  readonly points: readonly CurvePointInput[];
  readonly attribution: readonly CurveAttributionInput[];
} {
  if (knobs.regimeNormalizing === true) {
    return {
      points: inputs.map((input) =>
        input.facts.modelPriceRevision === "rev-002"
          ? {
              ...input,
              modelPriceRevision: "rev-001",
              claimed: { ...input.claimed, modelPriceRevision: "rev-001" },
            }
          : input,
      ),
      attribution,
    };
  }
  if (knobs.extrapolating === true) {
    const ledger = curveLedgerById(inputs[0]?.facts.workloadClass ?? "");
    const last = [...(ledger?.points ?? [])]
      .sort((left, right) => left.generation - right.generation)
      .at(-1);
    if (last === undefined) {
      return { points: inputs, attribution };
    }
    const fabricated = fabricatedExtrapolatedPointOf(last.workloadClass, last.generation + 1);
    return {
      points: [
        ...inputs,
        {
          workloadClass: fabricated.workloadClass,
          generation: fabricated.generation,
          recordedDigest: recordedCurvePointDigestOf(fabricated),
          modelPriceRevision: fabricated.modelPriceRevision,
          substratePriceRevision: fabricated.substratePriceRevision,
          facts: fabricated,
        },
      ],
      attribution,
    };
  }
  if (knobs.residualHiding === true) {
    return {
      points: inputs,
      attribution: attribution.map((bundle) => ({
        ...bundle,
        claimed: { ...bundle.claimed, residualMicroUsd: 0 },
      })),
    };
  }
  if (knobs.remeasurement === true) {
    return {
      points: inputs.map((input) =>
        input.facts.generation === 2
          ? {
              ...input,
              facts: {
                ...input.facts,
                measuredModelCostMicroUsd: input.facts.measuredModelCostMicroUsd + 1,
              },
            }
          : input,
      ),
      attribution,
    };
  }
  if (knobs.postHocExclusion === true) {
    return {
      points: inputs.filter((input) => input.facts.generation !== 4),
      attribution,
    };
  }
  if (knobs.estimateBasis === true) {
    return {
      points: inputs.map((input) => ({
        ...input,
        claimed: { ...input.claimed, costBasis: "estimate" as const },
      })),
      attribution,
    };
  }
  return { points: inputs, attribution };
}

/** The knobs of one declared adversarial variant kind (PURE). */
export function knobsOfCurveVariant(kind: CurveAdversarialKind): CurveAdversarialInputKnobs {
  switch (kind) {
    case "cherry-picked-window":
      // The cherry-picked window is a ROW-level dishonesty (the
      // declared window narrower than the recorded span) — the inputs
      // stay the honest recorded bundles.
      return {};
    case "regime-normalizing":
      return { regimeNormalizing: true };
    case "extrapolating":
      return { extrapolating: true };
    case "residual-hiding":
      return { residualHiding: true };
    case "cohort-hiding":
      // The cohort hiding is a ROW-level dishonesty (the declared
      // cohorts misreporting the regressing cohort) — the inputs stay
      // the honest recorded bundles.
      return {};
    case "post-hoc-exclusion":
      return { postHocExclusion: true };
    case "sample-size-violation":
      // The sample-size violation is a ROW-level dishonesty (the
      // below-minimum verdict claim) — the inputs stay the honest
      // recorded bundles.
      return {};
    case "remeasurement":
      return { remeasurement: true };
  }
}

/**
 * The curve inputs of one corpus row (DETERMINISTIC): the honest
 * digest-referenced bundles resolved from the recorded ledgers + the
 * imported attribution economics, with the row's declared adversarial
 * variant applied when the row is a probe (the probe rows' expected
 * terminals pin exactly these denatured shapes — the cherry-picked
 * window, the cohort-hiding declaration and the below-minimum verdict
 * claim are ROW-level dishonesties whose inputs stay the honest
 * recorded bundles).
 */
export function curveInputsForRow(row: CurveCorpusRow): {
  readonly points: readonly CurvePointInput[];
  readonly attribution: readonly CurveAttributionInput[];
} {
  const honest = honestCurveInputsOf(row);
  if (row.adversarial === undefined) {
    return { points: honest.points, attribution: honest.attribution };
  }
  return applyCurveAdversarialVariant(
    honest.points,
    honest.attribution,
    knobsOfCurveVariant(row.adversarial),
  );
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/**
 * The transport-level fake public API implementing the platform's OWN
 * semantics at the customer boundary (mirroring the VAL-040 fake world
 * over THIS slice's corpus):
 *
 *  - POST /executions — the create/replay semantics (the first
 *    insert's synchronous critical section wins; a same-fingerprint
 *    re-issue replays the committed receipt; a different fingerprint
 *    gets the typed 409 IDEMPOTENCY_KEY_REUSED);
 *  - GET /executions/:id — the row settles to its honest outcome on
 *    the read path, unless an override knob is set;
 *  - GET /executions/:id/results — the honest result package: the
 *    COMPLETED rows carry all-PASS verification statuses.
 *
 * Discrimination knobs: `terminal`/`verificationStatuses` override the
 * honest outcome; `fabricatePassWithFail` settles a FAILED-expected
 * row into a COMPLETED terminal WITH a FAIL verification status (the
 * app-level adversarial probe).
 */
export function createCurveFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** Override the honest verification statuses (the discrimination knob). */
  readonly verificationStatuses?: readonly string[];
  /** The adversarial knob: COMPLETED terminal WITH a FAIL status. */
  readonly fabricatePassWithFail?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<
    string,
    { id: string; key: string; taskRowId: string; status: string; createdAt: number }
  >;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<
    string,
    { id: string; key: string; taskRowId: string; status: string; createdAt: number }
  >();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  /** The row's honest outcome shape (derived from the corpus itself). */
  const honestOutcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const row = CURVE_CORPUS.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) {
      return { terminal: "FAILED", statuses: ["FAIL"] };
    }
    if (row.expected.terminal === "COMPLETED") {
      return { terminal: "COMPLETED", statuses: ["PASS", "PASS"] };
    }
    // The honest FAILED shape: the failure criterion FAILs visibly.
    return { terminal: "FAILED", statuses: ["FAIL", "PASS"] };
  };

  /** The effective outcome for one row (the knobs override the honest shape). */
  const outcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const honest = honestOutcomeFor(rowId);
    if (options.fabricatePassWithFail === true && honest.terminal === "FAILED") {
      // The ADVERSARIAL fabrication: the FAILED-expected row settles
      // COMPLETED while its verification carries a FAIL status.
      return { terminal: "COMPLETED", statuses: ["FAIL", "PASS"] };
    }
    return {
      terminal: options.terminal ?? honest.terminal,
      statuses:
        options.verificationStatuses === undefined
          ? honest.statuses
          : [...options.verificationStatuses],
    };
  };

  const fingerprintOf = (body: unknown): string => JSON.stringify(body ?? null);

  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    await clock.tick();

    if (url.endsWith("/executions") && method === "POST") {
      const headers = (init as { headers?: Record<string, string> }).headers ?? {};
      const key = headers["idempotency-key"] ?? headers["Idempotency-Key"] ?? "";
      if (key.length === 0) {
        return jsonResponse(422, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "POST routes require an Idempotency-Key header",
          retryable: false,
        });
      }
      const body = JSON.parse(String((init as { body?: string }).body ?? "null")) as Record<
        string,
        unknown
      >;
      const fingerprint = fingerprintOf(body);
      const existing = records.get(key);
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        const row = rows.get(existing.executionId);
        return jsonResponse(201, {
          executionId: existing.executionId,
          applicationId: body.applicationId ?? "app-1",
          status: row?.status ?? "CREATED",
          createdAt: new Date(row?.createdAt ?? 0).toISOString(),
          replayed: true,
          lastEventSequence: 1,
        });
      }
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        return jsonResponse(409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          retryable: false,
        });
      }
      sequence += 1;
      createdExecutions += 1;
      const id = `fake-exec-${sequence}`;
      rows.set(id, {
        id,
        key,
        taskRowId: String((body.task as { rowId?: unknown } | null)?.rowId ?? ""),
        status: "CREATED",
        createdAt: clock.now().getTime(),
      });
      records.set(key, { fingerprint, executionId: id });
      return jsonResponse(201, {
        executionId: id,
        applicationId: body.applicationId ?? "app-1",
        status: "CREATED",
        createdAt: new Date(clock.now().getTime()).toISOString(),
        replayed: false,
        lastEventSequence: 1,
      });
    }

    const execMatch = url.match(/\/executions\/([^/]+)$/);
    if (execMatch !== null && method === "GET") {
      const row = rows.get(execMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      // The row settles on the read path — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = outcomeFor(row.taskRowId).terminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "economic-longitudinal-curve.experiment.v1", input: "curve" },
        constraints: null,
        metadata: {},
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(clock.now().getTime()).toISOString(),
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
      });
    }

    const resultMatch = url.match(/\/executions\/([^/]+)\/results$/);
    if (resultMatch !== null && method === "GET") {
      const row = rows.get(resultMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      const outcome = outcomeFor(row.taskRowId);
      const pass = row.status === "COMPLETED";
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "longitudinal-ledger",
          model: "recorded-longitudinal-history",
          strategyClass: "economic-longitudinal-curve",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "0", currency: "usd" } : null,
        usage: null,
        outputArtifacts: [],
        verification: outcome.statuses.map((status, index) => ({
          id: `v${index + 1}`,
          executionId: row.id,
          criterionId: `criterion-${index + 1}`,
          strategy: "deterministic",
          status,
          recordedBy: "fake-platform",
        })),
        warnings: [],
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
      });
    }

    return jsonResponse(500, {
      code: "INTERNAL",
      message: `unmapped fake route ${url}`,
      retryable: true,
    });
  };

  return {
    transport,
    get createdExecutions() {
      return createdExecutions;
    },
    rows,
    records,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
