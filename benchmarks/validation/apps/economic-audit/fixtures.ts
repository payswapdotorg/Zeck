/**
 * The economic-audit application's deterministic fixtures (VAL-049,
 * AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled world the audit driver and the app execute against:
 *
 *   * the GAMING PROBE builders — every gaming vector's denatured
 *     shape applied to the HONEST recorded inputs (resolved through
 *     the final integrated machinery's own extractors — never copies,
 *     never re-measurements) and probed against the FINAL integrated
 *     machinery's own oracles (the input-integrity catch, the
 *     estimate-measure-separation catch, the weighting-disclosure
 *     catch, the favorable-subset catch over the dishonest scope
 *     shapes) — each probe result carrying the NAMED mechanism;
 *   * the fake ledger/lifecycle/submission-seam/tick-clock re-exports
 *     IMPORTED from the VAL-040 fixtures (never copied, never
 *     modified) and the REAL accounting rails re-export;
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam (the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary, the
 *     fabrication knobs).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone.
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
  HEADLINE_COHORT,
  honestCompetitiveInputsOf,
  RECORDED_COMPETITIVE_CLASSES,
} from "../economic-competitive-benchmark/corpus";
import type {
  CompetitiveCorpusRow,
  RecordedCompetitiveArm,
} from "../economic-competitive-benchmark/driver";
import {
  deriveCompetitiveInputIntegrity,
  deriveEstimateMeasureSeparation,
  deriveWeightingDisclosure,
} from "../economic-competitive-benchmark/driver";
import { AUDIT_CORPUS } from "./corpus";
import type { AuditCorpusRow, GamingProbeResult, GamingVector } from "./driver";
import { GAMING_MECHANISM_OF, offlineRowIdsOf } from "./driver";

/** The REAL accounting rails re-export (the driver's sealing binding). */
export { createRealAccountingRails } from "../economic-baseline/driver";
export { honestCompetitiveInputsOf } from "../economic-competitive-benchmark/corpus";
export type { TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The gaming variants (the denatured input shapes — PURE)
// ---------------------------------------------------------------------------

/** The headline cohort's HONEST recorded inputs (the probe basis — resolved, never copied). */
const HEADLINE_INPUTS: readonly RecordedCompetitiveArm[] = honestCompetitiveInputsOf(
  HEADLINE_COHORT.armSet,
);

/**
 * Apply ONE gaming vector's denaturing to the honest recorded inputs
 * (PURE — the gaming surface): the input-level vectors denature the
 * arm bundles' facts (the digest-bound recorded shape); the
 * estimate-conflation vector denatures the CLAIMED surface (the
 * claimed measured cost conflated with the planner estimate).
 */
export function applyGamingVariant(
  arms: readonly RecordedCompetitiveArm[],
  vector: GamingVector,
): readonly RecordedCompetitiveArm[] {
  switch (vector) {
    case "quality-inflation":
      return arms.map((arm) => {
        if (arm.reference.armKind !== "zeck") {
          return arm;
        }
        const inflated = arm.facts.resolvedCount + 1;
        return {
          ...arm,
          facts: {
            ...arm.facts,
            resolvedCount: inflated,
            costPerResolvedMicroUsd:
              inflated > 0
                ? (BigInt(arm.facts.measuredCostMicroUsd) / BigInt(inflated)).toString()
                : null,
          },
        };
      });
    case "latency-omission":
      return arms.map((arm) => ({
        ...arm,
        facts: {
          ...arm.facts,
          rounds: arm.facts.rounds.map((round) => ({ ...round, latencyMs: 0 })),
        },
      }));
    case "failure-hiding":
      return arms.map((arm) => {
        const kept = arm.facts.rounds.filter((round) => round.resolved);
        const measured = kept.reduce(
          (total, round) => total + BigInt(round.measuredCostMicroUsd),
          0n,
        );
        return {
          ...arm,
          facts: {
            ...arm.facts,
            rounds: kept,
            runCount: kept.length,
            resolvedCount: kept.length,
            // The failure costs vanish: the retry overhead, the failed
            // attempt count and the failed rounds' share all zeroed —
            // the amortized failure basis destroyed.
            failedAttemptsCount: 0,
            retryOverheadMicroUsd: "0",
            failedRoundsMicroUsd: "0",
            measuredCostMicroUsd: measured.toString(),
          },
        };
      });
    case "regime-normalization":
      return arms.map((arm) => ({
        ...arm,
        facts: {
          ...arm.facts,
          measuredCostMicroUsd: ((BigInt(arm.facts.measuredCostMicroUsd) * 4n) / 5n).toString(),
        },
      }));
    case "re-measurement-masquerade":
      return arms.map((arm) => {
        if (arm.reference.armKind !== "zeck" || arm.facts.rounds.length === 0) {
          return arm;
        }
        const first = arm.facts.rounds[0];
        if (first === undefined) {
          return arm;
        }
        const rounds = [
          { ...first, measuredCostMicroUsd: (BigInt(first.measuredCostMicroUsd) + 1n).toString() },
          ...arm.facts.rounds.slice(1),
        ];
        const measured = rounds.reduce(
          (total, round) => total + BigInt(round.measuredCostMicroUsd),
          0n,
        );
        return {
          ...arm,
          facts: { ...arm.facts, rounds, measuredCostMicroUsd: measured.toString() },
        };
      });
    case "estimate-conflation":
      return arms.map((arm) => ({
        ...arm,
        claimed: { measuredCostMicroUsd: arm.facts.estimatedCostMicroUsd },
      }));
    case "hidden-weights":
    case "post-hoc-exclusion":
    case "window-cherry-picking":
    case "silent-drops":
      // The scope-level vectors denature the AUDIT SCOPE, never the
      // arm bundles — the honest inputs stay the honest recorded bundles.
      return arms;
  }
}

/** Apply EVERY vector of a combination (the combined denaturing — PURE). */
function applyGamingCombination(
  arms: readonly RecordedCompetitiveArm[],
  vectors: readonly GamingVector[],
): readonly RecordedCompetitiveArm[] {
  return vectors.reduce((current, vector) => applyGamingVariant(current, vector), arms);
}

/**
 * The dishonest AUDIT SCOPE of one scope-level gaming vector (PURE):
 * the omitted rows the favorable-subset oracle must NAME. The
 * post-hoc-exclusion omits the honest FAILED probes; the
 * window-cherry-picking samples only the favorable window; the
 * silent-drops drops the under-powered stop class.
 */
export function dishonestScopeOmittedRowsOf(vector: GamingVector): readonly string[] {
  const complete = offlineRowIdsOf("VAL-048");
  switch (vector) {
    case "post-hoc-exclusion":
      return complete.filter((rowId) => rowId.startsWith("probe-"));
    case "window-cherry-picking":
      return complete.filter(
        (rowId) => rowId.includes("zero-resolved") || rowId.includes("budget-stop"),
      );
    case "silent-drops":
      return complete.filter(
        (rowId) => rowId === "budget-stop-prefix-quality-adjusted-underpowered",
      );
    default:
      return [];
  }
}

/** The hidden-weights portfolio row shape (the machinery-side dishonest aggregate — never declared weights). */
function hiddenWeightsRowOf(): CompetitiveCorpusRow {
  return { family: "portfolio-weighted-aggregate" } as unknown as CompetitiveCorpusRow;
}

// ---------------------------------------------------------------------------
// The gaming probe builders (each probe NAMED with its mechanism)
// ---------------------------------------------------------------------------

/** Probe ONE gaming vector against the FINAL integrated machinery (PURE). */
export function singleGamingProbeOf(vector: GamingVector): GamingProbeResult {
  switch (vector) {
    case "quality-inflation":
    case "latency-omission":
    case "failure-hiding":
    case "regime-normalization":
    case "re-measurement-masquerade": {
      const arms = applyGamingVariant(HEADLINE_INPUTS, vector);
      const integrity = deriveCompetitiveInputIntegrity({ arms });
      return {
        vectors: [vector],
        caught: !integrity.conformant,
        mechanisms: [GAMING_MECHANISM_OF[vector]],
        evidence: [
          `vector:${vector}`,
          ...integrity.evidence,
          integrity.conformant
            ? `NOT CAUGHT (the machinery missed the ${vector} gaming attempt)`
            : `caught:${GAMING_MECHANISM_OF[vector]}`,
        ],
      };
    }
    case "estimate-conflation": {
      const arms = applyGamingVariant(HEADLINE_INPUTS, vector);
      const separation = deriveEstimateMeasureSeparation({ arms });
      return {
        vectors: [vector],
        caught: !separation.conformant,
        mechanisms: [GAMING_MECHANISM_OF[vector]],
        evidence: [
          `vector:${vector}`,
          ...separation.evidence,
          separation.conformant
            ? "NOT CAUGHT (the machinery missed the estimate conflation)"
            : `caught:${GAMING_MECHANISM_OF[vector]}`,
        ],
      };
    }
    case "hidden-weights": {
      const weighting = deriveWeightingDisclosure({
        row: hiddenWeightsRowOf(),
        recordedClasses: RECORDED_COMPETITIVE_CLASSES,
      });
      return {
        vectors: [vector],
        caught: !weighting.conformant,
        mechanisms: [GAMING_MECHANISM_OF[vector]],
        evidence: [
          `vector:${vector}`,
          ...weighting.evidence,
          weighting.conformant
            ? "NOT CAUGHT (the machinery missed the hidden weights)"
            : `caught:${GAMING_MECHANISM_OF[vector]}`,
        ],
      };
    }
    case "post-hoc-exclusion":
    case "window-cherry-picking":
    case "silent-drops": {
      const omitted = dishonestScopeOmittedRowsOf(vector);
      return {
        vectors: [vector],
        caught: omitted.length > 0,
        mechanisms: [GAMING_MECHANISM_OF[vector]],
        omittedRows: omitted,
        evidence: [
          `vector:${vector}`,
          omitted.length === 0
            ? "NOT CAUGHT (the dishonest scope omitted nothing)"
            : `caught:${GAMING_MECHANISM_OF[vector]}`,
          `omitted-rows:${omitted.join(",")}`,
        ],
      };
    }
  }
}

/** Probe ONE cross-vector combination (both vectors at once — PURE). */
export function combinationGamingProbeOf(vectors: readonly GamingVector[]): GamingProbeResult {
  const inputLevel = vectors.filter(
    (vector) =>
      vector === "quality-inflation" ||
      vector === "latency-omission" ||
      vector === "failure-hiding" ||
      vector === "regime-normalization" ||
      vector === "re-measurement-masquerade" ||
      vector === "estimate-conflation",
  );
  const scopeLevel = vectors.filter(
    (vector) =>
      vector === "post-hoc-exclusion" ||
      vector === "window-cherry-picking" ||
      vector === "silent-drops" ||
      vector === "hidden-weights",
  );
  const catches: string[] = [];
  if (inputLevel.length > 0) {
    const arms = applyGamingCombination(HEADLINE_INPUTS, inputLevel);
    const integrity = deriveCompetitiveInputIntegrity({ arms });
    if (!integrity.conformant) {
      catches.push(`input-integrity over ${inputLevel.join("+")}`);
    }
    if (vectors.includes("estimate-conflation")) {
      const separation = deriveEstimateMeasureSeparation({ arms });
      if (!separation.conformant) {
        catches.push("estimate-measure-separation");
      }
    }
  }
  if (vectors.includes("hidden-weights")) {
    const weighting = deriveWeightingDisclosure({
      row: hiddenWeightsRowOf(),
      recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    });
    if (!weighting.conformant) {
      catches.push("weighting-disclosure");
    }
  }
  const omitted = scopeLevel
    .filter((vector) => vector !== "hidden-weights")
    .flatMap((vector) => dishonestScopeOmittedRowsOf(vector));
  if (scopeLevel.some((vector) => vector !== "hidden-weights") && omitted.length > 0) {
    catches.push(
      `favorable-subset over ${scopeLevel.filter((v) => v !== "hidden-weights").join("+")}`,
    );
  }
  const caught =
    catches.length > 0 &&
    vectors.every((vector) => {
      if (
        vector === "quality-inflation" ||
        vector === "latency-omission" ||
        vector === "failure-hiding" ||
        vector === "regime-normalization" ||
        vector === "re-measurement-masquerade"
      ) {
        return catches.some((entry) => entry.startsWith("input-integrity"));
      }
      if (vector === "estimate-conflation") {
        return catches.includes("estimate-measure-separation");
      }
      if (vector === "hidden-weights") {
        return catches.includes("weighting-disclosure");
      }
      return omitted.length > 0;
    });
  return {
    vectors: [...vectors],
    caught,
    mechanisms: vectors.map((vector) => GAMING_MECHANISM_OF[vector]),
    ...(omitted.length === 0 ? {} : { omittedRows: omitted }),
    evidence: [
      `combination:${vectors.join("+")}`,
      ...catches.map((entry) => `caught:${entry}`),
      omitted.length === 0 ? {} : `omitted-rows:${omitted.join(",")}`,
      caught
        ? `caught-combination:${vectors.map((vector) => GAMING_MECHANISM_OF[vector]).join(" + ")}`
        : "NOT CAUGHT (each probe in isolation caught but the combination gamed the machinery)",
    ].filter((entry): entry is string => typeof entry === "string"),
  };
}

/**
 * The gaming probes of one audit corpus row (DETERMINISTIC): every
 * declared single vector probed AND every declared combination probed
 * — the probe results the driver's completeness oracle verifies.
 */
export function gamingProbesFor(row: AuditCorpusRow): readonly GamingProbeResult[] {
  const probes: GamingProbeResult[] = [];
  for (const vector of row.gamingVectors ?? []) {
    probes.push(singleGamingProbeOf(vector));
  }
  if ((row.combinedVectors ?? []).length > 0) {
    probes.push(combinationGamingProbeOf(row.combinedVectors ?? []));
  }
  return probes;
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/**
 * The transport-level fake public API implementing the platform's OWN
 * semantics at the customer boundary (mirroring the VAL-040/048 fake
 * worlds over THIS slice's corpus): POST /executions (the
 * create/replay semantics), GET /executions/:id (the row settles to
 * its honest outcome on the read path) and GET /executions/:id/results
 * (the honest result package). Discrimination knobs: `terminal`/
 * `verificationStatuses` override the honest outcome;
 * `fabricatePassWithFail` settles a FAILED-expected row into a
 * COMPLETED terminal WITH a FAIL verification status.
 */
export function createAuditFakeApiWorld(options: {
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
    const row = AUDIT_CORPUS.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) {
      return { terminal: "FAILED", statuses: ["FAIL"] };
    }
    if (row.expected.terminal === "COMPLETED") {
      return { terminal: "COMPLETED", statuses: ["PASS", "PASS"] };
    }
    return { terminal: "FAILED", statuses: ["FAIL", "PASS"] };
  };

  /** The effective outcome for one row (the knobs override the honest shape). */
  const outcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const honest = honestOutcomeFor(rowId);
    if (options.fabricatePassWithFail === true && honest.terminal === "FAILED") {
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
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = outcomeFor(row.taskRowId).terminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "economic-audit.experiment.v1", input: "audit" },
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
          provider: "audit-ledger",
          model: "recorded-evidence-replay",
          strategyClass: "economic-audit",
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
