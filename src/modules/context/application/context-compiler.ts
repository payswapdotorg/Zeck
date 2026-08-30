/**
 * Context compiler orchestration (context module application; WORK-008 /
 * CTX-001/002).
 *
 * Runs the five explicit stages (retrieval -> relevance -> deduplication ->
 * compression -> structural compilation), each a distinct typed unit, and
 * persists exactly ONE digest-stable compiled-context artifact through the
 * artifacts substrate. Determinism contract: identical request + compiler
 * version -> byte-identical manifest -> identical digest (put-if-absent
 * converges); the manifest carries the execution/plan-revision binding
 * (EXECUTION-PROVENANCE) and full source-reference lineage (CTX-002).
 *
 * Order of authority checks (all BEFORE any write):
 *  1. request validation (shape, uuid execution binding, integer budgets);
 *  2. parent artifact references resolved in the CALLER's tenant namespace
 *     (foreign digest -> `TENANT_SCOPE_VIOLATION`; dangling -> `POLICY_DENIED`);
 *  3. tenant assert over every retrieved candidate (foreign candidate ->
 *     `TENANT_SCOPE_VIOLATION`).
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import {
  type ArtifactDigest,
  type ArtifactRecord,
  type ArtifactService,
  canonicalJson,
  type DigestPort,
  isArtifactDigest,
  type SourceReference,
} from "../../artifacts/public";
import type { ExecutionRecord } from "../../executions/public";
import { buildManifest, COMPILER_VERSION, type CompiledContextManifest } from "../domain/manifest";
import type { ContextSourceSelector } from "../domain/source";
import { applyCompressionStage } from "../domain/stages/compression";
import { applyDeduplicationStage } from "../domain/stages/deduplication";
import { applyRelevanceStage } from "../domain/stages/relevance";
import { applyRetrievalStage } from "../domain/stages/retrieval";
import { applyStructureStage } from "../domain/stages/structure";
import type { ContextRetrievalPort } from "../ports/context-retrieval";

/** Execution identity — executions public type BY REFERENCE (no executions edits). */
export type ExecutionId = ExecutionRecord["id"];

export interface ContextCompilePolicy {
  /** Minimum integer relevance score to keep a candidate (>= 0). */
  readonly minRelevanceScore: number;
  readonly perItemCharBudget: number;
  readonly totalCharBudget: number;
}

export const DEFAULT_COMPILE_POLICY: ContextCompilePolicy = {
  minRelevanceScore: 1,
  perItemCharBudget: 2000,
  totalCharBudget: 20000,
};

export interface ContextCompileRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly execution: {
    readonly executionId: ExecutionId;
    readonly planRevision?: { readonly planId: string; readonly revision: number };
  };
  readonly task: { readonly summary: string; readonly keywords?: readonly string[] };
  readonly sources: readonly ContextSourceSelector[];
  /** Parent artifact digests (lineage edges parent -> compiled context). */
  readonly inputArtifactRefs?: readonly string[];
  readonly policy?: Partial<ContextCompilePolicy>;
}

export interface ContextCompileResult {
  readonly manifest: CompiledContextManifest;
  readonly digest: ArtifactDigest;
  readonly artifact: ArtifactRecord;
  readonly outcome: "stored" | "converged";
}

export interface ContextCompilerDeps {
  readonly retrieval: ContextRetrievalPort;
  readonly artifacts: ArtifactService;
  readonly digest: DigestPort;
  /**
   * Test seam (determinism proof): override the compiler identity. The
   * version string is DIGEST-COVERED content, so a different version MUST
   * produce a different digest (proven by test).
   */
  readonly compilerVersion?: string;
}

export interface ContextCompiler {
  compile(request: ContextCompileRequest): Promise<ContextCompileResult>;
}

function validateRequest(request: ContextCompileRequest, policy: ContextCompilePolicy): void {
  if (request.tenantId.length === 0 || request.applicationId.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "tenantId and applicationId are required",
    });
  }
  if (!isUuid(request.execution.executionId)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "execution.executionId must be a UUID (execution binding is mandatory)",
      details: { executionId: request.execution.executionId },
    });
  }
  if (request.execution.planRevision !== undefined) {
    const { planId, revision } = request.execution.planRevision;
    if (planId.length === 0 || !Number.isInteger(revision) || revision < 1) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "planRevision must carry a non-empty planId and an integer revision >= 1",
      });
    }
  }
  if (request.task.summary.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "task.summary is required",
    });
  }
  if (request.sources.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "at least one source selector is required",
    });
  }
  for (const selector of request.sources) {
    if (selector.sourceId.length === 0) {
      throw new PlatformError({ code: "POLICY_DENIED", message: "sourceId must be non-empty" });
    }
  }
  const budgets = [policy.minRelevanceScore, policy.perItemCharBudget, policy.totalCharBudget];
  for (const budget of budgets) {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "compile policy budgets must be non-negative integers (no floating point)",
      });
    }
  }
}

function parseParentRefs(request: ContextCompileRequest): ArtifactDigest[] {
  const parents: ArtifactDigest[] = [];
  for (const ref of request.inputArtifactRefs ?? []) {
    if (!isArtifactDigest(ref)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "inputArtifactRefs entries must be 64-hex artifact digests",
        details: { got: ref },
      });
    }
    parents.push(ref);
  }
  return [...new Set(parents)].sort();
}

export function createContextCompiler(deps: ContextCompilerDeps): ContextCompiler {
  const compilerVersion = deps.compilerVersion ?? COMPILER_VERSION;

  return {
    async compile(request) {
      const policy: ContextCompilePolicy = { ...DEFAULT_COMPILE_POLICY, ...request.policy };
      validateRequest(request, policy);
      const parents = parseParentRefs(request);

      // Authority check 2: parent references must resolve in THIS tenant's
      // namespace (cross-tenant digest = adoption; absent = dangling).
      for (const parent of parents) {
        await deps.artifacts.getArtifact({ tenantId: request.tenantId }, parent);
      }

      // The digest-relevant request subset (deterministic; excludes nothing
      // the compiler can vary between identical requests).
      const requestDigest = deps.digest.sha256Hex(
        canonicalJson({
          compilerVersion,
          tenantId: request.tenantId,
          applicationId: request.applicationId,
          execution: request.execution,
          task: request.task,
          sources: request.sources,
          inputArtifactRefs: parents,
          policy,
        }),
      );

      // Stage 1: retrieval + tenant assert (authority check 3).
      const candidates = await deps.retrieval.retrieve({
        tenantId: request.tenantId,
        sources: request.sources,
      });
      const retrieval = applyRetrievalStage({ tenantId: request.tenantId, candidates });
      if (retrieval.foreign.length > 0) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "retrieval returned candidates owned by another tenant",
          details: {
            foreignCandidates: retrieval.foreign.map((foreign) => ({
              tenantId: foreign.candidate.tenantId,
              sourceId: foreign.candidate.sourceId,
              locator: foreign.candidate.locator,
            })),
          },
        });
      }

      // Stage 2: relevance filtering (integer scoring, deterministic rank).
      const keywords = request.task.keywords ?? [];
      const relevance = applyRelevanceStage({
        candidates: retrieval.accepted,
        taskKeywords: keywords,
        policy: { minScore: policy.minRelevanceScore },
      });

      // Stage 3: deduplication (exact-content collapse, ranked order).
      const deduplication = applyDeduplicationStage({ ranked: relevance.kept });

      // Stage 4: compression (deterministic budgets, provenance preserved).
      const compression = applyCompressionStage({
        ranked: deduplication.unique,
        policy: {
          perItemCharBudget: policy.perItemCharBudget,
          totalCharBudget: policy.totalCharBudget,
        },
      });

      // Stage 5: structural compilation (ordered, fully referenced sections).
      const taskContext = applyStructureStage({
        task: request.task,
        applicationId: request.applicationId,
        execution: { ...request.execution, applicationId: request.applicationId },
        items: compression.items,
      });

      const manifest = buildManifest({
        compilerVersion,
        consumption: { ...request.execution, applicationId: request.applicationId },
        requestDigest,
        parents,
        taskContext,
        stages: {
          retrieval: {
            candidates: candidates.length,
            foreignRejected: retrieval.foreign.length,
          },
          relevance: { kept: relevance.kept.length, excluded: relevance.excluded.length },
          deduplication: { collapsed: deduplication.collapsedCount },
          compression: {
            inputChars: compression.inputChars,
            outputChars: compression.outputChars,
            dropped: compression.droppedLocators.length,
          },
          structure: {
            sections: taskContext.sections.length,
            items: taskContext.sections.reduce((sum, section) => sum + section.items.length, 0),
          },
        },
      });

      const sourceRefs: SourceReference[] = taskContext.sections
        .flatMap((section) => section.items.map((item) => item.sourceRef))
        .sort((a, b) => {
          const ka = `${a.kind}\u0000${a.id}\u0000${a.locator}`;
          const kb = `${b.kind}\u0000${b.id}\u0000${b.locator}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });

      const persisted = await deps.artifacts.putArtifact({
        tenantId: request.tenantId,
        kind: "compiled-context",
        payload: manifest,
        sourceRefs,
        parents,
      });

      return {
        manifest,
        digest: persisted.digest,
        artifact: persisted.record,
        outcome: persisted.status,
      };
    },
  };
}
