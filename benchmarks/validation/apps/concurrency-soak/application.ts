/**
 * The concurrency/soak customer application (VAL-025).
 *
 * A real customer-style application: one pinned corpus row per run —
 * the same-key racing pair/storm/conflict, the distinct-key fan-out,
 * the over-ceiling burst (wave by wave, the slot-release shape), the
 * soak rounds — submitted through Zeck's public SDK boundary with
 * every group's submissions fired CONCURRENTLY (the customer-side
 * load generator). The application exercises the SUBMISSION side of
 * the concurrency contract:
 *
 *   * racing rows submit N concurrent creates under ONE idempotency
 *     key — exactly ONE created receipt, the losers replaying the
 *     winner's committed outcome (identity preserved) or typed-rejected
 *     (the racing conflict's 409 IDEMPOTENCY_KEY_REUSED);
 *   * fan-out rows submit N concurrent distinct-key creates — every
 *     lane a distinct identity;
 *   * burst rows submit the declared waves — the admitted lanes settle
 *     (terminal + PASS verification), the over-ceiling lanes observe
 *     the durable execution.policy-denied envelope through the public
 *     events read (the typed admission denial's customer-visible
 *     shape) and STAY CREATED (zero effects);
 *   * soak rounds submit the round's racing pair + distinct lanes over
 *     the declared sustained window.
 *
 * The application's own assertions verify the per-row outcome contract
 * (the corpus-declared terminal + PASS verification statuses on every
 * admitted lane) AND the submission contract (the created/replayed/
 * rejected counts, identity preservation, the typed rejection codes,
 * the admission shaping counts) — a fabricated settlement never passes
 * a row whose submission contract is violated.
 */

import { createZeckClient, TERMINAL_STATUSES, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { SubmissionObservation } from "../../platform/concurrency-soak";
import {
  ADMISSION_DENIED_EVENT_TYPE,
  verifyConcurrencySubmissionContract,
} from "../../platform/concurrency-soak";
import type { LabVerificationCriterion } from "../../platform/derive";
import { CONCURRENCY_CORPUS, soakRoundExpectation, submissionKey, taskBodyFor } from "./corpus";

/** One landed lane's classification (the burst rows' admission observation). */
export type AdmissionOutcome = "admitted" | "denied" | "unresolved";

/** The app's full run outcome (evidence + assertions + submission contract). */
export interface ConcurrencySoakAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly submissionCriteria: readonly LabVerificationCriterion[];
  readonly observations: readonly SubmissionObservation[];
  /** The distinct landed execution ids (classification order). */
  readonly landedIds: readonly string[];
  /** The per-lane admission classifications (the burst rows only). */
  readonly admissionOutcomes: readonly AdmissionOutcome[] | null;
  /** The measured submission latencies (ms) in submission order. */
  readonly submissionLatencyMs: readonly number[];
}

/** The app's pinned corpus slice (`concurrency-soak.settlement.v1` rows). */
export const CONCURRENCY_SOAK_TASKS = CONCURRENCY_CORPUS.map((row) => ({
  kind: "concurrency-soak.settlement.v1",
  rowId: row.rowId,
  pattern: row.pattern,
  expectedTerminal: row.expected.terminal,
  submissions:
    row.expected.appCreated + row.expected.replayedSubmissions + row.expected.rejectedSubmissions,
  appCreated: row.expected.appCreated,
  replayedSubmissions: row.expected.replayedSubmissions,
  rejectedSubmissions: row.expected.rejectedSubmissions,
  ...(row.ceiling === undefined ? {} : { ceiling: row.ceiling }),
  ...(row.expected.admitted === undefined ? {} : { admitted: row.expected.admitted }),
  ...(row.expected.denied === undefined ? {} : { denied: row.expected.denied }),
  ...(row.soak === undefined
    ? {}
    : {
        rounds: row.soak.rounds,
        interRoundSpacingMs: row.soak.interRoundSpacingMs,
      }),
  ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
}));

/**
 * Run the concurrency/soak application end to end over one pinned
 * corpus row (the soak rows: ONE round per invocation — `roundIndex`).
 * The transport implementation is injected (the SDK's seam); the app
 * never selects provider/model/rail (the platform's authority).
 */
export async function runConcurrencySoakApp(options: {
  readonly config: AppHarnessConfig;
  readonly token: string;
  readonly transport: TransportImplementation;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly environment: {
    readonly runtime: string;
    readonly toolchain: string;
    readonly database: string;
    readonly configuration: Readonly<Record<string, string>>;
  };
  readonly runSuffix: string;
  readonly taskIndex: number;
  /** The soak rows: the round this run drives (1-based). */
  readonly roundIndex?: number;
}): Promise<ConcurrencySoakAppResult> {
  const row = CONCURRENCY_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned concurrency-soak task slice is empty");
  }
  const isSoakRound = row.pattern === "soak-rounds";
  if (isSoakRound && options.roundIndex === undefined) {
    throw new Error("the soak row demands a roundIndex (one round per app run)");
  }
  const round = options.roundIndex ?? 0;

  const harness = new ValidationHarness({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.config.applicationId,
    transport: options.transport,
    runtime: {
      now: options.now,
      sleep: options.sleep,
      environment: options.environment,
    },
    identity: {
      program: "zeck-validation",
      workOrder: "VAL-025",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });
  const client = createZeckClient({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.config.applicationId,
    fetchImpl: options.transport,
  });

  /** The app's idempotency key for one submission lane. */
  const keyFor = (lane: number, racingPair: boolean): string =>
    submissionKey({
      runSuffix: options.runSuffix,
      taskIndex: options.taskIndex,
      ...(isSoakRound ? { round } : {}),
      lane,
      racingPair,
    });

  // ---- the submission phase (the pattern's own concurrent behavior) ----
  const observations: SubmissionObservation[] = [];
  const submissionLatencyMs: number[] = [];
  let primaryId: string | null = null;

  /** Fire one submission and record its observation (honest, never fabricated). */
  const submitOne = (
    key: string,
    body: Record<string, unknown>,
    viaHarness: boolean,
  ): Promise<void> => {
    const submittedAt = options.now().getTime();
    const request = { applicationId: options.config.applicationId, task: body };
    const attempt: Promise<{ executionId: string; replayed: boolean; status: string }> = viaHarness
      ? harness.submit(request, key).then((run) => ({
          executionId: run.executionId,
          replayed: run.replayed,
          status: run.initialStatus,
        }))
      : client.createExecution(request, key).then(({ receipt }) => ({
          executionId: receipt.executionId,
          replayed: receipt.replayed,
          status: receipt.status,
        }));
    return attempt
      .then((receipt) => {
        submissionLatencyMs.push(options.now().getTime() - submittedAt);
        if (primaryId === null) {
          primaryId = receipt.executionId;
        }
        observations.push({
          executionId: receipt.executionId,
          replayed: receipt.replayed,
          status: receipt.status,
          rejection: null,
          submittedAt,
          latencyMs: options.now().getTime() - submittedAt,
        });
      })
      .catch((error: unknown) => {
        submissionLatencyMs.push(options.now().getTime() - submittedAt);
        if (error instanceof ZeckApiError) {
          observations.push({
            executionId: "",
            replayed: false,
            status: null,
            rejection: { code: error.body.code, status: error.status },
            submittedAt,
            latencyMs: options.now().getTime() - submittedAt,
          });
          return;
        }
        observations.push({
          executionId: "",
          replayed: false,
          status: null,
          rejection: { code: "UNEXPECTED", status: 0 },
          submittedAt,
          latencyMs: options.now().getTime() - submittedAt,
        });
      });
  };

  /**
   * The racing group: N concurrent creates under ONE key (the conflict
   * peer mutated). Every racing submission rides the harness's submit
   * (the typed rejections surface as app evidence errors — the
   * VAL-021 conflict precedent).
   */
  const fireRacingGroup = async (key: string, count: number): Promise<void> => {
    const bodies = Array.from({ length: count }, (_, index) =>
      taskBodyFor({
        rowId: row.rowId,
        lane: 0,
        ...(isSoakRound ? { round } : {}),
        ...(row.rowId === "same-key-race-conflict" && index === 1 ? { mutated: true } : {}),
      }),
    );
    await Promise.all(bodies.map((body) => submitOne(key, body, true)));
  };

  /** The distinct lanes: N concurrent creates under distinct keys. */
  const fireDistinctLanes = async (lanes: readonly number[]): Promise<void> => {
    await Promise.all(
      lanes.map((lane) =>
        submitOne(
          keyFor(lane, false),
          taskBodyFor({ rowId: row.rowId, lane, ...(isSoakRound ? { round } : {}) }),
          false,
        ),
      ),
    );
  };

  /** Poll one landed lane to its classification (with the observed terminal). */
  const pollLane = async (
    executionId: string,
  ): Promise<{ readonly outcome: AdmissionOutcome; readonly status: string }> => {
    const deadline = options.now().getTime() + options.config.completionTimeoutMs;
    for (;;) {
      const execution = await client.getExecution(executionId);
      if (TERMINAL_STATUSES.includes(execution.status)) {
        return { outcome: "admitted", status: execution.status };
      }
      if (row.pattern === "over-ceiling-burst") {
        const events = await client.listEvents(executionId);
        if (events.some((event) => event.type === ADMISSION_DENIED_EVENT_TYPE)) {
          return { outcome: "denied", status: execution.status };
        }
      }
      if (options.now().getTime() >= deadline) {
        return { outcome: "unresolved", status: execution.status };
      }
      await options.sleep(options.config.pollIntervalMs);
    }
  };

  const landedIds: string[] = [];
  const admissionOutcomes: AdmissionOutcome[] = [];
  const observedStatuses: string[] = [];
  /** The distinct identities among the created receipts (lane order). */
  const collectLanded = (): string[] => {
    const ids: string[] = [];
    for (const observation of observations) {
      if (observation.rejection === null && !ids.includes(observation.executionId)) {
        ids.push(observation.executionId);
      }
    }
    return ids;
  };

  if (row.pattern === "same-key-race") {
    // The racing rows: N concurrent creates under ONE key (the racing
    // pair / the five-create storm / the racing conflict's pair).
    const count =
      row.expected.appCreated + row.expected.replayedSubmissions + row.expected.rejectedSubmissions;
    await fireRacingGroup(keyFor(0, true), count);
    landedIds.push(...collectLanded());
    for (const id of landedIds) {
      const polled = await pollLane(id);
      admissionOutcomes.push(polled.outcome);
      observedStatuses.push(polled.status);
    }
  } else if (row.pattern === "distinct-key-fanout") {
    // The fan-out rows: every lane fired CONCURRENTLY (no
    // head-of-line blocking at the submission boundary).
    const primaryLane = 0;
    await Promise.all([
      submitOne(
        keyFor(primaryLane, false),
        taskBodyFor({ rowId: row.rowId, lane: primaryLane }),
        true,
      ),
      ...Array.from({ length: row.submissions.count - 1 }, (_, index) =>
        submitOne(
          keyFor(index + 1, false),
          taskBodyFor({ rowId: row.rowId, lane: index + 1 }),
          false,
        ),
      ),
    ]);
    landedIds.push(...collectLanded());
    for (const id of landedIds) {
      const polled = await pollLane(id);
      admissionOutcomes.push(polled.outcome);
      observedStatuses.push(polled.status);
    }
  } else if (row.pattern === "over-ceiling-burst") {
    // The burst rows: wave by wave — each wave's lanes fired
    // CONCURRENTLY; the wave's settlement (the admitted lanes'
    // terminals + the denied lanes' durable denial envelopes) gates
    // the next wave (the slot-release shape).
    const waves = row.burstWaves ?? [row.submissions.count];
    let laneCursor = 0;
    for (const [waveIndex, wave] of waves.entries()) {
      const lanes = Array.from({ length: wave }, (_, index) => laneCursor + index);
      if (waveIndex === 0) {
        // The first wave's first lane rides the harness (the evidence).
        const [first, ...rest] = lanes;
        await Promise.all([
          submitOne(
            keyFor(first ?? 0, false),
            taskBodyFor({ rowId: row.rowId, lane: first ?? 0 }),
            true,
          ),
          ...rest.map((lane) =>
            submitOne(keyFor(lane, false), taskBodyFor({ rowId: row.rowId, lane }), false),
          ),
        ]);
      } else {
        await fireDistinctLanes(lanes);
      }
      const waveLanded = collectLanded().slice(landedIds.length);
      for (const id of waveLanded) {
        const polled = await pollLane(id);
        admissionOutcomes.push(polled.outcome);
        observedStatuses.push(polled.status);
        landedIds.push(id);
      }
      laneCursor += wave;
    }
  } else if (isSoakRound) {
    // The soak rounds: the round's racing pair (2 concurrent creates
    // under ONE key) + the round's distinct lanes — all fired
    // concurrently; then the round's lanes polled to settlement.
    await Promise.all([fireRacingGroup(keyFor(0, true), 2), fireDistinctLanes([1, 2])]);
    landedIds.push(...collectLanded());
    for (const id of landedIds) {
      const polled = await pollLane(id);
      admissionOutcomes.push(polled.outcome);
      observedStatuses.push(polled.status);
    }
  }

  // ---- the completion + retrieval phase ----
  // The harness's completion rides the first ADMITTED lane (the burst
  // rows' primary lane may itself be the typed-denied one — the
  // arbitration is the platform's, never the app's claim).
  const firstAdmitted =
    landedIds.find((_id, index) => admissionOutcomes[index] === "admitted") ?? primaryId;
  let harnessPassed = false;
  if (firstAdmitted !== null && firstAdmitted !== "") {
    await harness.awaitCompletion(firstAdmitted);
    await harness.retrieveResult(firstAdmitted);
    harnessPassed = harness.assertOutcome({
      expectTerminalStatus: row.expected.terminal,
      expectVerificationStatuses: ["PASS"],
      forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
      forbidRetryableErrors: true,
    });
  }

  // ---- the assertion phase ----
  // 1. The lanes' outcome contract: every admitted lane reached the
  //    expected terminal; every denied lane STAYS CREATED (zero
  //    effects — the durable denial envelope already observed).
  const lanesPassed =
    admissionOutcomes.length === landedIds.length &&
    landedIds.length > 0 &&
    landedIds.every((_id, index) => {
      const outcome = admissionOutcomes[index];
      const status = observedStatuses[index] ?? "";
      if (outcome === "admitted") {
        // The observed terminal must BE the corpus-declared terminal.
        return status === row.expected.terminal;
      }
      if (outcome === "denied") {
        // The denied lane stays CREATED — the honest NOT-ADMITTED shape
        // (the durable denial envelope already observed).
        return status === "CREATED" && row.pattern === "over-ceiling-burst";
      }
      return false;
    });

  // 2. The submission contract: the created/replayed/rejected counts,
  //    identity preservation, the typed rejection codes, the fan-out's
  //    distinct receipts, the burst rows' admission shaping counts.
  const expectedCounts = isSoakRound
    ? soakRoundExpectation()
    : {
        submissions:
          row.expected.appCreated +
          row.expected.replayedSubmissions +
          row.expected.rejectedSubmissions,
        created: row.expected.appCreated,
        replayed: row.expected.replayedSubmissions,
        rejected: row.expected.rejectedSubmissions,
      };
  const submissionCriteria = verifyConcurrencySubmissionContract({
    expected: expectedCounts,
    observations,
    ...(row.pattern === "distinct-key-fanout" ? { distinctLanes: row.submissions.count } : {}),
    ...(row.pattern === "over-ceiling-burst"
      ? {
          admissionOutcomes,
          expectedAdmitted: row.expected.admitted,
          expectedDenied: row.expected.denied,
        }
      : {}),
  });
  const submissionPassed = submissionCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && lanesPassed && submissionPassed,
    submissionCriteria,
    observations,
    landedIds,
    admissionOutcomes: row.pattern === "over-ceiling-burst" ? admissionOutcomes : null,
    submissionLatencyMs,
  };
}
