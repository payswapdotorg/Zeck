/**
 * Compiled-context manifest (context module domain; WORK-008 / CTX-001/002).
 *
 * The manifest is the digest-covered, byte-stable PAYLOAD of the compiled
 * context artifact: identical inputs + compiler version -> byte-identical
 * canonical manifest. It deliberately contains NO timestamps, NO random
 * identifiers and NO floating point — the artifact store's `createdAt`
 * metadata lives OUTSIDE the digest-covered content. The artifact's full
 * identity additionally covers the NORMALIZED parents and sourceRefs
 * (issue #13 lineage-identity remediation: provenance is identity-bearing),
 * both of which are deterministic functions of this manifest for
 * compiled-context artifacts.
 *
 * Execution provenance (EXECUTION-PROVENANCE compatible): the manifest
 * records the executionId and plan-revision reference that CONSUMED the
 * compiled context (executions public types used by reference only).
 */

import type { ArtifactDigest } from "../../artifacts/public";
import type { CompiledTaskContext } from "./stages/structure";

/** Frozen compiler identity — part of the digest-covered content. */
export const COMPILER_VERSION = "zeck-context-compiler/1";

/** Reference to the immutable plan revision that consumed this context. */
export interface PlanRevisionRef {
  readonly planId: string;
  /** Monotonic revision number of the plan (integer >= 1). */
  readonly revision: number;
}

/** The execution binding recorded on every compiled context. */
export interface ExecutionConsumptionRef {
  /** Executions module identity (`ExecutionRecord["id"]`, by reference). */
  readonly executionId: string;
  readonly applicationId: string;
  readonly planRevision?: PlanRevisionRef;
}

/** Per-stage statistics (integers only — determinism discipline). */
export interface StageStatistics {
  readonly retrieval: { readonly candidates: number; readonly foreignRejected: number };
  readonly relevance: { readonly kept: number; readonly excluded: number };
  readonly deduplication: { readonly collapsed: number };
  readonly compression: {
    readonly inputChars: number;
    readonly outputChars: number;
    readonly dropped: number;
  };
  readonly structure: { readonly sections: number; readonly items: number };
}

export interface CompiledContextManifest {
  readonly compilerVersion: string;
  readonly kind: "compiled-context";
  readonly consumption: {
    readonly executionId: string;
    readonly applicationId: string;
    readonly planRevision?: PlanRevisionRef;
  };
  /** Digest over the canonical, compiler-relevant request subset. */
  readonly requestDigest: ArtifactDigest;
  /** Parent artifact digests (lineage edges parents -> this artifact). */
  readonly parents: readonly ArtifactDigest[];
  readonly taskContext: CompiledTaskContext;
  readonly stages: StageStatistics;
}

export interface ManifestParts {
  readonly compilerVersion: string;
  readonly consumption: ExecutionConsumptionRef;
  readonly requestDigest: ArtifactDigest;
  readonly parents: readonly ArtifactDigest[];
  readonly taskContext: CompiledTaskContext;
  readonly stages: StageStatistics;
}

/** Deterministic manifest assembly (field order fixed by canonical JSON). */
export function buildManifest(parts: ManifestParts): CompiledContextManifest {
  const consumption: CompiledContextManifest["consumption"] = parts.consumption.planRevision
    ? {
        executionId: parts.consumption.executionId,
        applicationId: parts.consumption.applicationId,
        planRevision: parts.consumption.planRevision,
      }
    : {
        executionId: parts.consumption.executionId,
        applicationId: parts.consumption.applicationId,
      };
  return {
    compilerVersion: parts.compilerVersion,
    kind: "compiled-context",
    consumption,
    requestDigest: parts.requestDigest,
    parents: [...parts.parents].sort(),
    taskContext: parts.taskContext,
    stages: parts.stages,
  };
}
