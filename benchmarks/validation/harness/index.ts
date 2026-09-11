/**
 * The validation harness public barrel (VAL-002).
 *
 * Customer-style integration infrastructure: configuration (secret-free
 * by construction), the SDK-riding validation harness, the evidence
 * contract consumable by the universal recorder (VAL-004), and the
 * sample application. Everything rides the public developer surface —
 * internal Zeck modules are never imported here.
 */

export { runSampleApp } from "../apps/sample/application";
export {
  type AppHarnessConfig,
  type ConfigViolation,
  resolveTransportToken,
  validateAppConfig,
} from "./config";
export {
  type AssertionVerdict,
  digestResult,
  type EvidenceViolation,
  type HarnessEvidence,
  type SurfacedError,
  type TimelineObservation,
  validateHarnessEvidence,
} from "./evidence";
export {
  type HarnessRuntime,
  type OutcomeExpectations,
  type SubmittedRun,
  type TransportImplementation,
  ValidationHarness,
} from "./harness";
