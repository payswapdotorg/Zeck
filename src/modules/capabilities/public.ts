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
import { InMemorySubstrateStore } from "./adapters/in-memory-substrate-store";
import { SEED_CAPABILITY_FACTS } from "./adapters/seed-catalog";
import { SqlSubstrateStore } from "./adapters/sql-substrate-store";
import { createCapabilityRegistry } from "./application/capability-registry";
import type {
  SubstrateActor,
  SubstrateRegistry,
  SubstrateRegistryDeps,
} from "./application/substrate-registry";
import { createSubstrateRegistry } from "./application/substrate-registry";
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
import type {
  ComputationalSubstrateInput,
  ComputationalSubstrateRecord,
  SubstrateIsolationClass,
  SubstrateLatencyClass,
  SubstrateLifecycleStatus,
  SubstrateModality,
  SubstrateResourceProfile,
  SubstrateSideEffectClass,
  SubstrateValidation,
  WorkloadClass,
} from "./domain/substrate";
import {
  canonicalSubstrateJson,
  canTransitionSubstrate,
  isSubstrateLifecycleStatus,
  isWorkloadClass,
  SUBSTRATE_ISOLATION_CLASSES,
  SUBSTRATE_LATENCY_CLASSES,
  SUBSTRATE_LIFECYCLE_STATUSES,
  SUBSTRATE_LIFECYCLE_TRANSITIONS,
  SUBSTRATE_MODALITIES,
  SUBSTRATE_SIDE_EFFECT_CLASSES,
  substrateCapabilityClaim,
  substrateContainsRawSecretValue,
  validateComputationalSubstrate,
  WORKLOAD_CLASSES,
} from "./domain/substrate";
import { compareVersions, parseVersion } from "./domain/validation";
import type {
  CapabilityCatalogStore,
  CapabilityFactPublisher,
  CapabilityRegistry,
  CapabilityRegistryOptions,
  FactValidator,
} from "./ports/capability-registry";
import type {
  SubstrateInsertInput,
  SubstrateInsertOutcome,
  SubstrateStatusInput,
  SubstrateStore,
} from "./ports/substrate-store";

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
  ComputationalSubstrateInput,
  ComputationalSubstrateRecord,
  FactValidation,
  FactValidator,
  PublishedCapabilityFact,
  PublishOutcome,
  SubstrateActor,
  SubstrateInsertInput,
  SubstrateInsertOutcome,
  SubstrateIsolationClass,
  SubstrateLatencyClass,
  SubstrateLifecycleStatus,
  SubstrateModality,
  SubstrateRegistry,
  SubstrateRegistryDeps,
  SubstrateResourceProfile,
  SubstrateSideEffectClass,
  SubstrateStatusInput,
  SubstrateStore,
  SubstrateValidation,
  TaskCapabilityProfile,
  UnmetReason,
  UnmetRequirement,
  WorkloadClass,
};
export {
  CAPABILITY_EVIDENCE_KINDS,
  CAPABILITY_KINDS,
  canonicalSubstrateJson,
  canTransitionSubstrate,
  compareVersions,
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  createSubstrateRegistry,
  InMemorySubstrateStore,
  isSubstrateLifecycleStatus,
  isWorkloadClass,
  parseVersion,
  resolveProfile,
  SEED_CAPABILITY_FACTS,
  SqlSubstrateStore,
  SUBSTRATE_ISOLATION_CLASSES,
  SUBSTRATE_LATENCY_CLASSES,
  SUBSTRATE_LIFECYCLE_STATUSES,
  SUBSTRATE_LIFECYCLE_TRANSITIONS,
  SUBSTRATE_MODALITIES,
  SUBSTRATE_SIDE_EFFECT_CLASSES,
  substrateCapabilityClaim,
  substrateContainsRawSecretValue,
  validateComputationalSubstrate,
  validatePublishedFact,
  validateRequirement,
  WORKLOAD_CLASSES,
};
