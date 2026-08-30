/**
 * Public contract barrel of the `artifacts` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/artifacts/` is private
 * to this module.
 *
 * WORK-008 introduces the artifact substrate (CTX-002): content-addressed,
 * tenant-namespaced, immutable-by-construction artifacts (digest = identity;
 * put-if-absent is the entire mutation surface — no update/delete path
 * exists), parent->child lineage edges with source references, and the
 * canonical JSON + sha256 determinism discipline shared with the context
 * compiler. Durability decision (WORK-005 precedent): no migration this
 * round — the `ArtifactStore` port is the seam, satisfied in-process by the
 * in-memory adapter and durably by the filesystem content-addressed adapter.
 */

import type { ModuleDescriptor } from "../../shared/module";
import { createFilesystemArtifactStore } from "./adapters/filesystem-artifact-store";
import { createInMemoryArtifactStore } from "./adapters/in-memory-artifact-store";
import { createNodeDigestPort } from "./adapters/node-digest";
import type {
  ArtifactContentInput,
  ArtifactService,
  ArtifactServiceDeps,
  PutArtifactInput,
} from "./application/artifact-service";
import { createArtifactService } from "./application/artifact-service";
import type {
  ArtifactContent,
  ArtifactDigest,
  ArtifactKind,
  ArtifactPutInput,
  ArtifactPutOutcome,
  ArtifactRecord,
  JsonCanonicalValue,
  LineageDescription,
  LineageEdge,
  SourceReference,
  SourceRefKind,
} from "./domain/artifact";
import { ARTIFACT_KINDS, isArtifactDigest, SOURCE_REF_KINDS } from "./domain/artifact";
import { canonicalJson, isCanonicalizable } from "./domain/canonical";
import type { ArtifactScope, ArtifactStore } from "./ports/artifact-store";
import { STORE_HAS_NO_MUTATION_METHODS } from "./ports/artifact-store";
import type { DigestPort } from "./ports/digest";

export const moduleDescriptor: ModuleDescriptor = { id: "artifacts" };

// Domain: content-addressed artifacts, canonical serialization, lineage.
// Application: the put-if-absent write discipline + tenant adoption boundary.
// Ports: ArtifactStore (no mutation surface) + DigestPort.
// Adapters: node digest, in-memory store, filesystem content-addressed store.
export type {
  ArtifactContent,
  ArtifactContentInput,
  ArtifactDigest,
  ArtifactKind,
  ArtifactPutInput,
  ArtifactPutOutcome,
  ArtifactRecord,
  ArtifactScope,
  ArtifactService,
  ArtifactServiceDeps,
  ArtifactStore,
  DigestPort,
  JsonCanonicalValue,
  LineageDescription,
  LineageEdge,
  PutArtifactInput,
  SourceReference,
  SourceRefKind,
};
export {
  ARTIFACT_KINDS,
  canonicalJson,
  createArtifactService,
  createFilesystemArtifactStore,
  createInMemoryArtifactStore,
  createNodeDigestPort,
  isArtifactDigest,
  isCanonicalizable,
  SOURCE_REF_KINDS,
  STORE_HAS_NO_MUTATION_METHODS,
};
