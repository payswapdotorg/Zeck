/**
 * Model gateway (models module application).
 *
 * The provider fabric UNDERNEATH Execution (`spec/contracts.md`: provider
 * selection is forbidden in the public create contract — callers address a
 * CONNECTION, their own policy-gated resource; the rail is derived from
 * durable connection state, never chosen as a public abstraction).
 *
 * The dispatch sequence is the frozen one (`IMPLEMENTATION.md` §7):
 *
 * ```text
 * request -> identity/tenant resolution -> connection facts (tenant-guarded read)
 *         -> admission (policy gate) -> capability resolution (INT-002)
 *         -> rail resolution -> durable intent
 *         -> credential materialization -> adapter call -> observation persisted
 * ```
 *
 * Invariants enforced here, by construction:
 *   * POLICY BEFORE DISPATCH — admission decides before secret
 *     materialization and before transport; there is no default-allow path
 *     (the port must be provided — the module ships no allow-all adapter).
 *   * CAPABILITY BEFORE PROVIDER — the task profile is arbitrated by the
 *     capability authority BEFORE rail/provider resolution (INT-002,
 *     `spec/architecture.md` §2.5); an unsatisfied profile fails canonical
 *     `CAPABILITY_UNAVAILABLE` before any route is selected. There is no
 *     default/skip capability path either (the port must be provided).
 *   * SECRETS LAST — BYOK plaintext is materialized immediately before the
 *     adapter call and exists only inside the adapter invocation scope.
 *   * DURABLE INTENT BEFORE EXTERNAL EFFECT — the journal attempt row is
 *     committed before the transport call.
 *   * PROVIDER ≠ QUALITY — outcomes land on the provider axis only; the
 *     journal CHECK constraint rejects quality classes physically (CON-005).
 *   * TENANT AUTHORITY — connection facts are cross-checked against the
 *     server-derived scope (TENANT_SCOPE_VIOLATION on any disagreement).
 */

import { PlatformError } from "../../../shared/errors";
import type { Principal, ScopeResolver, TenantScope } from "../../auth/public";
import type { TaskCapabilityProfile } from "../../capabilities/public";
import type {
  ConnectionCatalog,
  ConnectionCatalogScope,
  ConnectionDispatchFacts,
  CredentialMaterializer,
} from "../../connections/public";
import type { DispatchStatus, ModelCallOutcome } from "../domain/outcome";
import { isProviderFailure, toPlatformProviderError } from "../domain/provider-failure";
import type { ModelRequest } from "../domain/request";
import type { StreamEvent } from "../domain/stream";
import type { TaskCapabilityResolution } from "../ports/capability-gate";
import type { DispatchAdmission } from "../ports/dispatch-admission";
import type { DispatchIntentInput, DispatchJournal } from "../ports/dispatch-journal";
import type { ProviderDispatchContext, RailRegistry } from "../ports/model-provider";

export interface ModelDispatchResult {
  readonly attemptId: string;
  readonly outcome: ModelCallOutcome;
}

export interface ModelGateway {
  /**
   * One-shot model dispatch through the application's connection. Returns
   * the normalized provider-axis outcome; pre-dispatch rejections
   * (identity/scope/admission) throw canonical `PlatformError`s.
   */
  complete(
    principal: Principal,
    applicationId: string,
    connectionId: string,
    request: ModelRequest,
  ): Promise<ModelDispatchResult>;

  /** Streaming dispatch with identical gating; the journal records the aggregated outcome. */
  stream(
    principal: Principal,
    applicationId: string,
    connectionId: string,
    request: ModelRequest,
  ): Promise<{ attemptId: string; events: AsyncIterable<StreamEvent> }>;
}

export interface ModelGatewayDeps {
  readonly resolver: ScopeResolver;
  /** Connection facts catalog (connections module public surface). */
  readonly catalog: ConnectionCatalog;
  /** BYOK materialization (connections module public surface). */
  readonly credentials: CredentialMaterializer;
  /** Policy gate — REQUIRED; no default exists by design. */
  readonly admission: DispatchAdmission;
  /**
   * Capability authority gate — REQUIRED (WORK-005 / INT-002); no default or
   * skip implementation exists by design. The task profile is resolved
   * BEFORE any rail/provider selection; an unsatisfied profile is a
   * canonical `CAPABILITY_UNAVAILABLE` failure.
   */
  readonly capabilities: TaskCapabilityResolution;
  readonly rails: RailRegistry;
  readonly journal: DispatchJournal;
  readonly generateId: () => string;
  /** One-way provenance hash of the normalized request (payload never journaled). */
  readonly hashRequest: (request: ModelRequest) => string;
  readonly defaultTimeoutMs?: number;
}

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const timeoutMs = deps.defaultTimeoutMs ?? 60_000;

  const outcomeStatusOf = (outcome: ModelCallOutcome): DispatchStatus =>
    outcome.kind === "provider-success" ? "succeeded" : "provider-failed";

  const EMPTY_PROFILE: TaskCapabilityProfile = { requirements: [] };

  /**
   * Capability resolution (INT-002) — the ordering boundary: the task
   * profile is arbitrated by the capability authority BEFORE any
   * rail/provider decision. Unsatisfied → journaled denial + canonical
   * `CAPABILITY_UNAVAILABLE` (consistent with the admission denial
   * pattern). The gate input is deliberately rail-agnostic.
   */
  const resolveCapabilities = async (
    request: ModelRequest,
    intent: DispatchIntentInput,
    connectionId: string,
  ): Promise<void> => {
    const resolution = await deps.capabilities.resolve(request.taskProfile ?? EMPTY_PROFILE);
    if (resolution.satisfied) {
      return;
    }
    const unmet = resolution.unmet
      .map((entry) => `${entry.requirementId}(${entry.reason})`)
      .join(", ");
    await deps.journal.recordDenial(intent, `capability-unavailable: ${unmet}`);
    throw new PlatformError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "task capability profile cannot be satisfied before any route selection",
      details: {
        connectionId,
        catalogRevision: resolution.catalogRevision,
        unmet: resolution.unmet,
      },
    });
  };

  return {
    async complete(principal, applicationId, connectionId, request) {
      // 1. Identity/tenant resolution (server-derived scope).
      const scope: TenantScope = await deps.resolver.resolveApplicationScope(
        principal,
        applicationId,
      );
      const catalogScope: ConnectionCatalogScope = {
        tenantId: scope.tenantId,
        applicationId,
      };

      // 2. Connection facts — a tenant-guarded durable read describing WHAT
      //    would be dispatched (rail/model). No secrets are touched here.
      const facts: ConnectionDispatchFacts = await deps.catalog.getConnectionForDispatch(
        catalogScope,
        connectionId,
      );

      // 3. Policy gate — BEFORE secret materialization and transport.
      const decision = await deps.admission.admit({
        tenantId: scope.tenantId,
        applicationId,
        connectionId,
        rail: facts.rail,
        request,
      });
      const intent = {
        id: deps.generateId(),
        tenantId: scope.tenantId,
        applicationId,
        connectionId,
        rail: facts.rail,
        model: request.model,
        requestHash: deps.hashRequest(request),
      };
      if (!decision.allowed) {
        await deps.journal.recordDenial(intent, decision.reason);
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "dispatch denied by admission policy",
          details: { connectionId, reason: decision.reason },
        });
      }

      // 4. Capability resolution (INT-002) — BEFORE any rail/provider
      //    selection; unsatisfied profiles never reach route resolution.
      await resolveCapabilities(request, intent, connectionId);

      // 5. Rail resolution (the adapter set is composition-owned).
      const provider = deps.rails.providerFor(facts.rail);
      if (provider === null) {
        throw new PlatformError({
          code: "NO_ELIGIBLE_ROUTE",
          message: `no adapter registered for rail ${facts.rail}`,
          details: { rail: facts.rail, connectionId },
        });
      }

      // 6. Durable intent BEFORE the external effect (IMPLEMENTATION.md §14).
      await deps.journal.recordIntent(intent);

      // 7. Credential materialization — the LAST step before the adapter
      //    call; plaintext exists only inside the adapter invocation scope.
      let credential: string | null = null;
      if (facts.credentialKind === "byok") {
        if (facts.credentialRef === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "byok connection carries no credential reference",
            details: { connectionId },
          });
        }
        const materialized = await deps.credentials.materialize(facts.credentialRef, {
          attemptId: intent.id,
          connectionId,
        });
        credential = materialized.plaintext;
      }
      const context: ProviderDispatchContext = {
        endpointUrl: facts.endpointUrl,
        credential,
        timeoutMs,
      };

      // 8. Adapter call, 9. observation persisted.
      //
      // KNOWN provider failures (including any transport failure the shared
      // adapter boundary normalized) arrive as `provider-failure` OUTCOMES and
      // are journaled below. Defense-in-depth: an adapter that violates the
      // port contract and THROWS a normalized `ProviderFailure` still gets it
      // durably recorded (never left silently at `dispatching`) before the
      // canonical `PROVIDER_ERROR` surfaces. UNKNOWN crashes rethrow — the
      // attempt honestly remains `dispatching` (unknown external outcome).
      let outcome: ModelCallOutcome;
      try {
        outcome = await provider.complete(request, context);
      } catch (error) {
        if (!isProviderFailure(error)) {
          throw error;
        }
        await deps.journal.recordOutcome(intent.id, "provider-failed", {
          kind: "provider-failure",
          failure: error,
        });
        throw toPlatformProviderError(error);
      }
      await deps.journal.recordOutcome(intent.id, outcomeStatusOf(outcome), outcome);
      return { attemptId: intent.id, outcome };
    },

    async stream(principal, applicationId, connectionId, request) {
      const scope: TenantScope = await deps.resolver.resolveApplicationScope(
        principal,
        applicationId,
      );
      const facts: ConnectionDispatchFacts = await deps.catalog.getConnectionForDispatch(
        { tenantId: scope.tenantId, applicationId },
        connectionId,
      );
      const decision = await deps.admission.admit({
        tenantId: scope.tenantId,
        applicationId,
        connectionId,
        rail: facts.rail,
        request,
      });
      const intent = {
        id: deps.generateId(),
        tenantId: scope.tenantId,
        applicationId,
        connectionId,
        rail: facts.rail,
        model: request.model,
        requestHash: deps.hashRequest(request),
      };
      if (!decision.allowed) {
        await deps.journal.recordDenial(intent, decision.reason);
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "dispatch denied by admission policy",
          details: { connectionId, reason: decision.reason },
        });
      }

      // Capability resolution (INT-002) — BEFORE any rail/provider
      // selection; unsatisfied profiles never reach route resolution.
      await resolveCapabilities(request, intent, connectionId);

      const provider = deps.rails.providerFor(facts.rail);
      if (provider === null) {
        throw new PlatformError({
          code: "NO_ELIGIBLE_ROUTE",
          message: `no adapter registered for rail ${facts.rail}`,
          details: { rail: facts.rail, connectionId },
        });
      }
      await deps.journal.recordIntent(intent);

      let credential: string | null = null;
      if (facts.credentialKind === "byok") {
        if (facts.credentialRef === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "byok connection carries no credential reference",
            details: { connectionId },
          });
        }
        const materialized = await deps.credentials.materialize(facts.credentialRef, {
          attemptId: intent.id,
          connectionId,
        });
        credential = materialized.plaintext;
      }
      const context: ProviderDispatchContext = {
        endpointUrl: facts.endpointUrl,
        credential,
        timeoutMs,
      };

      const events = provider.stream(request, context);
      const wrap = async function* (): AsyncIterable<StreamEvent> {
        let lastOutcome: ModelCallOutcome | null = null;
        try {
          for await (const event of events) {
            if (event.type === "stream-done") {
              lastOutcome = {
                kind: "provider-success",
                response: {
                  content: [],
                  stopReason: event.stopReason,
                  structuredOutput: null,
                  usage: event.usage,
                  providerLatencyMs: null,
                },
              };
            } else if (event.type === "stream-error") {
              lastOutcome = { kind: "provider-failure", failure: event.failure };
            }
            yield event;
          }
        } catch (error) {
          // Defense-in-depth mirroring the one-shot path: a contract-violating
          // adapter whose transport failure escapes as a THROWN normalized
          // `ProviderFailure` still terminates the stream with the normalized
          // event and a durable provider-axis outcome. Unknown rejections
          // propagate — the attempt honestly remains `dispatching`.
          if (!isProviderFailure(error)) {
            throw error;
          }
          lastOutcome = { kind: "provider-failure", failure: error };
          yield { type: "stream-error", failure: error };
          return;
        } finally {
          // Terminal event observed (or consumer abandoned a completed
          // stream): the aggregated provider-axis outcome is durable. An
          // abandoned/errored stream without a terminal event stays at
          // `dispatching` — honest evidence of an unknown outcome.
          if (lastOutcome !== null) {
            await deps.journal.recordOutcome(intent.id, outcomeStatusOf(lastOutcome), lastOutcome);
          }
        }
      };
      return { attemptId: intent.id, events: wrap() };
    },
  };
}
