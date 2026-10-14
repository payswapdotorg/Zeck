/**
 * The evaluation's replay corpus (PCL-003): the PPR-027 capstone's OWN
 * complete sweep enumeration plus the recorded capstone-era results,
 * quoted verbatim (read-only — frozen evidence, never relabeled).
 *
 * THE CORPUS LAW (the PCR-003 discipline): the replayed cells are the
 * capstone's OWN cell enumeration (`allSweepCells`, imported read-only
 * through the lab's shared re-export — never a hand-picked subset): the
 * complete 102-cell sweep (9 subjects × S/M/L × single/multi ×
 * mono/full, the modality-degenerate subjects collapsed exactly as the
 * capstone collapsed them). Every cell's request stream derives from
 * the capstone's own corpus builder (`buildCellCorpus`), and the
 * transport draws from the lab seam's pure functions — the corpus is
 * pinned by a content digest (the same corpus → the same digest,
 * always).
 *
 * THE RECORDED-RESULTS LAW (the work order's replay discipline): the
 * capstone's recorded per-cell results are read from
 * `experiments/ppr-027/results/cells/<cellId>.json` READ-ONLY and
 * quoted VERBATIM (the latency-tail measurement entry, the mediated
 * arm's outcome and latency summaries — their own recorded basis
 * preserved: wall-clock end-to-end under the synthetic supply) — never
 * relabeled, never reused as evaluation inputs. The synthetic-supply
 * label rides every quoted number.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  allSweepCells,
  buildCellCorpus,
  type ModalityKind,
  type SubjectDefinition,
  type SubjectEdge,
  type VolumeKind,
  type WorkloadRequest,
} from "../shared/seam";
import { type DigestPort, evaluationCanonicalJson } from "./canonical";

/** One replayed latency cell (the capstone's own enumeration, verbatim fields). */
export interface EvaluationCell {
  readonly cellId: string;
  readonly subject: SubjectDefinition;
  readonly volume: VolumeKind;
  readonly repetitions: number;
  readonly providerConfig: "single" | "multi";
  readonly modality: ModalityKind;
  /** The cell's registered supplies (the capstone's own provider sets). */
  readonly providerIds: readonly string[];
}

/** The single-provider cells address supply-a; the multi cells address all three supplies. */
function providerIdsOf(providerConfig: "single" | "multi"): readonly string[] {
  return providerConfig === "single" ? ["supply-a"] : ["supply-a", "supply-b", "supply-c"];
}

/**
 * The targeted cells: the capstone's OWN complete sweep enumeration
 * (102 cells — the full latency-cell family, never a hand-picked
 * subset), derived read-only through the lab's shared seam.
 */
export function targetedCells(): readonly EvaluationCell[] {
  return allSweepCells().map((cell) => ({
    cellId: cell.cellId,
    subject: cell.subject,
    volume: cell.volume,
    repetitions: cell.repetitions,
    providerConfig: cell.providerConfig,
    modality: cell.modality,
    providerIds: providerIdsOf(cell.providerConfig),
  }));
}

/** The pinned corpus digest: the content address of the complete cell + request enumeration. */
export function pinnedEvaluationCorpusDigest(digest: DigestPort): string {
  return digest.sha256Hex(corpusCanonicalOf(targetedCells()));
}

/** The corpus's canonical projection (the enumeration the evaluation replays). */
function corpusCanonicalOf(cells: readonly EvaluationCell[]): string {
  return evaluationCanonicalJson(
    cells.map((cell) => {
      const corpus = buildCellCorpus(cell.subject, cell.modality, cell.volume, cell.repetitions);
      return {
        cellId: cell.cellId,
        subjectId: cell.subject.subjectId,
        volume: cell.volume,
        repetitions: cell.repetitions,
        providerConfig: cell.providerConfig,
        modality: cell.modality,
        providerIds: [...cell.providerIds],
        tasks: corpus.map((task) => ({
          taskId: task.taskId,
          baseTaskId: task.baseTaskId,
          rep: task.rep,
          requests: task.requests.map((request) => ({
            edgeId: request.edgeId,
            inputTokens: request.inputTokens,
            outputTokens: request.outputTokens,
          })),
        })),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// The transport stream keys (the evaluation's declared per-exposure key
// discipline — arm-agnostic, deterministic)
// ---------------------------------------------------------------------------

/**
 * The transport stream key of one logical request occurrence: the
 * evaluation's own declared key discipline over the corpus's own
 * identity fields (the PCL-003 namespace prefix keeps the replay's
 * exposure space distinct from the capstone's runs — a FRESH re-run,
 * never a reuse of the capstone's draw space). The transport's draws
 * key on (streamKey, attempt, providerId) — the SAME key yields the
 * SAME provider behavior for every arm (arm-agnostic fairness).
 */
export function replayStreamKeyOf(
  cellId: string,
  baseTaskId: string,
  requestIndex: number,
  rep: number,
): string {
  return `pcl-003:${cellId}:${baseTaskId}:r${rep}:i${requestIndex}`;
}

/** The deterministic jitter draw ([0,1)) for one paced retry — a pure hash function. */
export function replayJitterDraw(streamKey: string, attempt: number): number {
  const digest = createHash("sha256").update(`${streamKey}:jitter:${attempt}`, "utf8").digest();
  const value =
    (digest[0] ?? 0) * 0x1_0000_00 +
    (digest[1] ?? 0) * 0x1_0000 +
    (digest[2] ?? 0) * 0x100 +
    (digest[3] ?? 0);
  return value / 0x1_0000_0000;
}

// ---------------------------------------------------------------------------
// The recorded capstone-era results (read-only, quoted verbatim)
// ---------------------------------------------------------------------------

/** The recorded capstone-era quote for one cell (the RAW committed objects, verbatim — never a projection). */
export interface RecordedCapstoneCell {
  readonly cellId: string;
  readonly recorded: boolean;
  /** The capstone's own latency-tail measurement entry, VERBATIM (the raw committed object). */
  readonly latencyTail: Record<string, unknown> | null;
  /** The capstone's own mediated outcome census, VERBATIM (the raw committed object). */
  readonly mediatedOutcomes: Record<string, unknown> | null;
  /** The capstone's own mediated latency summary, VERBATIM (the raw committed object). */
  readonly mediatedLatencySummary: Record<string, unknown> | null;
  readonly basis: string;
}

const RECORDED_CELLS_ROOT = fileURLToPath(
  new URL("../../../../experiments/ppr-027/results/cells", import.meta.url),
);

/**
 * Read the capstone's recorded result for one cell — VERBATIM (the
 * latency-tail measurement entry and the mediated arm's recorded
 * summaries, quoted exactly as committed; the recorded basis —
 * wall-clock end-to-end under the synthetic supply — preserved on the
 * quote, never relabeled). A cell with no committed record renders the
 * honest not-recorded spelling.
 */
export function recordedCapstoneCellOf(cellId: string): RecordedCapstoneCell {
  const path = `${RECORDED_CELLS_ROOT}/${cellId}.json`;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {
      cellId,
      recorded: false,
      latencyTail: null,
      mediatedOutcomes: null,
      mediatedLatencySummary: null,
      basis:
        "NOT RECORDED (no committed capstone cell result at experiments/ppr-027/results/cells)",
    };
  }
  const zeck = parsed.zeck as Record<string, unknown> | undefined;
  const measurementsBlock = zeck?.measurements as Record<string, unknown> | undefined;
  const entries = measurementsBlock?.entries as Record<string, unknown>[] | undefined;
  const latencyTail = entries?.find((entry) => entry.dimension === "latency-tail");
  const outcomes = zeck?.outcomes as Record<string, unknown> | undefined;
  const latency = zeck?.latency as Record<string, unknown> | undefined;
  return {
    cellId,
    recorded: true,
    latencyTail: latencyTail ?? null,
    mediatedOutcomes: outcomes ?? null,
    mediatedLatencySummary: latency ?? null,
    basis:
      "the capstone's recorded result, quoted VERBATIM from experiments/ppr-027/results/cells (the raw committed objects — the latency-tail measurement entry, the mediated outcome census and the mediated latency summary, exactly as committed; the recorded basis — wall-clock end-to-end under the synthetic supply — preserved, never relabeled; synthetic-supply)",
  };
}

/** The subject's edge for one request (the seam's own edge lookup). */
export function edgeOfRequest(subject: SubjectDefinition, request: WorkloadRequest): SubjectEdge {
  const edge = subject.edges.find((candidate) => candidate.edgeId === request.edgeId);
  if (edge === undefined) {
    throw new Error(`subject ${subject.subjectId} declares no edge ${request.edgeId}`);
  }
  return edge;
}
