/**
 * `capabilities` domain layer — entities, invariants and value objects of this module.
 *
 * Domain code may import this module's own layers, `src/shared/**` and other
 * modules' `public.ts` — never `src/platform/**`, adapters, provider SDKs or
 * HTTP libraries (`IMPLEMENTATION.md` §3).
 */
export type {
  CapabilityAttributeValue,
  CapabilityClaimRecord,
  CapabilityDescriptor,
  CapabilityEvidence,
  CapabilityEvidenceKind,
  CapabilityKind,
  CapabilityProvenance,
  CapabilityRequirement,
  CapabilityResolution,
  ClaimSatisfaction,
  FactValidation,
  PublishedCapabilityFact,
  PublishOutcome,
  TaskCapabilityProfile,
  UnmetReason,
  UnmetRequirement,
} from "./capability";
export { CAPABILITY_EVIDENCE_KINDS, CAPABILITY_KINDS } from "./capability";
export { resolveProfile } from "./resolution";
export {
  compareVersions,
  parseVersion,
  validatePublishedFact,
  validateRequirement,
} from "./validation";
