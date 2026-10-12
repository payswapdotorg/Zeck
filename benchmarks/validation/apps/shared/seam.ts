/**
 * The validation lab's evaluation seam surface (PCS-001 — the PCR-002
 * wired seam and its evaluation companions, re-exported for evaluation
 * applications).
 *
 * THE SEAM LAW: the helper set below is EXACTLY what the wired seam
 * (experiments/ppr-027/compose.ts — the ONE wired seam file) and the
 * read-only evaluation companions the repository's evaluation
 * applications already consume (config, driver, sweep, transport).
 * Widening it is a work-order decision, never ambient — the surface is
 * frozen by test (tests/unit/validation/shared-seam-surface.test.ts),
 * and drift is a typed failure.
 *
 * Re-exports ONLY: no logic moves, no signature changes, no new
 * behavior — every name below is the origin module's own export
 * (reference-identical), so evaluation applications import the same
 * functions and types through ONE stable lab surface instead of
 * re-deriving the fragile four-level deep paths into
 * experiments/ppr-027/ for every future evaluation app.
 */

export {
  composeExperimentStack,
  type ExperimentRecoveryPlanInputs,
  type ExperimentStack,
} from "../../../../experiments/ppr-027/compose";

export {
  edgeOf,
  type ModalityKind,
  type SubjectDefinition,
  type SubjectEdge,
  type VolumeKind,
  type WorkloadRequest,
} from "../../../../experiments/ppr-027/config";

export {
  baselineTasksOf,
  buildCellCorpus,
  createDirectBaselineExecutor,
  createExperimentDriver,
  createOptimizedBaselineExecutor,
  type RequestRecord,
} from "../../../../experiments/ppr-027/driver";

export { allSweepCells, experimentTraceSource } from "../../../../experiments/ppr-027/sweep";

export {
  createSyntheticSupply,
  drawnFault,
  outcomeOf,
} from "../../../../experiments/ppr-027/transport";
