/**
 * The Zeck validation laboratory — public barrel (VAL-001).
 *
 * This surface owns the customer-style validation program contracts:
 * the deterministic program entrypoint, the validation-state consistency
 * rules, run identity derivation, the worker submission/evidence
 * contract, the surface-ownership governance rules and the cumulative
 * report projection. It is evidence infrastructure, never authority:
 * nothing here mutates product or development state, and every function
 * is a pure projection over its inputs.
 */

export {
  type DependencyStateFile,
  type FrontierStateFile,
  type ProgramStateFile,
  resolveProgramEntrypoint,
  VALIDATION_PROGRAM,
  type ValidationStateSnapshot,
} from "./program";
export {
  groupBySection,
  projectReport,
  REPORT_SECTIONS,
  type ReportEntry,
  type ReportSection,
  recordHypothesis,
} from "./report";
export {
  checkRunMetadata,
  deriveRunId,
  type RunEnvironmentDescriptor,
  type RunMetadata,
  type RunMetadataViolation,
} from "./run-identity";
export {
  checkValidationStateConsistency,
  type StateViolation,
  WORK_ORDER_STATUSES,
  type WorkOrderStatus,
} from "./state";
export {
  type BatteryResult,
  type IssueSolutionProtocol,
  type NotRunBoundary,
  type SubmissionRecord,
  type SubmissionViolation,
  validateSubmission,
} from "./submission";
export {
  parseAllowedSurfaces,
  type SurfaceConflict,
  surfaceOwnershipConflicts,
  type WorkOrderSurfaces,
} from "./surfaces";
