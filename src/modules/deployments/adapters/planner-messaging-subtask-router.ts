/**
 * Planner messaging subtask-router adapter (deployments module;
 * WORK-025).
 *
 * Implements the deployments module's REQUIRED
 * `MessagingSubtaskRouter` port against the REAL planning module's
 * deterministic-first decision surface (`deriveTaskProfile` +
 * `evaluateDeterministicSufficiency` — the same frozen planner logic
 * the execution planner and the realtime router use). The messaging
 * turn's ROUTE CLASS is therefore established by the existing planner
 * decision, never by a hidden model dispatch and never by
 * deployments-local heuristics:
 *
 *   - planner outcome `sufficient`   → DETERMINISTIC route: no
 *     generative inference, no paid dispatch, no budget reservation;
 *   - planner outcome `uncertain`    → HYBRID route: deterministic-first
 *     with a bounded evaluation remainder — the paid path is
 *     admissible and the FULL admission chain applies;
 *   - planner outcome `insufficient` → GENERATIVE route: semantic
 *     reasoning or a coverage/quality gap requires inference — the
 *     full admission chain (including budget reservation BEFORE the
 *     paid dispatch) applies.
 *
 * The task handed to the planner is the turn's neutral declaration
 * (the subtask kind + the pinned deployment facts + the bounded turn
 * preview); capability resolution comes from the capabilities
 * authority; the deterministic catalog is composition-supplied (the
 * planning module's own catalog surface).
 *
 * Type + runtime coupling is to the planning/capabilities PUBLIC
 * barrels only.
 */

import { PlatformError } from "../../../shared/errors";
import type { CapabilityResolution } from "../../capabilities/public";
import {
  type DeterministicCatalogEntry,
  deriveTaskProfile,
  evaluateDeterministicSufficiency,
} from "../../planning/public";
import type {
  MessagingSubtaskRouter,
  MessagingTurnRoute,
  MessagingTurnRouteRequest,
} from "../ports/messaging-subtask-router";

export interface PlannerMessagingSubtaskRouterDeps {
  /** The capabilities authority resolution (the registry consultee). */
  readonly resolve: (
    requirements: readonly {
      readonly id: string;
      readonly kind: "runtime";
    }[],
  ) => Promise<CapabilityResolution>;
  /** The planning module's deterministic catalog (composition-supplied). */
  readonly catalog: readonly DeterministicCatalogEntry[];
  /** Content digest for the planner profile derivation. */
  readonly digest: (value: unknown) => string;
  /**
   * The conservative paid-turn estimate (micro-USD string) used when the
   * planner profile carries no cost bound. Default "10000" (1 cent) —
   * a deliberate deterministic default, documented in the evidence.
   */
  readonly defaultPaidEstimateMicroUsd?: string;
}

const DEFAULT_PAID_ESTIMATE = "10000";

export function createPlannerMessagingSubtaskRouter(
  deps: PlannerMessagingSubtaskRouterDeps,
): MessagingSubtaskRouter {
  return {
    async routeTurn(request: MessagingTurnRouteRequest): Promise<MessagingTurnRoute> {
      // The neutral turn task handed to the planner: the turn's subtask
      // classification (the planner surface validates the kind, fail
      // closed) + the pinned deployment facts + the bounded preview
      // (raw payloads never cross).
      const requirements = [
        ...request.requiredCapabilities.map((capabilityId) => ({
          id: capabilityId,
          kind: "runtime" as const,
        })),
        { id: `messaging:${request.channelKind}`, kind: "runtime" as const },
      ];
      const resolution = await deps.resolve(requirements);
      let profile: ReturnType<typeof deriveTaskProfile>;
      try {
        profile = deriveTaskProfile(
          {
            task: {
              kind: request.subtaskKind,
              input: {
                channelKind: request.channelKind,
                deploymentId: request.deploymentId,
                planId: request.pinnedPlanId,
                planVersion: request.pinnedPlanVersion,
                turnPreview: request.turnPreview,
                payloadRef: request.turnPayloadRef,
              },
              requiredCapabilities: requirements,
            },
          },
          deps.digest,
        );
      } catch (error) {
        throw new PlatformError({
          code: "NO_ELIGIBLE_ROUTE",
          message: "the messaging turn task could not be profiled by the planner surface",
          details: { cause: error instanceof Error ? error.message : String(error) },
        });
      }
      const decision = evaluateDeterministicSufficiency({
        profile,
        resolution,
        catalog: deps.catalog,
      });
      const routeClass =
        decision.outcome === "sufficient"
          ? ("deterministic" as const)
          : decision.outcome === "uncertain"
            ? ("hybrid" as const)
            : ("generative" as const);
      return {
        routeClass,
        decisionOutcome: decision.outcome,
        reasonCodes: decision.reasons.map((reason) => reason.code),
        rationale:
          decision.reasons[0]?.detail ??
          `planner deterministic-sufficiency outcome ${decision.outcome}`,
        estimatedCostMicroUsd:
          routeClass === "deterministic"
            ? null
            : (profile.maxCostMicroUsd ??
              deps.defaultPaidEstimateMicroUsd ??
              DEFAULT_PAID_ESTIMATE),
      };
    },
  };
}
