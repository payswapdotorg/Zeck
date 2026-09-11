/**
 * The longitudinal experiment ledger public barrel (VAL-007).
 *
 * Append-only experiment registration with content digests, immutable
 * run attachments with cohort-contamination guards, integrity
 * checking, and cohort dataset export.
 */

export {
  type CohortDefinition,
  EXPERIMENT_KINDS,
  type ExperimentEntry,
  type ExperimentKind,
  ExperimentLedger,
  type LedgerViolation,
  type RunAttachment,
  registerExperiment,
} from "./ledger";
