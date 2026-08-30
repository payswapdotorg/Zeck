/**
 * Public contract barrel of the `capabilities` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/capabilities/` is
 * private to this module.
 *
 * WORK-005 introduces the capability authority (INT-002): a provider-neutral
 * capability vocabulary (model / tool / algorithm / data / runtime / human),
 * evidence- and version-bound claims, and the registry that validates,
 * arbitrates and resolves task capability profiles BEFORE any provider/model
 * route is selected. The barrel is provider-neutral by construction: no
 * rail slug or provider identifier crosses this surface (statically gated).
 */

import type { ModuleDescriptor } from "../../shared/module";
import { createInMemoryCatalogStore } from "./adapters/in-memory-catalog-store";
import { SEED_CAPABILITY_FACTS } from "./adapters/seed-catalog";
import { createCapabilityRegistry } from "./application/capability-registry";
import type {
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
} from "./domain/capability";
import { CAPABILITY_EVIDENCE_KINDS, CAPABILITY_KINDS } from "./domain/capability";
import { resolveProfile, validatePublishedFact, validateRequirement } from "./domain/index";
import { compareVersions, parseVersion } from "./domain/validation";
import type {
  CapabilityCatalogStore,
  CapabilityFactPublisher,
  CapabilityRegistry,
  CapabilityRegistryOptions,
  FactValidator,
} from "./ports/capability-registry";

export const moduleDescriptor: ModuleDescriptor = { id: "capabilities" };

export type {
  CapabilityAttributeValue,
  CapabilityCatalogStore,
  CapabilityClaimRecord,
  CapabilityDescriptor,
  CapabilityEvidence,
  CapabilityEvidenceKind,
  CapabilityFactPublisher,
  CapabilityKind,
  CapabilityProvenance,
  CapabilityRegistry,
  CapabilityRegistryOptions,
  CapabilityRequirement,
  CapabilityResolution,
  ClaimSatisfaction,
  FactValidation,
  FactValidator,
  PublishedCapabilityFact,
  PublishOutcome,
  TaskCapabilityProfile,
  UnmetReason,
  UnmetRequirement,
};
export {
  CAPABILITY_EVIDENCE_KINDS,
  CAPABILITY_KINDS,
  compareVersions,
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  parseVersion,
  resolveProfile,
  SEED_CAPABILITY_FACTS,
  validatePublishedFact,
  validateRequirement,
};
