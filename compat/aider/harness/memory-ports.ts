/**
 * In-memory port implementations for the PPR-018 proof composition
 * (the harness-side equivalents of the platform's SQL adapters — the
 * same pattern `seedApiPgWorld` composes for VAL-010, without
 * PostgreSQL, which this sandbox does not have).
 *
 * Everything here implements a PUBLIC port interface of a platform
 * module (connections catalog/vault, models dispatch journal) — no
 * platform internals are imported, and no file under `src/**` changes.
 */

import type { ConnectionDispatchFacts } from "../../../src/modules/connections/public";
import type { CredentialMaterializer } from "../../../src/modules/connections/public";
import type { DispatchJournal } from "../../../src/modules/models/ports/dispatch-journal";
import type { DispatchStatus, ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { DispatchIntentInput, JournalAttempt } from "../../../src/modules/models/ports/dispatch-journal";
import type { ConnectionCatalog } from "../../../src/modules/connections/public";

/** The single registered supply connection of the proof composition. */
export interface RegisteredSupplyConnection {
  readonly connectionId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  /** The credential material (auth headers JSON) — materialized only on dispatch. */
  readonly material: string;
}

/**
 * The in-memory connection catalog: one registered supply connection
 * whose dispatch facts the gateway reads (tenant-guarded).
 */
export function createMemoryConnectionCatalog(
  connection: RegisteredSupplyConnection,
): ConnectionCatalog & CredentialMaterializer {
  const facts: ConnectionDispatchFacts = {
    id: connection.connectionId,
    tenantId: connection.tenantId,
    applicationId: connection.applicationId,
    rail: "custom",
    endpointUrl: null,
    credentialKind: "byok",
    credentialRef: `ppr-018-supply-${connection.connectionId.slice(-8)}`,
    status: "active",
  };
  return {
    async getConnectionForDispatch(scope, connectionId) {
      if (connectionId !== connection.connectionId) {
        // The canonical AUTHORIZATION_DENIED of the connections surface.
        throw Object.assign(new Error("connection not found"), { name: "PlatformError" });
      }
      if (facts.tenantId !== scope.tenantId || facts.applicationId !== scope.applicationId) {
        throw Object.assign(new Error("connection belongs to a different application or tenant"), {
          name: "PlatformError",
        });
      }
      return facts;
    },
    async materialize(reference, authorization) {
      if (reference !== facts.credentialRef) {
        throw new Error(`unknown credential reference ${reference}`);
      }
      void authorization;
      return { reference, plaintext: connection.material };
    },
  };
}

/**
 * The in-memory dispatch journal: the durable-intent ledger of the model
 * gateway (intent BEFORE the adapter call, outcome after — the same
 * write discipline as the SQL journal).
 */
export function createMemoryDispatchJournal(): DispatchJournal & {
  readonly attempts: readonly JournalAttempt[];
} {
  const byId = new Map<string, JournalAttempt>();
  let clock = 0;
  const now = () => new Date(Date.parse("2026-09-27T00:00:00Z") + clock++).toISOString();
  return {
    get attempts() {
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async recordIntent(input: DispatchIntentInput) {
      byId.set(input.id, {
        id: input.id,
        tenantId: input.tenantId,
        applicationId: input.applicationId,
        connectionId: input.connectionId,
        rail: input.rail,
        model: input.model,
        requestHash: input.requestHash,
        admitted: true,
        status: "dispatching",
        outcome: null,
        createdAt: now(),
        resolvedAt: null,
      });
    },
    async recordOutcome(attemptId, status, outcome) {
      const attempt = byId.get(attemptId);
      if (attempt === undefined) {
        throw new Error(`unknown dispatch attempt ${attemptId}`);
      }
      byId.set(attemptId, { ...attempt, status, outcome, resolvedAt: now() });
    },
    async recordDenial(input, reason) {
      byId.set(input.id, {
        id: input.id,
        tenantId: input.tenantId,
        applicationId: input.applicationId,
        connectionId: input.connectionId,
        rail: input.rail,
        model: input.model,
        requestHash: input.requestHash,
        admitted: false,
        status: "denied",
        outcome: { reason },
        createdAt: now(),
        resolvedAt: now(),
      });
    },
    async findAttempt(attemptId) {
      return byId.get(attemptId) ?? null;
    },
  };
}

/** Re-export the status type for consumers reading journal rows. */
export type { DispatchStatus, ModelCallOutcome };
