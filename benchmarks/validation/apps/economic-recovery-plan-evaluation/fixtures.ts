/**
 * The economic-recovery-plan-evaluation hermetic fixtures (PCR-003 —
 * the test suites' deterministic world).
 *
 * THE HERMETIC SUBJECT: a tiny one-edge text subject whose corpus is
 * SCAN-CHOSEN (module-load time, pure hash arithmetic over the
 * transport's own draw functions — the PCR-002 integration suite's
 * discipline) so that one small cell exercises the evaluation's
 * interesting paths: at least one attempt-1 fault (a composed plan), at
 * least one full-ladder execution (retry AND failover attempts), at
 * least one resolved-after-recovery occurrence in both the
 * mediated-with-plan and strong-optimized arms, and at least one clean
 * first attempt. The draws are pure functions of the stream keys — the
 * scan is deterministic and the hermetic cell's behavior is stable.
 */

import type { SubjectDefinition, SubjectEdge } from "../../../../experiments/ppr-027/config";
import { drawnFault, outcomeOf } from "../../../../experiments/ppr-027/transport";
import type { EvaluationCell } from "./corpus";

/** The hermetic subject's single edge (the text plane). */
export const HERMENEUTIC_EDGE: SubjectEdge = {
  edgeId: "hermetic.text-completion",
  surface: "text-generation",
  modalityClass: "text",
};

/** The hermetic workload requests (one task, four requests). */
const HERMENEUTIC_REQUESTS = [
  { edgeId: "hermetic.text-completion", inputTokens: 500, outputTokens: 200 },
  { edgeId: "hermetic.text-completion", inputTokens: 400, outputTokens: 180 },
  { edgeId: "hermetic.text-completion", inputTokens: 600, outputTokens: 220 },
  { edgeId: "hermetic.text-completion", inputTokens: 450, outputTokens: 160 },
] as const;

/** The supplies the multi configuration registers. */
const SUPPLIES = ["supply-a", "supply-b", "supply-c"] as const;

/** The mediated arm's projected ladder (mirrors the corpus's declared wiring). */
function mediatedProjectionOf(
  subjectId: string,
  index: number,
): {
  readonly planComposed: boolean;
  readonly retryAttempt: boolean;
  readonly failoverAttempt: boolean;
  readonly resolved: boolean;
  readonly resolutionClass: "resolved-first-attempt" | "resolved-after-recovery" | "failed";
} {
  const cellId = `pcr003-${subjectId}-S-multi-mono`;
  const streamKey = `${cellId}:hermetic-task:i${index}:d${index + 1}`;
  const attempt1 = drawnFault({
    providerId: SUPPLIES[index % 3] ?? "supply-a",
    edge: HERMENEUTIC_EDGE,
    request: HERMENEUTIC_REQUESTS[index] ?? HERMENEUTIC_REQUESTS[0],
    streamKey,
    attempt: 1,
  });
  if (attempt1 === null) {
    return {
      planComposed: false,
      retryAttempt: false,
      failoverAttempt: false,
      resolved: true,
      resolutionClass: "resolved-first-attempt",
    };
  }
  const attempt2 = drawnFault({
    providerId: SUPPLIES[index % 3] ?? "supply-a",
    edge: HERMENEUTIC_EDGE,
    request: HERMENEUTIC_REQUESTS[index] ?? HERMENEUTIC_REQUESTS[0],
    streamKey,
    attempt: 2,
  });
  if (attempt2 === null) {
    return {
      planComposed: true,
      retryAttempt: true,
      failoverAttempt: false,
      resolved: true,
      resolutionClass: "resolved-after-recovery",
    };
  }
  const attempt3 = drawnFault({
    providerId: "supply-c",
    edge: HERMENEUTIC_EDGE,
    request: HERMENEUTIC_REQUESTS[index] ?? HERMENEUTIC_REQUESTS[0],
    streamKey,
    attempt: 3,
  });
  return {
    planComposed: true,
    retryAttempt: true,
    failoverAttempt: true,
    resolved: attempt3 === null,
    resolutionClass: attempt3 === null ? "resolved-after-recovery" : "failed",
  };
}

/** The optimized arm's projected ladder (attempt N on supplies[min(N-1, 2)]). */
function optimizedProjectionOf(
  subjectId: string,
  index: number,
): {
  readonly recovered: boolean;
  readonly resolved: boolean;
} {
  const cellId = `pcr003-${subjectId}-S-multi-mono`;
  const streamKey = `${cellId}:hermetic-task:r1:i${index}`;
  for (const attempt of [1, 2, 3] as const) {
    const fault = drawnFault({
      providerId: SUPPLIES[Math.min(attempt - 1, 2)] ?? "supply-a",
      edge: HERMENEUTIC_EDGE,
      request: HERMENEUTIC_REQUESTS[index] ?? HERMENEUTIC_REQUESTS[0],
      streamKey,
      attempt,
    });
    if (fault === null) {
      return { recovered: attempt > 1, resolved: true };
    }
    if (!fault.retryable) {
      return { recovered: false, resolved: false };
    }
  }
  return { recovered: false, resolved: false };
}

/**
 * Scan for a hermetic subject id whose draw profile exercises the
 * evaluation's interesting paths (deterministic — the same scan always
 * selects the same id).
 */
function scanHermeticSubjectId(): string {
  for (let candidate = 0; candidate < 20_000; candidate += 1) {
    const subjectId = `pcr003-hermetic-${candidate}`;
    const mediated = HERMENEUTIC_REQUESTS.map((_, index) => mediatedProjectionOf(subjectId, index));
    const optimized = HERMENEUTIC_REQUESTS.map((_, index) =>
      optimizedProjectionOf(subjectId, index),
    );
    const want = {
      planComposed: mediated.some((entry) => entry.planComposed),
      fullLadder: mediated.some((entry) => entry.retryAttempt && entry.failoverAttempt),
      mediatedRecovered: mediated.some(
        (entry) => entry.resolutionClass === "resolved-after-recovery",
      ),
      mediatedFailed: mediated.some((entry) => entry.resolutionClass === "failed"),
      optimizedRecovered: optimized.some((entry) => entry.recovered),
      cleanFirstAttempts: mediated.some(
        (entry) => entry.resolutionClass === "resolved-first-attempt",
      ),
    };
    if (
      want.planComposed &&
      want.fullLadder &&
      want.mediatedRecovered &&
      want.optimizedRecovered &&
      want.cleanFirstAttempts
    ) {
      return subjectId;
    }
  }
  throw new Error("no hermetic subject id matched the wanted draw profile");
}

/** The scan-chosen hermetic subject id (deterministic). */
export const HERMENEUTIC_SUBJECT_ID = scanHermeticSubjectId();

/** The hermetic subject definition (the PCR-002 integration suite's shape). */
export function hermeticSubject(): SubjectDefinition {
  return {
    subjectId: HERMENEUTIC_SUBJECT_ID,
    name: "PCR-003 hermetic evaluation subject",
    repository: "pcr-003/hermetic",
    upstreamRevision: "hermetic",
    integrationRevision: "hermetic",
    evidenceRecord: "pcr-003-hermetic",
    requestCountBasis: "resolved-corpus-narrative",
    tokenTotalsBasis: "resolved-corpus-narrative",
    edges: [HERMENEUTIC_EDGE],
    tasks: [
      {
        taskId: "hermetic-task",
        title: "Hermetic four-request task",
        instruction: "One task, four text requests (the hermetic evaluation slice).",
        requests: HERMENEUTIC_REQUESTS.map((request) => ({ ...request })),
      },
    ],
    certifiedTotals: {
      requests: HERMENEUTIC_REQUESTS.length,
      inputTokens: HERMENEUTIC_REQUESTS.reduce((sum, request) => sum + request.inputTokens, 0),
      outputTokens: HERMENEUTIC_REQUESTS.reduce((sum, request) => sum + request.outputTokens, 0),
    },
  };
}

/** The hermetic evaluation cell (one S-volume mono multi cell). */
export function hermeticCell(): EvaluationCell {
  const subject = hermeticSubject();
  return {
    cellId: `pcr003-${subject.subjectId}-S-multi-mono`,
    capstoneCellId: `${subject.subjectId}-S-multi-mono`,
    subjectId: subject.subjectId,
    subject,
    volume: "S",
    repetitions: 1,
    modality: "mono",
    providerConfig: "multi",
    providerIds: [...SUPPLIES],
  };
}

/** The hermetic cell's projected mediated-arm profile (the scan's own derivation — the test oracle). */
export function hermeticMediatedProjection(): readonly ReturnType<typeof mediatedProjectionOf>[] {
  return HERMENEUTIC_REQUESTS.map((_, index) =>
    mediatedProjectionOf(HERMENEUTIC_SUBJECT_ID, index),
  );
}

/** The hermetic cell's projected optimized-arm profile (the scan's own derivation — the test oracle). */
export function hermeticOptimizedProjection(): readonly ReturnType<typeof optimizedProjectionOf>[] {
  return HERMENEUTIC_REQUESTS.map((_, index) =>
    optimizedProjectionOf(HERMENEUTIC_SUBJECT_ID, index),
  );
}

/** The full per-attempt outcome the transport's pure functions produce (the verification oracle). */
export function hermeticDrawnOutcome(options: {
  readonly streamKey: string;
  readonly attempt: number;
  readonly providerId: string;
  readonly requestIndex: number;
}) {
  return outcomeOf({
    providerId: options.providerId,
    edge: HERMENEUTIC_EDGE,
    request: HERMENEUTIC_REQUESTS[options.requestIndex] ?? HERMENEUTIC_REQUESTS[0],
    streamKey: options.streamKey,
    attempt: options.attempt,
  });
}

/** The no-op sleeper (hermetic runs — the drawn latencies are the evidence, never wall-clock). */
export const NO_OP_SLEEPER = async (): Promise<void> => {};

/** A deterministic tick clock (ISO strings — excluded from digests). */
export function createTickClock(): { readonly now: () => string } {
  let tick = 0;
  return {
    now: () => {
      tick += 1;
      return new Date(Date.parse("2026-10-12T00:00:00Z") + tick).toISOString();
    },
  };
}
