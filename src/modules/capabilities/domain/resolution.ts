/**
 * Capability profile resolution (capabilities module domain, INT-002).
 *
 * Pure resolution of a task capability profile against the arbitrated
 * catalog: for every requirement the best claim version (highest version,
 * at or above `minVersion` when given) is selected and recorded WITH its
 * evidence reference and provenance — the resolution output is the durable
 * record of WHICH claim versions satisfied the profile.
 *
 * Resolution is rail/provider-agnostic by construction: it receives claims
 * and a profile, nothing else. Provider selection happens downstream and
 * separately (`spec/architecture.md` §2.5).
 */

import type {
  CapabilityClaimRecord,
  CapabilityResolution,
  ClaimSatisfaction,
  TaskCapabilityProfile,
  UnmetRequirement,
} from "./capability";
import { compareVersions } from "./validation";

export function resolveProfile(
  claims: readonly CapabilityClaimRecord[],
  profile: TaskCapabilityProfile,
  catalogRevision: string,
): CapabilityResolution {
  const unmet: UnmetRequirement[] = [];
  const satisfactions: ClaimSatisfaction[] = [];

  for (const requirement of profile.requirements) {
    const candidates = claims.filter(
      (record) => record.claim.id === requirement.id && record.claim.kind === requirement.kind,
    );
    let best: CapabilityClaimRecord | null = null;
    for (const candidate of candidates) {
      if (requirement.minVersion !== undefined) {
        const comparison = compareVersions(candidate.claim.version, requirement.minVersion);
        if (comparison === null || comparison < 0) {
          continue;
        }
      }
      const againstBest =
        best === null ? 1 : (compareVersions(candidate.claim.version, best.claim.version) ?? -1);
      if (againstBest > 0) {
        best = candidate;
      }
    }
    if (best === null) {
      unmet.push({
        requirementId: requirement.id,
        kind: requirement.kind,
        reason: candidates.length === 0 ? "unknown-capability" : "version-unavailable",
        minVersion: requirement.minVersion ?? null,
      });
      continue;
    }
    satisfactions.push({
      requirementId: requirement.id,
      claimId: best.claim.id,
      claimKind: best.claim.kind,
      claimVersion: best.claim.version,
      evidenceKind: best.evidence.kind,
      evidenceReference: best.evidence.reference,
      publisher: best.provenance.publisher,
    });
  }

  if (unmet.length > 0) {
    return { satisfied: false, catalogRevision, unmet };
  }
  return { satisfied: true, catalogRevision, satisfactions };
}
