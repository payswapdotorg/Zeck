/**
 * Public contract barrel of the `context` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/context/` is private
 * to this module.
 *
 * WORK-008 introduces the context compiler (CTX-001): five explicit,
 * individually testable stages — retrieval (tenant-asserted) -> relevance
 * filtering (integer scoring) -> deduplication -> compression ->
 * structural compilation — orchestrated deterministically over the
 * artifacts substrate (CTX-002): the compiled context persists as ONE
 * content-addressed artifact whose manifest is byte-stable for identical
 * inputs + compiler version, records execution/plan-revision provenance
 * and preserves source-reference lineage.
 */

import type { ModuleDescriptor } from "../../shared/module";
import { createInMemoryRetrieval } from "./adapters/in-memory-retrieval";
import {
  type ContextCompilePolicy,
  type ContextCompileRequest,
  type ContextCompileResult,
  type ContextCompiler,
  type ContextCompilerDeps,
  createContextCompiler,
  DEFAULT_COMPILE_POLICY,
  type ExecutionId,
} from "./application/context-compiler";
import type {
  CompiledContextManifest,
  ExecutionConsumptionRef,
  ManifestParts,
  PlanRevisionRef,
  StageStatistics,
} from "./domain/manifest";
import { buildManifest, COMPILER_VERSION } from "./domain/manifest";
import type { ContextCandidate, ContextSourceSelector } from "./domain/source";
import type {
  CompressedItem,
  CompressionStageInput,
  CompressionStageOutput,
} from "./domain/stages/compression";
import { applyCompressionStage } from "./domain/stages/compression";
import type {
  DeduplicationStageInput,
  DeduplicationStageOutput,
} from "./domain/stages/deduplication";
import { applyDeduplicationStage } from "./domain/stages/deduplication";
import type {
  ExcludedCandidate,
  RankedCandidate,
  RelevanceStageInput,
  RelevanceStageOutput,
} from "./domain/stages/relevance";
import { applyRelevanceStage } from "./domain/stages/relevance";
import type {
  ForeignCandidate,
  RetrievalStageInput,
  RetrievalStageOutput,
} from "./domain/stages/retrieval";
import { applyRetrievalStage } from "./domain/stages/retrieval";
import type {
  CompiledTaskContext,
  ContextTaskDescriptor,
  StructuredItem,
  StructureStageInput,
  TaskContextSection,
} from "./domain/stages/structure";
import { applyStructureStage } from "./domain/stages/structure";
import type { ContextRetrievalPort, RetrievalQuery } from "./ports/context-retrieval";

export const moduleDescriptor: ModuleDescriptor = { id: "context" };

// Application: the deterministic compiler + policy defaults.
// Domain: sources, the five stage units, the digest-stable manifest.
// Ports: tenant-scoped context retrieval.
// Adapters: in-memory retrieval corpus (dev/test).
export type {
  CompiledContextManifest,
  CompiledTaskContext,
  CompressedItem,
  CompressionStageInput,
  CompressionStageOutput,
  ContextCandidate,
  ContextCompilePolicy,
  ContextCompileRequest,
  ContextCompileResult,
  ContextCompiler,
  ContextCompilerDeps,
  ContextRetrievalPort,
  ContextSourceSelector,
  ContextTaskDescriptor,
  DeduplicationStageInput,
  DeduplicationStageOutput,
  ExcludedCandidate,
  ExecutionConsumptionRef,
  ExecutionId,
  ForeignCandidate,
  ManifestParts,
  PlanRevisionRef,
  RankedCandidate,
  RelevanceStageInput,
  RelevanceStageOutput,
  RetrievalQuery,
  RetrievalStageInput,
  RetrievalStageOutput,
  StageStatistics,
  StructuredItem,
  StructureStageInput,
  TaskContextSection,
};
export {
  applyCompressionStage,
  applyDeduplicationStage,
  applyRelevanceStage,
  applyRetrievalStage,
  applyStructureStage,
  buildManifest,
  COMPILER_VERSION,
  createContextCompiler,
  createInMemoryRetrieval,
  DEFAULT_COMPILE_POLICY,
};
