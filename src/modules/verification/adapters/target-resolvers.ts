/**
 * Target resolvers (verification module adapters; WORK-013).
 *
 * Fail-closed target validation over the REAL identity authorities —
 * verification consumes existing identity/lineage and never creates a
 * parallel artifact identity system:
 *
 *   - `createArtifactTargetResolver` — artifact targets resolve through
 *     the artifacts module's public service (content-addressed identity
 *     in the caller's tenant namespace; a digest of ANOTHER tenant
 *     fails closed, a missing digest fails closed);
 *   - `createPlanRevisionResolver` — plan-revision targets resolve
 *     through the executions ledger's recorded planning decisions (a
 *     plan revision is verifiable only when the planner durably
 *     recorded it for THIS execution; the resolver additionally reports
 *     the revision so stale-result discipline has its input half).
 */

import type { ArtifactService } from "../../artifacts/public";
import { isArtifactDigest } from "../../artifacts/public";
import type { ExecutionService } from "../../executions/public";
import { PLANNING_DECISION_EVENT_TYPE } from "../../executions/public";
import type { TargetResolution, TargetResolver } from "../ports/target-resolvers";

export function createArtifactTargetResolver(service: ArtifactService): TargetResolver {
  return {
    async resolveTarget(input): Promise<TargetResolution> {
      if (!isArtifactDigest(input.target.ref)) {
        return { resolved: false, reason: "artifact target ref is not a valid digest" };
      }
      try {
        const record = await service.getArtifact({ tenantId: input.tenantId }, input.target.ref);
        return {
          resolved: true,
          ...(input.target.revision === undefined
            ? { revision: record.digest }
            : input.target.revision === record.digest
              ? { revision: record.digest }
              : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { resolved: false, reason: message };
      }
    },
  };
}

export function createPlanRevisionResolver(service: ExecutionService): TargetResolver {
  return {
    async resolveTarget(input): Promise<TargetResolution> {
      const events = await service.listEvents(input.applicationId, input.executionId);
      const recorded = events.filter((event) => event.type === PLANNING_DECISION_EVENT_TYPE);
      if (recorded.length === 0) {
        return {
          resolved: false,
          reason: "no planning decision is recorded for this execution",
        };
      }
      const revisions = recorded.map((event) => String(event.reference?.planId ?? ""));
      if (!revisions.includes(input.target.ref)) {
        return {
          resolved: false,
          reason: `plan revision ${input.target.ref} is not a recorded planning decision of this execution (recorded: ${revisions.join(", ")})`,
        };
      }
      return { resolved: true, revision: input.target.ref };
    },
  };
}
