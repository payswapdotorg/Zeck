/**
 * The capability matrix public barrel (VAL-009).
 *
 * Corpus-declared capabilities, candidate provider access (credential
 * by env-var NAME only), readiness resolution from probe outcomes, and
 * the secret-free probe result contract. A capability without a
 * successful probe is a GAP — never a silent pass.
 */

export {
  CAPABILITY_MATRIX,
  type CapabilityDescriptor,
  type CapabilityResolution,
  corpusCapabilityCoverage,
  PROVIDER_ACCESS,
  type ProviderAccess,
  resolveMatrix,
} from "./matrix";
export {
  PROBE_FAILURE_KINDS,
  type ProbeFailureKind,
  type ProbePlan,
  type ProbeResult,
  type ProbeViolation,
  probePlans,
  validateProbeResult,
} from "./probe";
