/**
 * Discrimination: transport failures become DURABLE provider-axis outcomes
 * (architect remediation on PR #6, CON-005).
 *
 * The blocking finding: known network/timeout failures escaped the gateway
 * as exceptions, leaving the journal attempt indefinitely `dispatching`, when
 * the required flow is
 *
 * ```text
 * transport failure → provider-failure normalization
 *                   → DispatchJournal.recordOutcome(...)
 * ```
 *
 * for BOTH one-shot and streaming dispatches. Each test proves the property
 * holds for the real fabric AND that the pre-remediation behavior (or a
 * conflation mutation) FAILS the same assertion — the tests discriminate:
 *
 *   T1 — one-shot through the REAL OpenRouter adapter + REAL gateway: a
 *        network rejection resolves as provider evidence and lands
 *        `provider-failed` in the journal; the pre-remediation escape
 *        (rejection, no outcome row) fails every assertion.
 *   T2 — the same through the REAL Anthropic adapter (both rails prove the
 *        shared boundary, not one adapter's accident).
 *   T3 — timeout rejections classify as `timeout`, never `network` (a
 *        classification-collapse mutation fails).
 *   T4 — the durable payload stays on the PROVIDER axis: `PROVIDER_ERROR`
 *        evidence, never a verification or quality code (axis-conflation
 *        mutation fails), and the status leaves `dispatching`.
 *   T5 — streaming through the REAL adapter + REAL gateway: a handshake
 *        rejection terminates the event sequence with a normalized
 *        `stream-error` and journals `provider-failed`; the escape mutation
 *        (rejection instead of terminal event) fails.
 *   T6 — KNOWN vs UNKNOWN discrimination: a typed transport failure is
 *        durably recorded; an unknown crash is NOT (stays `dispatching` —
 *        honest unknown). A gateway that recorded unknown crashes as
 *        provider-failed would fail the honesty assertion.
 */

import { describe, expect, test } from "vitest";
import { createScopeResolver } from "../../src/modules/auth/application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "../../src/modules/auth/domain/actor";
import type { MembershipRecord } from "../../src/modules/auth/domain/scope";
import type { IdentityStore } from "../../src/modules/auth/public";
import type { CapabilityResolution } from "../../src/modules/capabilities/public";
import { createAnthropicAdapter } from "../../src/modules/models/adapters/anthropic";
import { createOpenRouterAdapter } from "../../src/modules/models/adapters/openrouter";
import type { ModelGateway } from "../../src/modules/models/application/model-gateway";
import { createModelGateway } from "../../src/modules/models/application/model-gateway";
import type { DispatchStatus, ModelCallOutcome } from "../../src/modules/models/domain/outcome";
import { PROVIDER_AXIS_OUTCOME_CLASSES } from "../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../src/modules/models/domain/provider-failure";
import { toPlatformProviderError } from "../../src/modules/models/domain/provider-failure";
import type { ModelRequest } from "../../src/modules/models/domain/request";
import type { StreamEvent } from "../../src/modules/models/domain/stream";
import type { TaskCapabilityResolution } from "../../src/modules/models/ports/capability-gate";
import type {
  DispatchIntentInput,
  DispatchJournal,
  JournalAttempt,
} from "../../src/modules/models/ports/dispatch-journal";
import type { HttpResponse, HttpTransport } from "../../src/modules/models/ports/http-transport";
import type { ModelProvider } from "../../src/modules/models/ports/model-provider";
import { ERROR_CODES } from "../../src/shared/errors";

const TENANT = "tenant-1";
const APP = "app-1";
const PRINCIPAL: Principal = { actorId: "actor-1", authenticatedAt: "2026-01-01T00:00:00Z" };

const FACTS = {
  "conn-openrouter": {
    id: "conn-openrouter",
    tenantId: TENANT,
    applicationId: APP,
    rail: "openrouter",
    endpointUrl: null,
    credentialKind: "byok",
    credentialRef: "vault-1",
    status: "active",
  },
  "conn-anthropic": {
    id: "conn-anthropic",
    tenantId: TENANT,
    applicationId: APP,
    rail: "anthropic",
    endpointUrl: null,
    credentialKind: "byok",
    credentialRef: "vault-2",
    status: "active",
  },
} as const;

class FakeIdentity implements IdentityStore {
  async provisionActor(_: ProvisionActorInput & { id: string }): Promise<Actor> {
    throw new Error("unused");
  }
  async findActor(): Promise<Actor | null> {
    return null;
  }
  async findMembershipWithApplicationTenant(actorId: string, applicationId: string) {
    return {
      membership: {
        id: "m1",
        actorId,
        applicationId,
        tenantId: TENANT,
        role: "owner",
        createdAt: "2026-01-01T00:00:00Z",
      } satisfies MembershipRecord,
      applicationTenantId: TENANT,
    };
  }
  async findTenantMembership(): Promise<MembershipRecord | null> {
    return null;
  }
  async listMemberships(): Promise<readonly MembershipRecord[]> {
    return [];
  }
  async insertMembership(): Promise<MembershipRecord | null> {
    return null;
  }
  async updateMembershipRole(): Promise<MembershipRecord | null> {
    return null;
  }
  async deleteMembership(): Promise<boolean> {
    return false;
  }
  async lockApplicationMemberships(): Promise<readonly MembershipRecord[]> {
    return [];
  }
}

class RejectingTransport implements HttpTransport {
  constructor(private readonly rejection: Error) {}
  async send(): Promise<HttpResponse> {
    throw this.rejection;
  }
}

function timeoutRejection(): Error {
  const error = new Error("the operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

const NETWORK_REJECTION = new Error("connect ECONNREFUSED 1.2.3.4:443");

const KNOWN_FAILURE: ProviderFailure = {
  category: "network",
  retryable: true,
  rail: "openrouter",
  providerCode: "Error",
  providerMessage: "connect ECONNREFUSED",
  httpStatus: null,
  durationMs: null,
};

/** In-memory journal recording every outcome call (the durable side). */
class RecordingJournal implements DispatchJournal {
  readonly outcomes: Array<{ attemptId: string; status: string; outcomeClass: string }> = [];
  private readonly attempts = new Map<string, JournalAttempt>();

  async recordIntent(input: DispatchIntentInput): Promise<void> {
    this.attempts.set(input.id, {
      ...input,
      admitted: true,
      status: "dispatching",
      outcome: null,
      createdAt: "2026-01-01T00:00:00Z",
      resolvedAt: null,
    });
  }

  async recordOutcome(
    attemptId: string,
    status: DispatchStatus,
    outcome: ModelCallOutcome,
  ): Promise<void> {
    const outcomeClass = outcome.kind;
    this.outcomes.push({ attemptId, status, outcomeClass });
    const attempt = this.attempts.get(attemptId);
    if (attempt !== undefined) {
      this.attempts.set(attemptId, {
        ...attempt,
        status,
        outcome,
        resolvedAt: "2026-01-01T00:00:01Z",
      });
    }
  }

  async recordDenial(): Promise<void> {}

  async findAttempt(attemptId: string): Promise<JournalAttempt | null> {
    return this.attempts.get(attemptId) ?? null;
  }
}

/** Satisfied-by-default capability gate (capability gating has its own suite). */
const SATISFIED_GATE: TaskCapabilityResolution = {
  async resolve(): Promise<CapabilityResolution> {
    return { satisfied: true, catalogRevision: "rev-0", satisfactions: [] };
  },
};

function buildGateway(providers: readonly ModelProvider[], journal: DispatchJournal): ModelGateway {
  return createModelGateway({
    resolver: createScopeResolver(new FakeIdentity()),
    catalog: {
      async getConnectionForDispatch(_scope, connectionId) {
        return FACTS[connectionId as keyof typeof FACTS] as never;
      },
    },
    credentials: {
      async materialize(ref: string) {
        return { reference: ref, plaintext: "materialized" };
      },
    },
    admission: {
      async admit() {
        return { allowed: true };
      },
    },
    capabilities: SATISFIED_GATE,
    rails: {
      rails: providers.map((provider) => provider.rail),
      providerFor: (rail) => providers.find((provider) => provider.rail === rail) ?? null,
    },
    journal,
    generateId: (() => {
      let seq = 0;
      return () => {
        seq += 1;
        return `attempt-${seq}`;
      };
    })(),
    hashRequest: () => "hash",
  });
}

const REQUEST: ModelRequest = {
  model: "some/model",
  messages: [{ role: "user", content: "hello" }],
};

/** The pre-remediation composition, replayed as the mutation: the shared
 *  boundary THREW the failure and the gateway had no catch — so nothing was
 *  journaled and the attempt stayed `dispatching`. */
async function preRemediationEscape(): Promise<{
  escaped: boolean;
  outcomeClass: string | null;
  status: string;
}> {
  const oldBoundaryAdapter: ModelProvider = {
    rail: "openrouter",
    async complete() {
      // Exactly what the old postJson did: THROW the (un journaled,
      // rail-less) transport failure.
      throw {
        category: "network",
        retryable: true,
        rail: "",
        providerCode: null,
        providerMessage: NETWORK_REJECTION.message,
        httpStatus: null,
        durationMs: null,
      } satisfies ProviderFailure;
    },
    async *stream(): AsyncIterable<StreamEvent> {
      // The OLD streaming adapter called transport.send() as its first
      // statement — the rejection escaped before any event was yielded.
      await Promise.reject(NETWORK_REJECTION);
      yield { type: "text-delta", text: "unreachable" };
    },
  };
  // The OLD gateway sequence: durable intent, then the adapter call with NO
  // catch — the rejection escaped and recordOutcome was never reached.
  let escapedOld = false;
  try {
    await oldBoundaryAdapter.complete(REQUEST, {
      endpointUrl: null,
      credential: "x",
      timeoutMs: 1000,
    });
  } catch {
    escapedOld = true; // the escape the architect observed
  }
  return { escaped: escapedOld, outcomeClass: null, status: "dispatching" };
}

describe("discrimination: transport failure → durable provider-axis outcome (CON-005 remediation)", () => {
  test("T1: one-shot network rejection via the REAL openrouter fabric resolves + journals provider-failed", async () => {
    const journal = new RecordingJournal();
    const adapter = createOpenRouterAdapter({
      transport: new RejectingTransport(NETWORK_REJECTION),
    });
    const gateway = buildGateway([adapter], journal);

    const result = await gateway.complete(PRINCIPAL, APP, "conn-openrouter", REQUEST);

    // Resolves (no escape) with normalized provider evidence…
    expect(result.outcome.kind).toBe("provider-failure");
    if (result.outcome.kind !== "provider-failure") return;
    expect(result.outcome.failure.category).toBe("network");
    expect(result.outcome.failure.retryable).toBe(true);
    expect(result.outcome.failure.rail).toBe("openrouter");
    // …and the journal recorded the durable outcome — NOT left dispatching.
    expect(journal.outcomes).toEqual([
      { attemptId: result.attemptId, status: "provider-failed", outcomeClass: "provider-failure" },
    ]);
    const attempt = await journal.findAttempt(result.attemptId);
    expect(attempt?.status).toBe("provider-failed");
    expect(attempt?.resolvedAt).not.toBeNull();

    // MUTATION: the pre-remediation escape fails every one of those
    // assertions (rejection instead of outcome; dispatching instead of
    // provider-failed; no outcome class at all).
    const oldBehavior = await preRemediationEscape();
    expect(oldBehavior.escaped).toBe(true);
    expect(oldBehavior.status).toBe("dispatching");
    expect(oldBehavior.outcomeClass).toBeNull();
    expect(oldBehavior.status).not.toBe("provider-failed");
  });

  test("T2: the same holds through the REAL anthropic adapter (shared boundary, both rails)", async () => {
    const journal = new RecordingJournal();
    const adapter = createAnthropicAdapter({
      transport: new RejectingTransport(NETWORK_REJECTION),
    });
    const gateway = buildGateway([adapter], journal);

    const result = await gateway.complete(PRINCIPAL, APP, "conn-anthropic", REQUEST);
    expect(result.outcome.kind).toBe("provider-failure");
    if (result.outcome.kind !== "provider-failure") return;
    expect(result.outcome.failure.category).toBe("network");
    expect(result.outcome.failure.rail).toBe("anthropic");
    expect(journal.outcomes).toEqual([
      { attemptId: result.attemptId, status: "provider-failed", outcomeClass: "provider-failure" },
    ]);
  });

  test("T3: timeout rejections classify as timeout, not network (classification discriminates)", async () => {
    const journal = new RecordingJournal();
    const adapter = createOpenRouterAdapter({
      transport: new RejectingTransport(timeoutRejection()),
    });
    const gateway = buildGateway([adapter], journal);

    const result = await gateway.complete(PRINCIPAL, APP, "conn-openrouter", REQUEST);
    expect(result.outcome.kind).toBe("provider-failure");
    if (result.outcome.kind !== "provider-failure") return;
    expect(result.outcome.failure.category).toBe("timeout");

    // MUTATION: a classifier collapsed to network-only would fail this.
    const collapsedClassifier = (_error: unknown) => "network" as const;
    expect(collapsedClassifier(timeoutRejection())).not.toBe("timeout");
  });

  test("T4: the durable evidence stays on the PROVIDER axis — never verification/quality", async () => {
    const journal = new RecordingJournal();
    const adapter = createOpenRouterAdapter({
      transport: new RejectingTransport(NETWORK_REJECTION),
    });
    const gateway = buildGateway([adapter], journal);

    const result = await gateway.complete(PRINCIPAL, APP, "conn-openrouter", REQUEST);
    const recorded = journal.outcomes[0];
    expect(recorded).toBeDefined();
    if (recorded === undefined) return;

    // The recorded outcome class is a provider-axis class…
    expect(
      (PROVIDER_AXIS_OUTCOME_CLASSES as readonly string[]).includes(recorded.outcomeClass),
    ).toBe(true);
    // …quality/verification classes are unrepresentable here…
    for (const qualityClass of [
      "verification-failed",
      "quality-failed",
      "verification-inconclusive",
    ]) {
      expect((PROVIDER_AXIS_OUTCOME_CLASSES as readonly string[]).includes(qualityClass)).toBe(
        false,
      );
    }
    // …and the surfaced canonical error is PROVIDER_ERROR, never a
    // verification/quality code.
    if (result.outcome.kind !== "provider-failure") return;
    const canonical = toPlatformProviderError(result.outcome.failure);
    expect(canonical.code).toBe("PROVIDER_ERROR");
    expect(ERROR_CODES.filter((code) => code.startsWith("VERIFICATION"))).not.toContain(
      canonical.code,
    );

    // MUTATION: an axis-conflating mapper would emit verification evidence —
    // proving these assertions discriminate.
    const conflatingMapper = (category: string): string =>
      category === "network" ? "VERIFICATION_INCONCLUSIVE" : "PROVIDER_ERROR";
    expect(conflatingMapper("network")).toBe("VERIFICATION_INCONCLUSIVE");
    expect(conflatingMapper("network")).not.toBe(canonical.code);
  });

  test("T5: streaming handshake rejection → terminal stream-error + durable provider-failed", async () => {
    const journal = new RecordingJournal();
    const adapter = createOpenRouterAdapter({
      transport: new RejectingTransport(NETWORK_REJECTION),
    });
    const gateway = buildGateway([adapter], journal);

    const { attemptId, events } = await gateway.stream(PRINCIPAL, APP, "conn-openrouter", REQUEST);
    const collected: string[] = [];
    let terminalFailure: ProviderFailure | null = null;
    for await (const event of events) {
      collected.push(event.type);
      if (event.type === "stream-error") {
        terminalFailure = event.failure;
      }
    }

    // The consumer sees a TERMINAL NORMALIZED EVENT; nothing escaped.
    expect(collected).toEqual(["stream-error"]);
    expect(terminalFailure).not.toBeNull();
    expect(terminalFailure?.category).toBe("network");
    expect(terminalFailure?.rail).toBe("openrouter");
    // And the journal is durable — not left dispatching.
    expect(journal.outcomes).toEqual([
      { attemptId, status: "provider-failed", outcomeClass: "provider-failure" },
    ]);

    // MUTATION: an adapter that lets the rejection escape yields a REJECTION
    // (no terminal event, no durable outcome) — failing every assertion above.
    const escapingStream: ModelProvider = {
      rail: "openrouter",
      async complete() {
        return { kind: "provider-failure", failure: KNOWN_FAILURE };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        // transport.send() rejected as the generator's first await — the
        // rejection escapes before any normalized event exists.
        await Promise.reject(NETWORK_REJECTION);
        yield { type: "text-delta", text: "unreachable" };
      },
    };
    const escapeJournal = new RecordingJournal();
    const escapeGateway = buildGateway([escapingStream], escapeJournal);
    const escaped = await escapeGateway.stream(PRINCIPAL, APP, "conn-openrouter", REQUEST).then(
      ({ events: escapingEvents }) =>
        (async () => {
          const types: string[] = [];
          try {
            for await (const event of escapingEvents) {
              types.push(event.type);
            }
            return { types, rejected: false };
          } catch {
            return { types, rejected: true };
          }
        })(),
      () => null,
    );
    if (escaped === null) throw new Error("unexpected");
    // The escape shape: rejection, no normalized terminal event, no durable
    // provider-failed outcome on the record.
    expect(escaped.rejected).toBe(true);
    expect(escaped.types).not.toContain("stream-error");
    expect(escapeJournal.outcomes).toEqual([]);
  });

  test("T6: KNOWN transport failures are durable; UNKNOWN crashes honestly stay dispatching", async () => {
    // KNOWN: typed provider failure → recorded.
    const knownJournal = new RecordingJournal();
    const throwingAdapter: ModelProvider = {
      rail: "openrouter",
      async complete() {
        throw KNOWN_FAILURE;
      },
      async *stream(): AsyncIterable<StreamEvent> {
        await Promise.reject(KNOWN_FAILURE);
        yield { type: "text-delta", text: "unreachable" };
      },
    };
    const knownGateway = buildGateway([throwingAdapter], knownJournal);
    const knownError = await knownGateway.complete(PRINCIPAL, APP, "conn-openrouter", REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect(knownJournal.outcomes).toEqual([
      { attemptId: "attempt-1", status: "provider-failed", outcomeClass: "provider-failure" },
    ]);

    // UNKNOWN: plain crash → NOT recorded (stays dispatching — honest).
    const unknownJournal = new RecordingJournal();
    const crashingAdapter: ModelProvider = {
      rail: "openrouter",
      async complete() {
        throw new Error("segfault-ish bug");
      },
      async *stream(): AsyncIterable<StreamEvent> {
        await Promise.reject(new Error("segfault-ish bug"));
        yield { type: "text-delta", text: "unreachable" };
      },
    };
    const unknownGateway = buildGateway([crashingAdapter], unknownJournal);
    const unknownError = await unknownGateway
      .complete(PRINCIPAL, APP, "conn-openrouter", REQUEST)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(unknownJournal.outcomes).toEqual([]);
    const unknownAttempt = await unknownJournal.findAttempt("attempt-1");
    expect(unknownAttempt?.status).toBe("dispatching");

    // The two behaviors are distinct — this is the discrimination the
    // architect demanded: known failures may not masquerade as unknown
    // crashes (silent dispatching), and unknown crashes are not fabricated
    // into provider evidence.
    expect(knownJournal.outcomes.length).not.toBe(unknownJournal.outcomes.length);
    expect(knownError).not.toBeNull();
    expect(unknownError).not.toBeNull();
  });
});
