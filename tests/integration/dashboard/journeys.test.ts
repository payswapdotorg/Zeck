/**
 * Dashboard integration journeys (WORK-033).
 *
 * The REAL dashboard server (createDashboard → node:http → the real
 * dispatch, routing, form reading, cookie handling and error surfaces)
 * reading through the REAL SDK client, whose transport is a fake
 * `fetchImpl` implementing the public API wire surface over an in-memory
 * world (a Map in TEST code). Every journey is driven with real `fetch`
 * and a real cookie jar. The fake world implements the REAL
 * application-scope wire rule (WORK-034): every scoped read and governed
 * command requires the canonical X-Zeck-Application header (missing ⇒
 * 422 CAPABILITY_UNAVAILABLE, the server's exact surface message) and
 * visibility is keyed to the request's application scope (a
 * cross-scope miss is an indistinguishable 404); creation keeps its
 * per-request body selector. The dashboard's SDK client is constructed
 * with the deployment's `applicationId`, so its wire calls carry the
 * header by construction — the (l) journeys prove both sides.
 *
 *   (a) first execution: Home → review → POST → 303 → Result → Evidence →
 *       Activity → "How Zeck did it";
 *   (b) the idempotent create (same key + same payload ⇒ ONE durable
 *       world row; same key + different payload ⇒ 409 surfaced honestly);
 *   (c) the failed-execution journey (recoverable-failure surface);
 *   (d) the waiting journey (WAITING_USER → decision surface → cancel
 *       confirmation → POST → 303 → CANCELLED);
 *   (e) the agents journey (inventory → detail: versions, active
 *       version, selection history under the advanced disclosure);
 *   (f) the command surface (navigation / execution-id / agent matches,
 *       proposed-cancel as a LINK only, honest no-match);
 *   (g) the legacy routes still work (AC10);
 *   (h) the 404 execution view;
 *   (i) the 502 upstream-failure view (public error shape only);
 *   (j) the recents-cookie journey (set → listed live → pruned on 404);
 *   (k) every page: one h1, the landmarks, the skip link first;
 *   (l) the application-scope reconciliation (WORK-034): the bound
 *       client sends the header, the world rejects a headerless scoped
 *       call, and a different application scope cannot see this world's
 *       executions (indistinguishable 404 — tenant-safe);
 *   (m) the experience-mode journey (WORK-035): the mode cookie
 *       round-trip and the visibility-only nav sets;
 *   (n) the command-dialog journey (WORK-035): the second front door
 *       dispatches through GET /command; the sheet primitive is wired on
 *       the execution surface;
 *   (o) the attention journey (WORK-035): the attention page aggregates
 *       the consequential items from the live recents scope, the header
 *       indicator appears only when attention exists, and the honest
 *       disclosure of not-yet-exposed sources.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import type {
  AgentStatusView,
  AgentSummary,
  ArtifactReference,
  CostSummary,
  Execution,
  ExecutionEvent,
  ExecutionReceipt,
  ExecutionResult,
  PublicError,
  RouteSummary,
  VerificationResult,
} from "../../../sdk";
import { ZECK_APPLICATION_HEADER } from "../../../sdk";

// ---------------------------------------------------------------------------
// The fake API world (test-only state; the dashboard itself stays stateless)
// ---------------------------------------------------------------------------

const APP_ID = "00000000-0000-7000-8000-0000000000a1";
const OTHER_APP_ID = "00000000-0000-7000-8000-0000000000a2";
const NOW = "2026-09-15T12:00:00Z";

interface FakeWorld {
  readonly executions: Map<string, Execution>;
  readonly events: Map<string, ExecutionEvent[]>;
  readonly verification: Map<string, readonly VerificationResult[]>;
  readonly results: Map<string, ExecutionResult>;
  /** The per-application agent inventory (the scope-selected world). */
  readonly agentsByScope: Map<string, AgentSummary[]>;
  readonly agentStatus: Map<string, AgentStatusView>;
  readonly createIndex: Map<string, { fingerprint: string; executionId: string }>;
  readonly cancelIndex: Map<string, { executionId: string; status: ExecutionReceipt["status"] }>;
  durableCreates: number;
  failAgentList: boolean;
  /**
   * WORK-040 correction (the Architect review of PR #72): a simulated
   * NON-404 failure of the scoped events read for one execution id — the
   * fail-closed regression proof (status 403 = the auth/policy class;
   * anything else = the transport class). NEVER a 404: the 404 absence
   * stays the world's own scope-checked miss below.
   */
  failEventList: { id: string; status: number } | null;
  /** Every scoped wire call's application selector (the (l) proof). */
  readonly scopedCalls: { path: string; application: string }[];
  /** Every create request body (the (s)/(x) proofs: budget, datasets, task). */
  readonly createCalls: Record<string, unknown>[];
}

function event(
  executionId: string,
  type: string,
  sequence: number,
  payload: Record<string, unknown> = {},
): ExecutionEvent {
  return {
    eventId: `ev-${executionId}-${sequence}`,
    executionId,
    type,
    sequence,
    occurredAt: "2026-09-15T12:00:05Z",
    payload,
  };
}

function check(
  executionId: string,
  index: number,
  status: string,
  confidence: number | null,
): VerificationResult {
  return {
    id: `v-${executionId}-${index}`,
    executionId,
    criterionId: `criterion-${index}`,
    strategy: "digest-check",
    status: status as VerificationResult["status"],
    confidence,
    evaluator: { kind: "check", id: "evaluator-1", version: "3" },
    evidenceRefs: [`ref-${index}`],
    recordedAt: "2026-09-15T12:03:41Z",
  };
}

/** The closed create vocabulary (mirrors the real API's M11/M12 rule). */
const CREATE_REQUEST_KEYS: readonly string[] = [
  "applicationId",
  "environmentId",
  "task",
  "inputArtifactRefs",
  "constraints",
  "metadata",
  "userId",
];

interface SeedInput {
  readonly id: string;
  readonly status: Execution["status"];
  readonly description: string;
  readonly eventTypes: readonly string[];
  readonly verification?: readonly VerificationResult[];
  readonly artifacts?: readonly ArtifactReference[];
  readonly route?: RouteSummary;
  readonly cost?: CostSummary;
  readonly lastEventPayload?: Record<string, unknown>;
  /** WORK-039: the recorded constraints (the declared spend/quality/latency controls). */
  readonly constraints?: Execution["constraints"];
  /** WORK-039: the recorded compute environment id. */
  readonly environmentId?: string | null;
}

function seedExecution(world: FakeWorld, input: SeedInput): Execution {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(input.status);
  const execution: Execution = {
    id: input.id,
    applicationId: APP_ID,
    environmentId: input.environmentId ?? null,
    status: input.status,
    task: { kind: "outcome", description: input.description },
    constraints: input.constraints ?? null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: terminal ? "2026-09-15T12:03:42Z" : null,
  };
  const events = input.eventTypes.map((type, index) => {
    const isLast = index === input.eventTypes.length - 1;
    return event(
      input.id,
      type,
      index + 1,
      isLast && input.lastEventPayload !== undefined ? input.lastEventPayload : {},
    );
  });
  const result: ExecutionResult = {
    executionId: input.id,
    status: input.status,
    route: input.route ?? null,
    cost: input.cost ?? null,
    usage: null,
    outputArtifacts: input.artifacts ?? [],
    verification: input.verification ?? [],
    warnings: [],
    terminalAt: terminal ? "2026-09-15T12:03:42Z" : null,
  };
  world.executions.set(input.id, execution);
  world.events.set(input.id, events);
  world.verification.set(input.id, input.verification ?? []);
  world.results.set(input.id, result);
  return execution;
}

function createFakeApi(world: FakeWorld): typeof fetch {
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const publicError = (status: number, code: PublicError["code"], message: string): Response =>
    reply(status, { code, message, retryable: false } satisfies PublicError);

  /** The fake world's mirror of the server's 404 scope-checked miss (M1). */
  const executionNotFound = (): Response =>
    publicError(404, "CAPABILITY_UNAVAILABLE", "execution not found");

  /**
   * The REAL server-side rule (WORK-034's single-sourced
   * `applicationScopeOf`), mirrored exactly: every scoped route requires
   * the canonical X-Zeck-Application header; missing/empty ⇒ 422
   * CAPABILITY_UNAVAILABLE with the surface-prefixed canonical message
   * (the route throws, the fake error-mapper converts — the same shape
   * the real API produces).
   */
  class ScopeRequiredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ScopeRequiredError";
    }
  }
  const requireApplicationScope = (
    headers: Record<string, string>,
    surface: string,
    path: string,
  ): string => {
    const value = headers[ZECK_APPLICATION_HEADER];
    if (typeof value !== "string" || value.length === 0) {
      throw new ScopeRequiredError(
        `${surface} require the X-Zeck-Application header (the application whose scope authorizes the request)`,
      );
    }
    world.scopedCalls.push({ path, application: value });
    return value;
  };

  const route = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;

    // POST /executions — create with the real idempotency semantics.
    if (path === "/executions" && method === "POST") {
      const key = headers["idempotency-key"] ?? "";
      if (key.length === 0 || key.length > 256) {
        return publicError(
          400,
          "CAPABILITY_UNAVAILABLE",
          "POST routes require an Idempotency-Key header",
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      world.createCalls.push(body);
      for (const keyName of Object.keys(body)) {
        if (!CREATE_REQUEST_KEYS.includes(keyName)) {
          return publicError(
            400,
            "CAPABILITY_UNAVAILABLE",
            `unknown keys are rejected: ${keyName}`,
          );
        }
      }
      // WORK-039 (am): the fake wire enforces the same admission boundary
      // the real platform enforces at dispatch — a declared spend limit
      // over the effective ceiling ($100 in this fake world, above every
      // existing journey's declared limit) is refused with the typed
      // policy denial (BEFORE any durable record; adjusting the limit and
      // resubmitting succeeds — the refusal never wedges the create).
      const declaredLimit = (body.constraints as Record<string, unknown> | undefined | null)
        ?.maxCostMicroUsd;
      if (
        typeof declaredLimit === "string" &&
        /^\d+$/.test(declaredLimit) &&
        BigInt(declaredLimit) > 100_000_000n
      ) {
        return publicError(
          403,
          "POLICY_DENIED",
          "the requested spend exceeds the effective policy ceiling",
        );
      }
      const fingerprint = JSON.stringify(body);
      const established = world.createIndex.get(key);
      if (established !== undefined) {
        if (established.fingerprint === fingerprint) {
          const existing = world.executions.get(established.executionId);
          return reply(201, {
            executionId: established.executionId,
            applicationId: existing?.applicationId ?? APP_ID,
            status: existing?.status ?? "CREATED",
            createdAt: existing?.createdAt ?? NOW,
            replayed: true,
            lastEventSequence: 1,
          } satisfies ExecutionReceipt);
        }
        return publicError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "the idempotency key was reused with a different request",
        );
      }
      const executionId = `00000000-0000-7000-8000-${String(world.durableCreates + 1).padStart(4, "0")}`;
      const execution = seedExecution(world, {
        id: executionId,
        status: "COMPLETED",
        description:
          typeof (body.task as Record<string, unknown> | undefined)?.description === "string"
            ? ((body.task as Record<string, unknown>).description as string)
            : "(no description)",
        eventTypes: [
          "execution.created",
          "execution.authorize",
          "execution.plan",
          "execution.queue",
          "execution.start",
          "execution.verify",
          "execution.pass",
        ],
        verification: [check(executionId, 1, "PASS", 0.93), check(executionId, 2, "PASS", 0.88)],
        artifacts: [
          {
            id: `${executionId}-artifact-1`,
            digest: "a1b2c3d4e5f6",
            createdAt: "2026-09-15T12:03:40Z",
          },
        ],
        route: {
          provider: "neutral-provider",
          model: "neutral-model",
          strategyClass: "hybrid",
          modelCalls: 4,
        },
        cost: { totalMicroUsd: "4180000", currency: "usd" },
      });
      world.createIndex.set(key, { fingerprint, executionId: execution.id });
      world.durableCreates += 1;
      return reply(201, {
        executionId: execution.id,
        applicationId: execution.applicationId,
        status: execution.status,
        createdAt: execution.createdAt,
        replayed: false,
        lastEventSequence: 1,
      } satisfies ExecutionReceipt);
    }

    // POST /executions/:id/cancel — the governed cancel command (a scoped
    // surface: WORK-034's "execution commands" rule + scope-checked
    // visibility, exactly the real route's order: header → visible →
    // idempotent replay → governed transition).
    const cancelMatch = /^\/executions\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch !== null && method === "POST") {
      const applicationId = requireApplicationScope(headers, "execution commands", path);
      const id = decodeURIComponent(cancelMatch[1] ?? "");
      const key = headers["idempotency-key"] ?? "";
      const execution = world.executions.get(id);
      if (execution === undefined || execution.applicationId !== applicationId) {
        return executionNotFound();
      }
      const replay = world.cancelIndex.get(key);
      if (replay !== undefined && replay.executionId === id) {
        return reply(200, {
          executionId: id,
          applicationId: execution.applicationId,
          status: replay.status,
          createdAt: execution.createdAt,
          replayed: true,
          lastEventSequence: 1,
        } satisfies ExecutionReceipt);
      }
      if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
        return publicError(
          409,
          "INVALID_STATE_TRANSITION",
          "a terminal execution cannot be cancelled",
        );
      }
      const events = world.events.get(id) ?? [];
      // The fake authority applies the governed transition to the in-memory
      // world record (the wire records are read-only at the type level; the
      // fake store keeps a mutable projection of them).
      const mutable = execution as unknown as {
        status: Execution["status"];
        terminalAt: string | null;
        updatedAt: string;
      };
      mutable.status = "CANCELLED";
      mutable.terminalAt = "2026-09-15T12:04:00Z";
      mutable.updatedAt = "2026-09-15T12:04:00Z";
      events.push(event(id, "execution.cancel", events.length + 1));
      world.events.set(id, events);
      const result = world.results.get(id) as
        | { status: ExecutionResult["status"]; terminalAt: string | null }
        | undefined;
      if (result !== undefined) {
        result.status = "CANCELLED";
        result.terminalAt = mutable.terminalAt;
      }
      if (key.length > 0) {
        world.cancelIndex.set(key, { executionId: id, status: "CANCELLED" });
      }
      return reply(200, {
        executionId: id,
        applicationId: execution.applicationId,
        status: "CANCELLED",
        createdAt: execution.createdAt,
        replayed: false,
        lastEventSequence: events.length,
      } satisfies ExecutionReceipt);
    }

    // The scoped execution reads ("execution reads" — WORK-034): the
    // header selects the application scope; an execution outside it is
    // indistinguishable from a missing one (M1).
    const executionMatch = /^\/executions\/([^/]+)$/.exec(path);
    if (executionMatch !== null && method === "GET") {
      const applicationId = requireApplicationScope(headers, "execution reads", path);
      const id = decodeURIComponent(executionMatch[1] ?? "");
      const execution = world.executions.get(id);
      if (execution === undefined || execution.applicationId !== applicationId) {
        return executionNotFound();
      }
      return reply(200, execution);
    }
    const resultsMatch = /^\/executions\/([^/]+)\/results$/.exec(path);
    if (resultsMatch !== null && method === "GET") {
      const applicationId = requireApplicationScope(headers, "execution reads", path);
      const id = decodeURIComponent(resultsMatch[1] ?? "");
      const execution = world.executions.get(id);
      const result = world.results.get(id);
      if (execution === undefined || execution.applicationId !== applicationId) {
        return executionNotFound();
      }
      if (result === undefined) {
        return executionNotFound();
      }
      return reply(200, result);
    }
    const eventsMatch = /^\/executions\/([^/]+)\/events$/.exec(path);
    if (eventsMatch !== null && method === "GET") {
      const applicationId = requireApplicationScope(headers, "execution reads", path);
      const id = decodeURIComponent(eventsMatch[1] ?? "");
      const execution = world.executions.get(id);
      const events = world.events.get(id);
      if (execution === undefined || execution.applicationId !== applicationId) {
        return executionNotFound();
      }
      // WORK-040 correction: the simulated NON-404 events-read failure
      // (403 POLICY_DENIED = the auth/policy class; PROVIDER_ERROR = the
      // transport class) — the dashboard must FAIL CLOSED on it, never
      // swallow it into an empty session projection.
      if (world.failEventList?.id === id) {
        return world.failEventList.status === 403
          ? publicError(403, "POLICY_DENIED", "the scoped event read was denied")
          : publicError(500, "PROVIDER_ERROR", "simulated event-read failure");
      }
      if (events === undefined) {
        return executionNotFound();
      }
      return reply(200, events);
    }
    const verificationMatch = /^\/executions\/([^/]+)\/verification$/.exec(path);
    if (verificationMatch !== null && method === "GET") {
      const applicationId = requireApplicationScope(headers, "execution reads", path);
      const id = decodeURIComponent(verificationMatch[1] ?? "");
      const execution = world.executions.get(id);
      const verification = world.verification.get(id);
      if (execution === undefined || execution.applicationId !== applicationId) {
        return executionNotFound();
      }
      if (verification === undefined) {
        return executionNotFound();
      }
      return reply(200, verification);
    }

    // The scoped agent inventory reads ("agent inventory reads" — WORK-034):
    // the scope selects the application's agents (an empty list for an
    // application with none — never a cross-scope leak).
    if (path === "/agents" && method === "GET") {
      const applicationId = requireApplicationScope(headers, "agent inventory reads", path);
      if (world.failAgentList) {
        return publicError(500, "PROVIDER_ERROR", "simulated upstream failure");
      }
      return reply(200, world.agentsByScope.get(applicationId) ?? []);
    }
    const agentStatusMatch = /^\/agents\/([^/]+)\/status$/.exec(path);
    if (agentStatusMatch !== null && method === "GET") {
      const applicationId = requireApplicationScope(headers, "agent inventory reads", path);
      const id = decodeURIComponent(agentStatusMatch[1] ?? "");
      const inScope = (world.agentsByScope.get(applicationId) ?? []).some(
        (candidate) => candidate.id === id,
      );
      const status = world.agentStatus.get(id);
      if (!inScope || status === undefined) {
        return publicError(404, "CAPABILITY_UNAVAILABLE", "agent not found");
      }
      return reply(200, status);
    }
    return publicError(500, "PROVIDER_ERROR", `unexpected path ${path}`);
  };

  // The fake error-mapper: a scoped route's thrown ScopeRequiredError
  // becomes the real 422 public-error shape (the same conversion the real
  // API's error-mapper performs for PublicValidationError).
  return (async (input: string | URL, init?: RequestInit) => {
    try {
      return await route(input, init);
    } catch (error) {
      if (error instanceof ScopeRequiredError) {
        return publicError(422, "CAPABILITY_UNAVAILABLE", error.message);
      }
      throw error;
    }
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// The world + server under test
// ---------------------------------------------------------------------------

const COMPLETED_ID = "00000000-0000-7000-8000-0000000000c1";
const FAILED_ID = "00000000-0000-7000-8000-0000000000c2";
const WAITING_ID = "00000000-0000-7000-8000-0000000000c3";
const RUNNING_ID = "00000000-0000-7000-8000-0000000000c4";
const RECENTS_ID = "00000000-0000-7000-8000-0000000000c5";
const QUALITY_ID = "00000000-0000-7000-8000-0000000000c7";
const WAITING2_ID = "00000000-0000-7000-8000-0000000000c8";
const RETRYABLE_ID = "00000000-0000-7000-8000-0000000000c9";
const NONRETRY_ID = "00000000-0000-7000-8000-0000000000ca";
const AGENT_ID = "00000000-0000-7000-8000-0000000000b1";
// WORK-037 (t): the long-running workload fixture — a RUNNING execution
// whose public event stream carries the platform's own typed long-running
// facts (checkpoints + a resume), with settled cost recorded.
const LONGRUN_ID = "00000000-0000-7000-8000-0000000000cb";
// (u): the completed long-running workload fixture.
const LONGRUN_DONE_ID = "00000000-0000-7000-8000-0000000000cc";
// WORK-038 (y): the four required trust-state fixtures —
// provider-success/task-failure, execution-success/quality-failure (the
// existing QUALITY_ID), policy-blocked and verified-success. The
// verified-success run (VERIFIED_ID) doubles as the lineage fixture: its
// `execution.created` payload carries recorded input refs (the parent
// artifacts — including the COMPLETED run's output f1), its outputs (f2)
// are referenced by its own verification checks' evidenceRefs, and
// CONSUMER_ID records f2 as an input (the usage reference).
const PROVFAIL_ID = "00000000-0000-7000-8000-0000000000cd";
const POLICY_ID = "00000000-0000-7000-8000-0000000000ce";
const VERIFIED_ID = "00000000-0000-7000-8000-0000000000cf";
const CONSUMER_ID = "00000000-0000-7000-8000-0000000000d1";
const ARTIFACT_F1 = "00000000-0000-7000-8000-0000000000f1";
const ARTIFACT_F2 = "00000000-0000-7000-8000-0000000000f2";
// WORK-039 (ad)–(am): the control-plane fixtures — a constrained +
// costed spend run (the declared limit, the settled cost, the routed
// provider), an environment-tagged run and a waiting-human approval run.
const SPEND_ID = "00000000-0000-7000-8000-0000000000d2";
const ENV_ID = "00000000-0000-7000-8000-0000000000d3";
const APPROVAL_ID = "00000000-0000-7000-8000-0000000000d4";
// WORK-040 (an)–(au): the multimodal fixtures — computer-use, realtime,
// media, training, economic, planning-decision, edge, and the
// real-wire-prefixed long-running run.
const COMPUTER_USE_ID = "00000000-0000-7000-8000-0000000000e5";
const REALTIME_ID = "00000000-0000-7000-8000-0000000000e6";
const MEDIA_ID = "00000000-0000-7000-8000-0000000000e7";
const TRAINING_ID = "00000000-0000-7000-8000-0000000000e8";
const ECONOMIC_ID = "00000000-0000-7000-8000-0000000000ed";
const INSPECT_ID = "00000000-0000-7000-8000-0000000000ea";
const EDGE_ID = "00000000-0000-7000-8000-0000000000eb";
const PREFIXED_LONGRUN_ID = "00000000-0000-7000-8000-0000000000ec";

/**
 * WORK-040 (as): the full planning decision record — the REAL planner
 * payload shape (PlanningDecisionRecord) as the public wire carries it
 * inside the `planning.decision-recorded` event.
 */
const INSPECT_DECISION_PAYLOAD = {
  decisionId: "decision-inspect-1",
  plannerVersion: "1.4.2",
  taskProfile: {
    profileDigest: "sha256:profile-1",
    kind: "extraction",
    input: { description: "Batch the nightly statement exports" },
    riskLevel: "moderate",
    qualityTarget: 0.9,
    maxCostMicroUsd: "4000000",
    maxLatencyMs: 60000,
    requiresSemanticReasoning: true,
  },
  policyInputs: { outcome: "allow", policySetId: "policy-set-7", policySetVersion: 3 },
  capabilityResolution: {
    satisfied: true,
    catalogRevision: "rev-42",
    satisfiedIds: ["cap-batch", "cap-verify"],
    unmetIds: [],
  },
  deterministicSufficiency: {
    outcome: "insufficient",
    semanticReasoningRequired: true,
    deterministicQualityEstimate: 0.62,
  },
  candidates: [
    {
      strategyId: "strategy-deterministic-batch",
      plan: { planId: "plan-batch-1" },
      expectedCostMicroUsd: "500000",
      expectedQuality: 0.62,
      expectedLatencyMs: 9000,
      verificationStrategy: "digest-check",
      routeRationale: {
        code: "deterministic-quality-gap",
        detail: "below the task quality target",
      },
      modelCalls: 0,
      admissible: true,
    },
    {
      strategyId: "strategy-hybrid-batch",
      plan: { planId: "plan-batch-2" },
      expectedCostMicroUsd: "3100000",
      expectedQuality: 0.93,
      expectedLatencyMs: 21000,
      verificationStrategy: "digest-check",
      routeRationale: {
        code: "semantic-reasoning-required",
        detail: "the task requires semantic reasoning",
      },
      modelCalls: 3,
      admissible: false,
      inadmissibleReason: "policy-cost-ceiling",
    },
  ],
  selectedStrategyId: "strategy-deterministic-batch",
  selectionRationale: "deterministic-first preference applied",
  subgraphEvidence: [{ observationId: "obs-1" }, { observationId: "obs-2" }],
  substrateSelection: {
    outcome: "selected",
    workloadClass: "batch",
    admissible: [
      {
        substrateId: "substrate-batch-1",
        version: "2.1.0",
        adapterRef: "adapter.batch.compute",
        resource: {
          cpuMilliCores: 4000,
          memoryMiB: 8192,
          estimatedDurationMs: 30000,
          estimatedCostMicroUsd: "1800000",
        },
        isolation: "process-isolated",
        latencyClass: "batch",
      },
    ],
    inadmissible: [
      {
        substrateId: "substrate-batch-2",
        version: "1.0.0",
        reason: "cost-above-ceiling",
        detail: "the estimate exceeds the declared cost ceiling",
      },
    ],
    selected: { substrateId: "substrate-batch-1", version: "2.1.0" },
    rationale: "the only in-ceiling batch candidate",
    after: {
      policyInputsCaptured: true,
      capabilityResolutionCaptured: true,
      deterministicSufficiencyApplied: true,
    },
  },
  recordedAt: "2026-09-15T12:00:07Z",
  recordDigest: "sha256:decision-inspect-1",
} as unknown as Record<string, unknown>;

let world: FakeWorld;
let base = "";

beforeAll(async () => {
  world = {
    executions: new Map(),
    events: new Map(),
    verification: new Map(),
    results: new Map(),
    agentsByScope: new Map(),
    agentStatus: new Map(),
    createIndex: new Map(),
    cancelIndex: new Map(),
    durableCreates: 0,
    failAgentList: false,
    failEventList: null,
    scopedCalls: [],
    createCalls: [],
  };

  seedExecution(world, {
    id: COMPLETED_ID,
    status: "COMPLETED",
    description: "Contract risk analysis",
    eventTypes: ["execution.created", "execution.authorize", "execution.start", "execution.pass"],
    verification: [check(COMPLETED_ID, 1, "PASS", 0.9), check(COMPLETED_ID, 2, "FAIL", 0.4)],
    artifacts: [
      {
        id: "00000000-0000-7000-8000-0000000000f1",
        digest: "digest-f1",
        createdAt: "2026-09-15T12:03:40Z",
      },
    ],
    route: { provider: "neutral-p", model: "neutral-m", strategyClass: "hybrid", modelCalls: 2 },
    cost: { totalMicroUsd: "4180000", currency: "usd" },
  });
  seedExecution(world, {
    id: FAILED_ID,
    status: "FAILED",
    description: "Extract clauses from the scanned contract",
    eventTypes: ["execution.created", "execution.authorize", "execution.start", "execution.fail"],
    lastEventPayload: { message: "the tool rejected the request after three attempts" },
  });
  seedExecution(world, {
    id: WAITING_ID,
    status: "WAITING_USER",
    description: "Draft the vendor reply",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.wait-user",
    ],
    lastEventPayload: { question: "Approve the external side effect?" },
  });
  seedExecution(world, {
    id: RUNNING_ID,
    status: "RUNNING",
    description: "Index the document archive",
    eventTypes: ["execution.created", "execution.authorize", "execution.start"],
  });
  seedExecution(world, {
    id: RECENTS_ID,
    status: "COMPLETED",
    description: "Summarize the support queue",
    eventTypes: ["execution.created", "execution.authorize", "execution.pass"],
  });
  // WORK-036 (q): the quality-failure fixture — the work completed, one
  // check failed (a distinct dimension from an execution failure).
  seedExecution(world, {
    id: QUALITY_ID,
    status: "COMPLETED",
    description: "Reconcile the vendor invoices",
    eventTypes: ["execution.created", "execution.authorize", "execution.start", "execution.pass"],
    verification: [check(QUALITY_ID, 1, "PASS", 0.91), check(QUALITY_ID, 2, "FAIL", null)],
  });
  // WORK-036 (q, AC10 amendment): FAILED fixtures whose event streams
  // carry PLATFORM-TYPED recoverability facts (the platform's own
  // vocabulary — failureClass + retryable, mirroring the tools runtime's
  // real retryable mapping: timeout → retryable, output-contract → not
  // retryable). The dashboard surfaces such facts verbatim; it never
  // infers one from free text.
  seedExecution(world, {
    id: RETRYABLE_ID,
    status: "FAILED",
    description: "Rebuild the search index",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.tool-result",
      "execution.fail",
    ],
  });
  {
    const evs = world.events.get(RETRYABLE_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "execution.tool-result") {
        evs[index] = {
          ...entry,
          payload: { outcomeClass: "tool-failure", failureClass: "timeout", retryable: true },
        };
      }
    });
  }
  seedExecution(world, {
    id: NONRETRY_ID,
    status: "FAILED",
    description: "Normalize the invoice exports",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.tool-result",
      "execution.fail",
    ],
  });
  {
    const evs = world.events.get(NONRETRY_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "execution.tool-result") {
        evs[index] = {
          ...entry,
          payload: {
            outcomeClass: "tool-failure",
            failureClass: "output-contract",
            retryable: false,
          },
        };
      }
    });
  }
  // WORK-037 (t)/(u): the long-running workload fixture — checkpoints (the
  // platform's own typed payloads: checkpointSequence + lastEventPosition,
  // exactly the real long-running service's public payload shape) plus a
  // resume-recorded recovery event, settled cost, and PASS verification.
  const longrun = seedExecution(world, {
    id: LONGRUN_ID,
    status: "RUNNING",
    description: "Train the classifier on the ticket dataset",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "checkpoint-recorded",
      "checkpoint-recorded",
      "resume-recorded",
    ],
    verification: [check(LONGRUN_ID, 1, "PASS", 0.91)],
    cost: { totalMicroUsd: "1811000", currency: "usd" },
  });
  world.executions.set(LONGRUN_ID, {
    ...longrun,
    constraints: { maxCostMicroUsd: "50000000" },
  });
  {
    const evs = world.events.get(LONGRUN_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "checkpoint-recorded") {
        const seq = evs.slice(0, index + 1).filter((e) => e.type === "checkpoint-recorded").length;
        evs[index] = {
          ...entry,
          payload: {
            checkpointSequence: seq,
            lastEventPosition: seq * 4800,
            planId: "plan-lr-1",
            planRevision: 2,
            resourceClass: "accelerated",
          },
        };
      }
    });
  }
  // (u): the COMPLETED workload fixture — the same long-running facts,
  // terminal, every verification check passing. The four-state
  // distinction must still render the release row as the explicit
  // absence (training completion and evaluation never imply release).
  const longrunDone = seedExecution(world, {
    id: LONGRUN_DONE_ID,
    status: "COMPLETED",
    description: "Batch the nightly exports",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "checkpoint-recorded",
      "execution.pass",
    ],
    verification: [check(LONGRUN_DONE_ID, 1, "PASS", 0.95)],
    cost: { totalMicroUsd: "900000", currency: "usd" },
  });
  world.executions.set(LONGRUN_DONE_ID, {
    ...longrunDone,
    constraints: { maxCostMicroUsd: "5000000" },
  });
  {
    const evs = world.events.get(LONGRUN_DONE_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "checkpoint-recorded") {
        evs[index] = {
          ...entry,
          payload: {
            checkpointSequence: 1,
            lastEventPosition: 2200,
            planId: "plan-done-1",
            planRevision: 1,
            resourceClass: "standard",
          },
        };
      }
    });
  }

  // WORK-038 (y): provider-success/task-failure — the route records 4
  // completed provider calls while the task itself FAILED (the two
  // dimensions never collapse).
  seedExecution(world, {
    id: PROVFAIL_ID,
    status: "FAILED",
    description: "Fetch the filings and extract the tables",
    eventTypes: ["execution.created", "execution.authorize", "execution.start", "execution.fail"],
    route: {
      provider: "neutral-provider",
      model: "neutral-model",
      strategyClass: "hybrid",
      modelCalls: 4,
    },
  });
  // (y): policy-blocked — a durable policy-denied admission record; the
  // denial is its own dimension (the execution axis stays in-progress).
  // WORK-039 (ad)/(al): the denial event carries the platform's own
  // recorded reason (the controlling rule) on its payload — exactly the
  // real wire's `execution.policy-denied` `{ denied, reason }` pair.
  seedExecution(world, {
    id: POLICY_ID,
    status: "CREATED",
    description: "Transfer funds to the vendor",
    eventTypes: ["execution.created", "execution.policy-denied"],
    lastEventPayload: {
      from: "CREATED",
      to: "CREATED",
      denied: true,
      reason: "the requested spend exceeds the effective policy ceiling",
    },
  });
  // (y)/(z)/(aa): verified-success — all checks PASS with recorded
  // confidences, an output artifact (f2) referenced by the checks'
  // evidenceRefs, and one OPAQUE ref (no public object with that id).
  seedExecution(world, {
    id: VERIFIED_ID,
    status: "COMPLETED",
    description: "Verify the extracted clause table",
    eventTypes: ["execution.created", "execution.authorize", "execution.start", "execution.pass"],
    verification: [
      {
        id: `v-${VERIFIED_ID}-1`,
        executionId: VERIFIED_ID,
        criterionId: "criterion-table-digest",
        strategy: "digest-check",
        status: "PASS",
        confidence: 0.93,
        evaluator: { kind: "check", id: "evaluator-1", version: "3" },
        evidenceRefs: [ARTIFACT_F2],
        recordedAt: "2026-09-15T12:03:41Z",
      },
      {
        id: `v-${VERIFIED_ID}-2`,
        executionId: VERIFIED_ID,
        criterionId: "criterion-cross-check",
        strategy: "digest-check",
        status: "PASS",
        confidence: 0.88,
        evaluator: { kind: "check", id: "evaluator-1", version: "3" },
        evidenceRefs: ["opaque-evidence-ref-9"],
        recordedAt: "2026-09-15T12:03:41Z",
      },
    ],
    artifacts: [
      {
        id: ARTIFACT_F2,
        digest: "digest-f2",
        createdAt: "2026-09-15T12:03:40Z",
      },
    ],
    route: {
      provider: "neutral-provider",
      model: "neutral-model",
      strategyClass: "hybrid",
      modelCalls: 3,
    },
    cost: { totalMicroUsd: "2210000", currency: "usd" },
  });
  // The verified run's own recorded parents: the COMPLETED run's output
  // artifact f1 plus a hostile ref (the escape-boundary pin).
  {
    const evs = world.events.get(VERIFIED_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "execution.created") {
        evs[index] = {
          ...entry,
          payload: { inputArtifactRefs: [ARTIFACT_F1, "<script>ref-injection</script>"] },
        };
      }
    });
  }
  // (aa): the usage fixture — a second completed run that consumed f2 as
  // a recorded input (f2's "usage references").
  seedExecution(world, {
    id: CONSUMER_ID,
    status: "COMPLETED",
    description: "Draft the renewal summary from the verified table",
    eventTypes: ["execution.created", "execution.authorize", "execution.start", "execution.pass"],
  });
  // WORK-039 (ae): the spend fixture — a run with BOTH a declared limit
  // (the recorded constraint) and a settled cost (the recorded result
  // package), routed through a named provider.
  seedExecution(world, {
    id: SPEND_ID,
    status: "COMPLETED",
    description: "Summarize the quarterly spend report",
    eventTypes: ["execution.created", "execution.authorize", "execution.start", "execution.pass"],
    constraints: { maxCostMicroUsd: "8000000" },
    route: { provider: "neutral-p", model: "neutral-m", strategyClass: "hybrid", modelCalls: 2 },
    cost: { totalMicroUsd: "6250000", currency: "usd" },
  });
  // WORK-039 (ag): the environment fixture — a run recorded against the
  // staging environment (the platform's own environmentId fact).
  seedExecution(world, {
    id: ENV_ID,
    status: "COMPLETED",
    description: "Validate the staging deployment checklist",
    eventTypes: ["execution.created", "execution.authorize", "execution.start", "execution.pass"],
    environmentId: "env-staging",
    route: {
      provider: "neutral-p",
      model: "neutral-m",
      strategyClass: "deterministic",
      modelCalls: 0,
    },
    cost: { totalMicroUsd: "1250000", currency: "usd" },
  });
  // WORK-039 (ah): the approval fixture — a run waiting for a human
  // review the governing policy required (the live approval queue).
  seedExecution(world, {
    id: APPROVAL_ID,
    status: "WAITING_HUMAN",
    description: "Approve the vendor payment batch",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.wait-human",
    ],
    lastEventPayload: { question: "Approve the external side effect?" },
  });
  {
    const evs = world.events.get(CONSUMER_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "execution.created") {
        evs[index] = { ...entry, payload: { inputArtifactRefs: [ARTIFACT_F2] } };
      }
    });
  }

  // WORK-040 (an)–(at): the multimodal fixtures — every payload below is
  // the REAL public wire shape (the prefixed step-event types the
  // platform's eventTypeFor emits, and the payload keys the real
  // producers write), so the journeys prove the surfaces against the
  // actual wire vocabulary.
  // (an): the computer-use run — an admitted browser session, its opened
  // isolated environment (the zero inherited-host-state verdict), and a
  // denied desktop session (journal-then-fail, the platform's reason).
  seedExecution(world, {
    id: COMPUTER_USE_ID,
    status: "COMPLETED",
    description: "Fill the vendor portal form",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.tool-requested",
      "execution.tool-result",
      "execution.tool-denied",
      "execution.pass",
    ],
    cost: { totalMicroUsd: "3100000", currency: "usd" },
  });
  {
    const evs = world.events.get(COMPUTER_USE_ID) ?? [];
    const payloads: Record<string, Record<string, unknown>> = {
      "execution.tool-requested": {
        sessionId: "cu-session-1",
        phase: "session-admitted",
        mode: "browser",
        deterministicFirst: true,
        routeStageCount: 2,
      },
      "execution.tool-result": {
        sessionId: "cu-session-1",
        phase: "environment-opened",
        mode: "browser",
        environmentRef: "env-cu-9",
        inheritedHostStateCount: 0,
      },
      "execution.tool-denied": {
        denied: true,
        sessionId: "cu-session-2",
        mode: "desktop",
        denialClass: "policy",
        code: "POLICY_DENIED",
        reason: "the requested desktop access exceeds the effective policy envelope",
      },
    };
    evs.forEach((entry, index) => {
      const payload = payloads[entry.type];
      if (payload !== undefined) {
        evs[index] = { ...entry, payload };
      }
    });
  }
  // (ao): the realtime/messaging run — a session started by a caller on
  // the realtime rail, one routed turn, and the session completion (the
  // deployments module's real payload vocabulary).
  seedExecution(world, {
    id: REALTIME_ID,
    status: "COMPLETED",
    description: "Support the ticket channel conversation",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.agent-session-started",
      "execution.agent-action-recorded",
      "execution.agent-session-completed",
      "execution.pass",
    ],
  });
  {
    const evs = world.events.get(REALTIME_ID) ?? [];
    const payloads: Record<string, Record<string, unknown>> = {
      "execution.agent-session-started": {
        callerRef: "caller-support-77",
        railCapabilityId: "rail-realtime-voice-1",
      },
      "execution.agent-action-recorded": {
        routeClass: "realtime-turn",
        plannerOutcome: "routed",
        reasonCodes: ["policy-allowed"],
        responsePreview: "Here is the order status…",
      },
    };
    evs.forEach((entry, index) => {
      const payload = payloads[entry.type];
      if (payload !== undefined) {
        evs[index] = { ...entry, payload };
      }
    });
  }
  // (ap): the media run — a generation job submitted with verification
  // required, its generated-output artifact, and the completion with the
  // generation kind and the verified-by-authority marker.
  seedExecution(world, {
    id: MEDIA_ID,
    status: "COMPLETED",
    description: "Generate the campaign hero image",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.agent-session-started",
      "execution.agent-action-recorded",
      "execution.agent-session-completed",
      "execution.pass",
    ],
    artifacts: [
      {
        id: ARTIFACT_F1,
        digest: "digest-f1",
        createdAt: "2026-09-15T12:03:40Z",
      },
    ],
  });
  {
    const evs = world.events.get(MEDIA_ID) ?? [];
    const payloads: Record<string, Record<string, unknown>> = {
      "execution.agent-session-started": {
        verificationMode: "required",
        inputArtifactDigest: "sha256-media-input-1",
        railCapabilityId: "rail-media-image-1",
      },
      "execution.agent-action-recorded": {
        role: "generated-output",
        descriptorDigest: "sha256-media-output-1",
      },
      "execution.agent-session-completed": {
        generationKind: "image",
        postprocessingDigest: "sha256-media-post-1",
        verifiedByAuthority: true,
      },
    };
    evs.forEach((entry, index) => {
      const payload = payloads[entry.type];
      if (payload !== undefined) {
        evs[index] = { ...entry, payload };
      }
    });
  }
  // (aq): the training run — an admitted fine-tune workload with its
  // resource/lineage facts, one training checkpoint (the metrics-digest
  // vocabulary), and the completed attempt with settled usage.
  seedExecution(world, {
    id: TRAINING_ID,
    status: "COMPLETED",
    description: "Fine-tune the support classifier",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.sandbox-admitted",
      "execution.checkpoint-recorded",
      "execution.sandbox-completed",
      "execution.pass",
    ],
    verification: [check(TRAINING_ID, 1, "PASS", 0.94)],
    cost: { totalMicroUsd: "2500000", currency: "usd" },
  });
  {
    const evs = world.events.get(TRAINING_ID) ?? [];
    const payloads: Record<string, Record<string, unknown>> = {
      "execution.sandbox-admitted": {
        workloadId: "training-workload-1",
        workloadKey: "workload-key-ft-1",
        workloadKind: "fine-tune",
        status: "running",
        attempt: 1,
        resource: { cpuMilliCores: 16000, memoryMiB: 65536 },
        lineage: { datasetDigest: "sha256-dataset-1" },
      },
      "execution.checkpoint-recorded": {
        checkpointIdentity: "cp-ft-1",
        checkpointSequence: 1,
        stepPosition: 1200,
        metricsDigest: "sha256-metrics-ft-1",
      },
      "execution.sandbox-completed": {
        workloadId: "training-workload-1",
        workloadKey: "workload-key-ft-1",
        workloadKind: "fine-tune",
        status: "completed",
        attempt: 1,
        outcomeClass: "workload-completed",
        stepsCompleted: 4800,
        outputArtifactDigest: "sha256-model-ft-1",
        usageMicroUsd: "2500000",
      },
    };
    evs.forEach((entry, index) => {
      const payload = payloads[entry.type];
      if (payload !== undefined) {
        evs[index] = { ...entry, payload };
      }
    });
  }
  // (ar): the economic run — the execution-bound provenance timeline
  // (recorded → authorized → settled; the public payload carries the
  // economicActionId ONLY — the real journalToExecutionLedger shape).
  seedExecution(world, {
    id: ECONOMIC_ID,
    status: "COMPLETED",
    description: "Pay the vendor invoice through the governed rail",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.economic-action-recorded",
      "execution.economic-action-authorized",
      "execution.economic-action-settled",
      "execution.pass",
    ],
  });
  {
    const evs = world.events.get(ECONOMIC_ID) ?? [];
    const payloads: Record<string, Record<string, unknown>> = {
      "execution.economic-action-recorded": { economicActionId: "ea-vendor-1" },
      "execution.economic-action-authorized": { economicActionId: "ea-vendor-1" },
      "execution.economic-action-settled": { economicActionId: "ea-vendor-1" },
    };
    evs.forEach((entry, index) => {
      const payload = payloads[entry.type];
      if (payload !== undefined) {
        evs[index] = { ...entry, payload };
      }
    });
  }
  // (as): the inspection run — a full planning decision record (the real
  // planner payload: task profile, policy inputs, capability resolution,
  // sufficiency, candidates, substrate selection, digest) on a batch run.
  seedExecution(world, {
    id: INSPECT_ID,
    status: "COMPLETED",
    description: "Batch the nightly statement exports",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "planning.decision-recorded",
      "execution.start",
      "execution.pass",
    ],
    route: {
      provider: "neutral-p",
      model: "neutral-m",
      strategyClass: "hybrid",
      modelCalls: 2,
    },
    cost: { totalMicroUsd: "1800000", currency: "usd" },
  });
  {
    const evs = world.events.get(INSPECT_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "planning.decision-recorded") {
        evs[index] = { ...entry, payload: INSPECT_DECISION_PAYLOAD };
      }
    });
  }
  // (at): the edge run — the same planning decision shape with an
  // embodied workload class selected on a hardware-isolated realtime
  // substrate (the boundary-sentence fixture).
  seedExecution(world, {
    id: EDGE_ID,
    status: "COMPLETED",
    description: "Inspect the assembly cell sensors",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "planning.decision-recorded",
      "execution.start",
      "execution.pass",
    ],
    verification: [check(EDGE_ID, 1, "PASS", 0.9)],
  });
  {
    const evs = world.events.get(EDGE_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "planning.decision-recorded") {
        evs[index] = {
          ...entry,
          payload: {
            ...INSPECT_DECISION_PAYLOAD,
            substrateSelection: {
              outcome: "selected",
              workloadClass: "embodied",
              admissible: [
                {
                  substrateId: "substrate-embodied-cell",
                  version: "3.1.0",
                  adapterRef: "adapter.embodied.cell",
                  resource: {
                    cpuMilliCores: 2000,
                    memoryMiB: 4096,
                    estimatedDurationMs: 400,
                    estimatedCostMicroUsd: "90000",
                  },
                  isolation: "hardware-isolated",
                  latencyClass: "realtime",
                },
              ],
              inadmissible: [],
              selected: { substrateId: "substrate-embodied-cell", version: "3.1.0" },
              rationale: "the only hardware-isolated realtime candidate",
            },
          },
        };
      }
    });
  }
  // (au): the REAL-WIRE prefixed long-running fixture — the same
  // checkpoint/resume vocabulary the platform's eventTypeFor emits
  // (proving the W037-era workload view lights against the actual wire).
  seedExecution(world, {
    id: PREFIXED_LONGRUN_ID,
    status: "RUNNING",
    description: "Index the archive incrementally",
    eventTypes: [
      "execution.created",
      "execution.authorize",
      "execution.start",
      "execution.checkpoint-recorded",
      "execution.resume-recorded",
    ],
    cost: { totalMicroUsd: "400000", currency: "usd" },
  });
  {
    const evs = world.events.get(PREFIXED_LONGRUN_ID) ?? [];
    evs.forEach((entry, index) => {
      if (entry.type === "execution.checkpoint-recorded") {
        evs[index] = {
          ...entry,
          payload: {
            checkpointSequence: 1,
            lastEventPosition: 1500,
            planId: "plan-prefixed-1",
            planRevision: 1,
            resourceClass: "standard",
          },
        };
      }
    });
  }

  const agent: AgentSummary = {
    id: AGENT_ID,
    slug: "support-triage",
    name: "Support Triage Agent",
    description: "Handles incoming tickets and escalates billing disputes.",
    status: "active",
    activeVersionId: "ver-2",
    activeVersion: "1.1.0",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
  };
  world.agentsByScope.set(APP_ID, [agent]);
  world.agentStatus.set(AGENT_ID, {
    agent,
    activeVersion: {
      id: "ver-2",
      agentId: AGENT_ID,
      version: "1.1.0",
      definitionDigest: "d2c4...",
      validationState: "validated",
      validationNotes: null,
      createdAt: "2026-09-09T00:00:00Z",
    },
    latestSelection: {
      selectionId: "sel-1",
      kind: "promotion",
      selectedVersionId: "ver-2",
      rollbackOf: null,
      selectedBy: "architect@example.test",
      selectedAt: "2026-09-09T00:00:00Z",
    },
    availableVersions: [
      {
        id: "ver-1",
        agentId: AGENT_ID,
        version: "1.0.0",
        definitionDigest: "a1b2...",
        validationState: "validated",
        validationNotes: null,
        createdAt: "2026-09-02T00:00:00Z",
      },
      {
        id: "ver-2",
        agentId: AGENT_ID,
        version: "1.1.0",
        definitionDigest: "d2c4...",
        validationState: "validated",
        validationNotes: null,
        createdAt: "2026-09-09T00:00:00Z",
      },
    ],
  });

  const { server } = createDashboard({
    apiUrl: "http://fake.local",
    token: "token",
    applicationId: APP_ID,
    port: 0,
    fetchImpl: createFakeApi(world),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
});

// ---------------------------------------------------------------------------
// Driving helpers (real fetch + a real cookie jar)
// ---------------------------------------------------------------------------

class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(response: Response): void {
    const raw =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie") ?? ""];
    for (const cookie of raw) {
      if (cookie.length === 0) {
        continue;
      }
      const pair = cookie.split(";")[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair !== undefined && separator > 0) {
        this.jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  valueOf(name: string): string | undefined {
    return this.jar.get(name);
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  clear(): void {
    this.jar.clear();
  }
}

async function get(path: string, jar?: CookieJar): Promise<Response> {
  const headers: Record<string, string> = {};
  if (jar !== undefined && jar.header().length > 0) {
    headers.cookie = jar.header();
  }
  const response = await fetch(`${base}${path}`, { redirect: "manual", headers });
  jar?.absorb(response);
  return response;
}

async function postForm(path: string, body: string, jar?: CookieJar): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (jar !== undefined && jar.header().length > 0) {
    headers.cookie = jar.header();
  }
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    body,
    headers,
    redirect: "manual",
  });
  jar?.absorb(response);
  return response;
}

async function html(response: Response): Promise<string> {
  return response.text();
}

/** Extract every hidden input of the FIRST POST form as a urlencoded body. */
function hiddenFieldsOf(pageHtml: string): string {
  const formMatch = /<form[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/.exec(pageHtml);
  expect(formMatch).not.toBeNull();
  const body = new URLSearchParams();
  for (const match of (formMatch?.[1] ?? "").matchAll(
    /<input type="hidden" name="([^"]*)" value="([^"]*)">/g,
  )) {
    body.set(
      match[1] ?? "",
      (match[2] ?? "").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'"),
    );
  }
  return body.toString();
}

// ---------------------------------------------------------------------------
// (a) The first-execution journey
// ---------------------------------------------------------------------------

describe("(a) the first-execution journey: Home → review → execute → result/evidence/activity", () => {
  test("Home renders the outcome-first entry with the suggested actions", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    const page = await html(response);
    expect(page).toContain("What would you like Zeck to accomplish?");
    expect(page).toContain('href="/build/agent"');
    expect(page).toContain('href="/build/workload"');
    expect(page).toContain('href="/runs"');
  });

  test("Home's form lands on the review step which POSTs to create", async () => {
    const home = await html(await get("/"));
    const key = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(home)?.[1] ?? "";
    expect(key.length).toBeGreaterThan(0);
    const review = await html(
      await get(
        `/build/execution?outcome=${encodeURIComponent("Analyze the files and summarize the findings")}` +
          `&applicationId=${APP_ID}&idempotencyKey=${encodeURIComponent(key)}`,
      ),
    );
    expect(review).toContain("Review the proposed execution");
    expect(review).toContain('method="post" action="/build/execution"');
    expect(review).toContain(`name="idempotencyKey" value="${key}"`);
  });

  test("POST /build/execution creates through the SDK and 303-redirects to the run", async () => {
    const key = "dash-journey-a";
    const body = new URLSearchParams({
      applicationId: APP_ID,
      environmentId: "",
      outcome: "Analyze the files and summarize the findings",
      spendLimitDollars: "10.50",
      quality: "0.8",
      latencySeconds: "120",
      userId: "",
      idempotencyKey: key,
    }).toString();
    const response = await postForm("/build/execution", body);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/runs\//);
    const createdId = location.replace("/runs/", "");
    // ONE durable world row, carrying the mapped request.
    expect(world.durableCreates).toBe(1);
    const execution = world.executions.get(createdId);
    expect(execution?.applicationId).toBe(APP_ID);
    const result = world.results.get(createdId);
    expect(result?.cost?.totalMicroUsd).toBeDefined();
  });

  test("the Result tab shows status, artifacts, the verification strip and next actions", async () => {
    const createdId =
      [...world.executions.keys()].find((id) => id.startsWith("00000000-0000-7000-8000-0001")) ??
      "";
    expect(createdId).not.toBe("");
    const page = await html(await get(`/runs/${createdId}`));
    expect(page).toContain("Analyze the files and summarize the findings");
    expect(page).toContain("status-COMPLETED");
    expect(page).toContain(
      `href="/assets/artifacts/${createdId}-artifact-1?executionId=${createdId}"`,
    );
    expect(page).toContain("2 of 2 checks passed");
    expect(page).toContain("$4.18");
    expect(page).toContain("?tab=evidence");
  });

  test("the Evidence tab renders the four separate trust axes + the verification table", async () => {
    const createdId =
      [...world.executions.keys()].find((id) => id.startsWith("00000000-0000-7000-8000-0001")) ??
      "";
    const page = await html(await get(`/runs/${createdId}?tab=evidence`));
    for (const axis of [
      "Provider success",
      "Execution success",
      "Quality success",
      "Policy success",
    ]) {
      expect(page).toContain(axis);
    }
    expect(page).toContain("Provider calls completed (4)");
    expect(page).toContain("Execution completed");
    expect(page).toContain("2 of 2 checks passed");
    expect(page).toContain("Admitted by policy");
    expect(page).toContain('<th scope="col">Criterion</th>');
    expect(page).toContain("criterion-1");
    expect(page).toContain("never merged into a single score");
  });

  test("the Activity tab renders the chronological timeline (and the advanced views)", async () => {
    const createdId =
      [...world.executions.keys()].find((id) => id.startsWith("00000000-0000-7000-8000-0001")) ??
      "";
    const page = await html(await get(`/runs/${createdId}?tab=activity`));
    const timelineStart = page.indexOf('<ol class="timeline">');
    expect(timelineStart).toBeGreaterThan(-1);
    const timeline = page.slice(timelineStart);
    expect(timeline.indexOf("Created")).toBeLessThan(timeline.indexOf("Authorized"));
    expect(timeline.indexOf("Authorized")).toBeLessThan(timeline.indexOf("Started"));
    expect(timeline.indexOf("Started")).toBeLessThan(timeline.indexOf("Completed"));
    const raw = await html(await get(`/runs/${createdId}?tab=activity&view=raw`));
    expect(raw).toContain("<pre class=");
  });

  test("the persistent WhyPanel carries every section honestly", async () => {
    const createdId =
      [...world.executions.keys()].find((id) => id.startsWith("00000000-0000-7000-8000-0001")) ??
      "";
    const page = await html(await get(`/runs/${createdId}`));
    expect(page).toContain("How Zeck did it");
    expect(page).toContain("Understood task");
    expect(page).toContain("capability detail is not exposed by this projection");
    expect(page).toContain("Compute");
    expect(page).toContain("Route — why was this route selected?");
    expect(page).toContain("4180000 micro-USD");
    // WORK-036 AC7: the panel answers the v2 §11 questions.
    expect(page).toContain("Why was that approach permitted?");
    expect(page).toContain("What did Zeck deliberately avoid?");
    expect(page).toContain("How was the result verified?");
    expect(page).toContain("Admitted by policy");
    // Route is secondary: the provider/model render only inside the
    // advanced disclosure nested in the panel.
    const routeStart = page.indexOf("Route detail (advanced)");
    expect(routeStart).toBeGreaterThan(-1);
    expect(page.slice(routeStart, routeStart + 400)).toContain("neutral-provider");
  });
});

// ---------------------------------------------------------------------------
// (b) The idempotent create
// ---------------------------------------------------------------------------

describe("(b) the idempotent create converges on ONE durable world row", () => {
  test("the same hidden key + the same payload posted twice ⇒ one row, same redirect", async () => {
    const before = world.durableCreates;
    const body = new URLSearchParams({
      applicationId: APP_ID,
      environmentId: "",
      outcome: "Idempotent journey outcome",
      spendLimitDollars: "",
      quality: "",
      latencySeconds: "",
      userId: "",
      idempotencyKey: "dash-idem-1",
    }).toString();
    const first = await postForm("/build/execution", body);
    const second = await postForm("/build/execution", body);
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(first.headers.get("location"));
    expect(world.durableCreates).toBe(before + 1);
  });

  test("the same key with a DIFFERENT payload ⇒ 409 surfaced honestly (422 re-render)", async () => {
    const first = new URLSearchParams({
      applicationId: APP_ID,
      outcome: "Fingerprint A",
      idempotencyKey: "dash-idem-2",
    }).toString();
    expect((await postForm("/build/execution", first)).status).toBe(303);
    const conflicting = new URLSearchParams({
      applicationId: APP_ID,
      outcome: "Fingerprint B",
      idempotencyKey: "dash-idem-2",
    }).toString();
    const response = await postForm("/build/execution", conflicting);
    expect(response.status).toBe(422);
    const page = await html(response);
    expect(page).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(page).toContain("the idempotency key was reused");
    expect(page).toContain('aria-live="polite"');
  });
});

// ---------------------------------------------------------------------------
// (c) The failed-execution journey
// ---------------------------------------------------------------------------

describe("(c) the failed-execution journey (recoverable failure, UX §8)", () => {
  test("FAILED renders the plain-language surface, the failure message and remediation", async () => {
    const page = await html(await get(`/runs/${FAILED_ID}`));
    expect(page).toContain("Zeck could not complete this execution");
    expect(page).toContain("the tool rejected the request after three attempts");
    expect(page).toContain("?tab=activity");
    expect(page).toContain("?tab=evidence");
    expect(page).toContain("Start a new attempt");
    expect(page).toContain(
      `outcome=${encodeURIComponent("Extract clauses from the scanned contract")}`,
    );
    expect(page).not.toContain("action=cancel");
  });
});

// ---------------------------------------------------------------------------
// (d) The waiting journey → the governed cancel flow
// ---------------------------------------------------------------------------

describe("(d) the waiting journey: WAITING_USER → decision → cancel → CANCELLED", () => {
  test("WAITING_USER renders the decision-needed surface as a normal governed state", async () => {
    const page = await html(await get(`/runs/${WAITING_ID}`));
    expect(page).toContain("Decision needed");
    expect(page).toContain("normal governed execution state, not an error");
    expect(page).toContain("does not expose a resolve command");
    expect(page).toContain("Approve the external side effect?");
    expect(page).toContain(`href="/runs/${WAITING_ID}?action=cancel"`);
  });

  test("the cancel confirmation states the consequence and posts the governed command", async () => {
    const page = await html(await get(`/runs/${WAITING_ID}?action=cancel`));
    expect(page).toContain("Cancel this execution?");
    // The WORK-035 universal consequence preview (v2 §26): consequence,
    // affected, cost, authorization, reversibility and idempotency BEFORE
    // the single confirm button (a governed POST).
    expect(page).toContain("Consequential action");
    expect(page).toContain("What will happen");
    expect(page).toContain("Who or what is affected");
    expect(page).toContain("Why it is allowed");
    expect(page).toContain("Can it be undone");
    expect(page).toContain("Approval required");
    expect(page).toContain("Idempotency");
    expect(page).toContain('method="post"');
    const body = hiddenFieldsOf(page);
    expect(body).toContain("idempotencyKey=");
    const response = await postForm(`/runs/${WAITING_ID}/cancel`, body);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/runs/${WAITING_ID}`);
    // The world transitioned through the fake governed authority.
    expect(world.executions.get(WAITING_ID)?.status).toBe("CANCELLED");
    const after = await html(await get(`/runs/${WAITING_ID}`));
    expect(after).toContain("status-CANCELLED");
    expect(after).toContain("Cancelled");
  });

  test("cancelling an already-terminal execution surfaces the 409 → redirect (no breakage)", async () => {
    const body = "idempotencyKey=dash-cancel-replay";
    const response = await postForm(`/runs/${WAITING_ID}/cancel`, body);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/runs/${WAITING_ID}`);
    expect(world.executions.get(WAITING_ID)?.status).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// (e) The agents journey
// ---------------------------------------------------------------------------

describe("(e) the agents journey (live reads)", () => {
  test("the inventory lists the agent with its status and active version", async () => {
    const page = await html(await get("/agents"));
    expect(page).toContain("Support Triage Agent");
    expect(page).toContain("support-triage");
    expect(page).toContain("1.1.0");
    expect(page).toContain(`href="/agents/${AGENT_ID}"`);
  });

  test("the detail shows the active version and the selection under the advanced disclosure", async () => {
    const page = await html(await get(`/agents/${AGENT_ID}`));
    expect(page).toContain("Support Triage Agent");
    expect(page).toContain("Handles incoming tickets and escalates billing disputes.");
    expect(page).toContain("1.1.0");
    const advanced = page.indexOf("Versions and selection history (advanced)");
    expect(advanced).toBeGreaterThan(-1);
    const disclosureBody = page.slice(advanced, advanced + 2000);
    expect(disclosureBody).toContain("1.0.0");
    expect(disclosureBody).toContain("promotion");
    expect(disclosureBody).toContain("architect@example.test");
  });
});

// ---------------------------------------------------------------------------
// (f) The command surface
// ---------------------------------------------------------------------------

describe("(f) the command/search surface (links only — the authorization path)", () => {
  test("a navigation word matches navigation entries", async () => {
    const page = await html(await get("/command?q=agents"));
    expect(page).toContain("Navigation");
    expect(page).toContain('href="/agents"');
  });

  test("a bare execution id proposes opening it directly", async () => {
    const page = await html(await get(`/command?q=${COMPLETED_ID}`));
    expect(page).toContain(`Open execution ${COMPLETED_ID}`);
    expect(page).toContain(`href="/runs/${COMPLETED_ID}"`);
  });

  test("an agent name matches the live agent inventory", async () => {
    const page = await html(await get("/command?q=triage"));
    expect(page).toContain("Support Triage Agent");
    expect(page).toContain(`href="/agents/${AGENT_ID}"`);
  });

  test("a proposed cancel is a LINK into the confirmation flow — no mutation is performed", async () => {
    const before = world.executions.get(RUNNING_ID)?.status;
    const page = await html(await get(`/command?q=cancel ${RUNNING_ID}`));
    expect(page).toContain(`href="/runs/${RUNNING_ID}?action=cancel"`);
    expect(page).toContain("nothing is cancelled from here");
    // Only links: no POST form anywhere on the command results page.
    expect(page).not.toContain('method="post"');
    // Nothing changed in the world.
    expect(world.executions.get(RUNNING_ID)?.status).toBe(before);
  });

  test("a no-match query renders the honest empty state with suggestions", async () => {
    const page = await html(await get("/command?q=qqqzzz"));
    expect(page).toContain("No matches");
    expect(page).toContain("Try a navigation word");
  });

  test("an empty query renders the command guide with examples", async () => {
    const page = await html(await get("/command"));
    expect(page).toContain("How it works");
    expect(page).toContain("Ctrl");
  });
});

// ---------------------------------------------------------------------------
// (g) The legacy routes still work (AC10)
// ---------------------------------------------------------------------------

describe("(g) the legacy routes are preserved (AC10)", () => {
  test("GET /executions/:id 303s to /runs/:id; GET /executions?id= 303s too", async () => {
    const direct = await get(`/executions/${COMPLETED_ID}`);
    expect(direct.status).toBe(303);
    expect(direct.headers.get("location")).toBe(`/runs/${COMPLETED_ID}`);
    const lookup = await get(`/executions?id=${COMPLETED_ID}`);
    expect(lookup.status).toBe(303);
    expect(lookup.headers.get("location")).toBe(`/runs/${COMPLETED_ID}`);
  });

  test("POST /executions/:id/cancel still performs the governed cancel (RUNNING → CANCELLED)", async () => {
    const response = await postForm(
      `/executions/${RUNNING_ID}/cancel`,
      "idempotencyKey=dash-legacy-cancel",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/runs/${RUNNING_ID}`);
    expect(world.executions.get(RUNNING_ID)?.status).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// (h) + (i) The honest error views
// ---------------------------------------------------------------------------

describe("(h) the 404 execution view", () => {
  test("an unknown execution renders the honest not-found view (never a stack trace)", async () => {
    const response = await get("/runs/00000000-0000-7000-8000-00000000dead");
    expect(response.status).toBe(404);
    const page = await html(response);
    expect(page).toContain("Execution not found");
    expect(page).toContain("it may belong to another application or not exist");
    expect(page).not.toMatch(/at \w+|node:internal|\.ts:\d+/);
  });
});

describe("(i) the 502 upstream-failure view (public error shape only)", () => {
  test("a fake-API 500 renders 502 with the public error body — no stack traces", async () => {
    world.failAgentList = true;
    try {
      const response = await get("/agents");
      expect(response.status).toBe(502);
      const page = await html(response);
      expect(page).toContain("Upstream failure");
      expect(page).toContain("simulated upstream failure");
      expect(page).toContain("PROVIDER_ERROR");
      expect(page).not.toMatch(/at \w+|node:internal|\.ts:\d+/);
    } finally {
      world.failAgentList = false;
    }
  });

  test("the transport failure view renders when the API is unreachable", async () => {
    const { server } = createDashboard({
      apiUrl: "http://127.0.0.1:1",
      token: "token",
      applicationId: APP_ID,
      port: 0,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const deadBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${deadBase}/agents`, { redirect: "manual" });
    expect(response.status).toBe(502);
    const page = await response.text();
    expect(page).toContain("could not reach the Zeck API");
    expect(page).toContain("no cached fallback");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// (j) The recents-cookie journey (navigation-only, live re-read)
// ---------------------------------------------------------------------------

describe("(j) the recents cookie: set → listed live → pruned on 404", () => {
  test("opening an execution sets the HttpOnly navigation cookie", async () => {
    const jar = new CookieJar();
    const response = await get(`/runs/${RECENTS_ID}`, jar);
    expect(response.status).toBe(200);
    const raw =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie().join("\n")
        : (response.headers.get("set-cookie") ?? "");
    expect(raw).toContain("zeck_recent_executions=");
    expect(raw).toContain(RECENTS_ID);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(jar.valueOf("zeck_recent_executions")).toContain(RECENTS_ID);
  });

  test("Home lists the recent execution LIVE (title + status from the API, not the cookie)", async () => {
    const jar = new CookieJar();
    await get(`/runs/${RECENTS_ID}`, jar);
    const home = await html(await get("/", jar));
    expect(home).toContain("Recent");
    expect(home).toContain("Summarize the support queue");
    expect(home).toContain("status-COMPLETED");
    expect(home).toContain("recently opened in this browser");
  });

  test("a 404'd id is pruned: Home re-sets the cookie without it and shows the honest empty state", async () => {
    world.executions.delete(RECENTS_ID);
    world.events.delete(RECENTS_ID);
    world.verification.delete(RECENTS_ID);
    world.results.delete(RECENTS_ID);
    try {
      // A browser whose navigation cookie still names the deleted id and a
      // live one — the cookie itself is only navigation state.
      const jar = new CookieJar();
      jar.set("zeck_recent_executions", `${RECENTS_ID},${COMPLETED_ID}`);
      const homeResponse = await get("/", jar);
      expect(homeResponse.status).toBe(200);
      const home = await html(homeResponse);
      // The deleted execution is NOT listed (its live read 404s → pruned)…
      expect(home).not.toContain("Summarize the support queue");
      // …while the live one still is.
      expect(home).toContain("Contract risk analysis");
      const raw =
        typeof homeResponse.headers.getSetCookie === "function"
          ? homeResponse.headers.getSetCookie().join("\n")
          : (homeResponse.headers.get("set-cookie") ?? "");
      expect(raw).not.toContain(RECENTS_ID);
    } finally {
      seedExecution(world, {
        id: RECENTS_ID,
        status: "COMPLETED",
        description: "Summarize the support queue",
        eventTypes: ["execution.created", "execution.authorize", "execution.pass"],
      });
    }
  });
});

// ---------------------------------------------------------------------------
// (k) The a11y frame on every page of the journey
// ---------------------------------------------------------------------------

describe("(k) every page: one h1, the landmarks, the skip link first", () => {
  const PAGES: readonly string[] = [
    "/",
    "/build",
    "/build/execution",
    "/build/agent",
    "/build/workload",
    "/build/deployment",
    "/deployments",
    "/deployments/00000000-0000-7000-8000-0000000000e1",
    "/runs",
    "/runs/active",
    "/runs/history",
    "/runs/scheduled",
    `/runs/${COMPLETED_ID}`,
    `/runs/${COMPLETED_ID}?tab=evidence`,
    `/runs/${COMPLETED_ID}?tab=activity`,
    // WORK-040: the inspection tab and every modality run page carry the
    // same complete accessible frame (one h1, landmarks, skip link).
    `/runs/${COMPLETED_ID}?tab=inspection`,
    `/runs/${COMPUTER_USE_ID}`,
    `/runs/${REALTIME_ID}`,
    `/runs/${MEDIA_ID}`,
    `/runs/${TRAINING_ID}`,
    `/runs/${ECONOMIC_ID}`,
    `/runs/${EDGE_ID}`,
    "/agents",
    `/agents/${AGENT_ID}`,
    "/assets/artifacts",
    "/assets/competences",
    "/assets/connections",
    "/improve/evaluations",
    "/improve/insights",
    "/improve/learning",
    "/admin/policies",
    "/admin/budgets",
    "/admin/team",
    "/admin/environments",
    "/admin/audit",
    "/command",
    "/command?q=agents",
  ];

  test("each page carries the complete accessible frame", async () => {
    for (const path of PAGES) {
      const page = await html(await get(path));
      expect((page.match(/<h1[^>]*>/g) ?? []).length, path).toBe(1);
      expect(page, path).toContain("<header");
      expect(page, path).toContain("<nav");
      expect(page, path).toContain("<main");
      expect(page, path).toContain("<footer");
      expect(page, path).toContain('role="search"');
      expect(page.indexOf('class="skip-link"'), path).toBeLessThan(page.indexOf("<header"));
      expect(page, path).toContain(">Skip to main content</a>");
      expect(page, path).toContain('<html lang="en"');
      expect(page, path).toContain("<title>");
    }
  });

  test("hostile query values are escaped in every echo (form values, search echo)", async () => {
    const hostile = '"><script>zeck("x")</script>&';
    const review = await html(
      await get(
        `/build/execution?outcome=${encodeURIComponent(hostile)}&applicationId=${encodeURIComponent(hostile)}`,
      ),
    );
    expect(review).not.toContain("<script>");
    const command = await html(await get(`/command?q=${encodeURIComponent(hostile)}`));
    expect(command).not.toContain("<script>");
    expect(command).not.toContain('zeck("x")');
  });
});

// ---------------------------------------------------------------------------
// (l) The application-scope reconciliation (WORK-034): the bound client
// sends the canonical header, the fake world enforces the requirement,
// and a different application scope cannot see this world's executions.
// ---------------------------------------------------------------------------

describe("(l) the application-scope reconciliation (WORK-034)", () => {
  test("the dashboard's scoped wire calls carry the bound application header", async () => {
    const before = world.scopedCalls.length;
    const page = await html(await get(`/runs/${COMPLETED_ID}?tab=evidence`));
    expect(page).toContain("Contract risk analysis");
    // The run view drove the scoped reads (detail + verification at
    // least) — every one carried the deployment's bound application.
    const fresh = world.scopedCalls.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    for (const call of fresh) {
      expect(call.application).toBe(APP_ID);
      expect(call.path).toMatch(/^\/(executions|agents)\//);
    }
    expect(fresh.some((call) => call.path === `/executions/${COMPLETED_ID}`)).toBe(true);
  });

  test("the fake world enforces the requirement: a headerless scoped read is 422", async () => {
    // A raw wire caller (NOT the dashboard) without the canonical header
    // is rejected with the real server's exact public error shape.
    const raw = createFakeApi(world);
    const response = await raw("http://fake.local/executions/whatever", {
      headers: { authorization: "Bearer token" },
    });
    expect(response.status).toBe(422);
    const body = JSON.parse(await response.text()) as PublicError;
    expect(body.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(body.message).toBe(
      "execution reads require the X-Zeck-Application header (the application whose scope authorizes the request)",
    );
  });

  test("a different application scope cannot see this world's executions (indistinguishable 404)", async () => {
    // A SECOND dashboard, bound to another application, sharing the SAME
    // world: the seeded execution belongs to APP_ID, so the other scope's
    // live read misses — the honest not-found view, never a tenant leak.
    const { server } = createDashboard({
      apiUrl: "http://fake.local",
      token: "token",
      applicationId: OTHER_APP_ID,
      port: 0,
      fetchImpl: createFakeApi(world),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const otherBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${otherBase}/runs/${COMPLETED_ID}`, { redirect: "manual" });
      expect(response.status).toBe(404);
      const page = await response.text();
      expect(page).toContain("Execution not found");
      expect(page).toContain("it may belong to another application or not exist");
      // Its agent inventory is honestly empty (that application has no
      // agents in this world) — an empty state, not an error.
      const agentsResponse = await fetch(`${otherBase}/agents`, { redirect: "manual" });
      expect(agentsResponse.status).toBe(200);
      const agentsPage = await agentsResponse.text();
      expect(agentsPage).not.toContain("Support Triage Agent");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("the governed cancel is scoped too: a cross-scope cancel cannot touch the execution", async () => {
    // A dedicated non-terminal execution (the shared world's RUNNING row
    // was already cancelled by the (g) legacy journey).
    const SCOPED_RUN_ID = "00000000-0000-7000-8000-0000000000c6";
    seedExecution(world, {
      id: SCOPED_RUN_ID,
      status: "RUNNING",
      description: "Rotate the access keys",
      eventTypes: ["execution.created", "execution.authorize", "execution.start"],
    });
    const { server } = createDashboard({
      apiUrl: "http://fake.local",
      token: "token",
      applicationId: OTHER_APP_ID,
      port: 0,
      fetchImpl: createFakeApi(world),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const otherBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${otherBase}/runs/${SCOPED_RUN_ID}/cancel`, {
        method: "POST",
        redirect: "manual",
      });
      expect(response.status).toBe(404);
      // The execution was NOT transitioned by the out-of-scope command.
      expect(world.executions.get(SCOPED_RUN_ID)?.status).toBe("RUNNING");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a scopeless dashboard cannot exist: the option is required and validated", () => {
    expect(() =>
      createDashboard({
        apiUrl: "http://fake.local",
        token: "token",
        applicationId: "",
        port: 0,
        fetchImpl: createFakeApi(world),
      }),
    ).toThrow(/DashboardOptions.applicationId/);
  });
});

describe("(m) the experience-mode journey (WORK-035: visibility only, never semantics)", () => {
  test("GET /mode sets the presentation cookie and redirects back", async () => {
    const response = await get("/mode?level=simple&returnTo=/runs");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/runs");
    expect(response.headers.get("set-cookie") ?? "").toContain("zeck_mode=simple");
  });

  test("simple mode renders the flat four destinations (no grouped tree, same routes)", async () => {
    const jar = new CookieJar();
    await get("/mode?level=simple&returnTo=/", jar);
    const page = await html(await get("/build", jar));
    expect(page).toContain('data-mode="simple"');
    expect(page).toContain(">Work</a>");
    expect(page).toContain(">Results</a>");
    expect(page).toContain(">Approvals</a>");
    expect(page).not.toContain("<summary>Build</summary>");
    // The create route (Work — New in professional) is still reachable:
    // modes never gate routes.
    const create = await html(await get("/build/execution", jar));
    expect(create).toContain("Describe the outcome first");
  });

  test("expert mode renders the expert-only inspection entries", async () => {
    const jar = new CookieJar();
    await get("/mode?level=expert&returnTo=/", jar);
    const page = await html(await get("/build", jar));
    expect(page).toContain(">Lineage</a>");
    expect(page).toContain(">Audit</a>");
  });
});

describe("(n) the command-dialog journey (the second front door dispatches through GET /command)", () => {
  test("every page carries the dialog: native dialog, GET /command form, link-only suggestions", async () => {
    const page = await html(await get("/"));
    expect(page).toContain('<dialog class="command-dialog" id="command-dialog"');
    expect(page).toContain('method="get" action="/command"');
    // Suggestions are links to real routes — the dispatch path itself.
    expect(page).toContain('href="/command?q=cancel"');
    expect(page).toContain(">Proposed action</span>");
    // No POST anywhere in the dialog.
    const dialog = page.slice(page.indexOf('id="command-dialog"'), page.indexOf("</dialog>"));
    expect(dialog).not.toContain('method="post"');
  });

  test("the dialog's dispatch contract: GET /command?q= executes the governed search (the (f) path)", async () => {
    const page = await html(await get("/command?q=support"));
    expect(page).toContain("Agent: Support Triage Agent");
  });

  test("the sheet primitive is wired on the execution surface (open trigger + native close form)", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(page).toContain('<dialog class="sheet" id="route-detail-sheet"');
    expect(page).toContain('data-sheet-open="route-detail-sheet"');
    expect(page).toContain('<form method="dialog" class="dialog-close">');
    expect(page).toContain("data-focus-return");
    // The inline disclosure carries the same facts without any script.
    expect(page).toContain('<details class="advanced">');
  });
});

describe("(o) the attention journey (WORK-035: consequential aggregation, honest about sources)", () => {
  test("the attention page aggregates the failed execution from the recents scope (live read)", async () => {
    const jar = new CookieJar();
    await get(`/runs/${FAILED_ID}`, jar);
    const page = await html(await get("/attention", jar));
    expect(page).toContain('aria-label="Needs your attention"');
    expect(page).toContain("attention-failed");
    expect(page).toContain("Zeck could not complete an execution");
    expect(page).toContain("1</span>");
    expect(page).toContain("failed execution");
  });

  test("the header indicator appears only when attention exists", async () => {
    const jar = new CookieJar();
    const clean = await html(await get("/attention", jar));
    // The CSS rule text appears on every page — assert on the RENDERED
    // indicator markup (class attribute), not the stylesheet.
    expect(clean).not.toContain('class="attention-indicator"');
    await get(`/runs/${FAILED_ID}`, jar);
    const withItem = await html(await get("/attention", jar));
    expect(withItem).toContain('class="attention-indicator"');
    expect(withItem).toContain('<span class="count">1</span>');
  });

  test("the attention page states honestly that approvals/recommendations are not exposed yet", async () => {
    const page = await html(await get("/attention"));
    expect(page).toContain("not yet exposed by the public API");
    expect(page).toContain("Approvals and improvement recommendations");
  });

  test("the trust IA routes render their honest unavailable states", async () => {
    const evidence = await html(await get("/trust/evidence"));
    expect(evidence).toContain("Evidence");
    expect(evidence).toContain("not yet exposed by the public API");
    const lineage = await html(await get("/trust/lineage"));
    expect(lineage).toContain("Lineage");
  });
});

// ---------------------------------------------------------------------------
// (p) the WORK-036 composer journey: Home → attachments → review envelope →
//     Run → the wire request carries inputArtifactRefs
// ---------------------------------------------------------------------------

describe("(p) the WORK-036 outcome-composer journey (attachments through the closed create contract)", () => {
  test("Home carries the secondary affordances: attachments live, competences/templates honest", async () => {
    const page = await html(await get("/"));
    expect(page).toContain("What would you like Zeck to accomplish?");
    expect(page).toContain("Attachments, competences and templates");
    expect(page).toContain('name="attachments"');
    expect(page).toContain("Saved competences");
    expect(page).toContain("not exposed by the public API yet");
    // No provider/model selection exists anywhere in the composer.
    expect(page).not.toMatch(/name="(provider|model|providerId|modelId)"/);
  });

  test("the review renders the proposed-approach envelope with Run as the primary action", async () => {
    const review = await html(
      await get(
        `/build/execution?outcome=${encodeURIComponent("Analyze the files and summarize the findings")}` +
          `&applicationId=${APP_ID}&attachments=${encodeURIComponent("art-9\nart-10")}` +
          `&spendLimitDollars=2.50&idempotencyKey=dash-journey-p`,
      ),
    );
    expect(review).toContain("Review the proposed execution");
    expect(review).toContain("Proposed approach");
    expect(review).toContain("Permission and risk envelope");
    expect(review).toContain("Proposed verification approach");
    expect(review).toContain(">Run</button>");
    expect(review).toContain("Input artifacts");
    expect(review).toContain("art-9 · art-10");
    // The declared limits, honestly framed — never platform estimates.
    expect(review).toContain("not platform estimates");
    // WORK-036 AC9 (amendment): the consequence/commitment block immediately
    // before Run — the five pre-commit facts through the WORK-035
    // confirmation primitive (no parallel confirmation pattern).
    expect(review).toContain("Run this work?");
    expect(review).toContain("What will happen");
    expect(review).toContain("Who or what is affected");
    expect(review).toContain("with 2 attached input artifacts read as inputs");
    expect(review).toContain("No pre-run estimate");
    expect(review).toContain("What it costs");
    expect(review).toContain(
      "Your declared spend limit ($2.50) is enforced as the request&#39;s cost constraint.",
    );
    expect(review).toContain("Why it is allowed");
    expect(review).toContain("Can it be undone");
    expect(review).toContain("cannot be undone through the public contract");
    expect(review).toContain("Approval required");
    expect(review).toContain("No user pre-approval is part of the public create contract");
    expect(review).toContain("Idempotency");
    expect(review).toContain("The idempotency key dash-journey-p is carried");
    // The block sits between the envelope and Run (DOM order).
    const envelopeAt = review.indexOf("Proposed approach");
    const commitmentAt = review.indexOf("Run this work?");
    const runAt = review.indexOf(">Run</button>");
    expect(commitmentAt).toBeGreaterThan(envelopeAt);
    expect(runAt).toBeGreaterThan(commitmentAt);
  });

  test("POST with attachments creates through the SDK with inputArtifactRefs on the wire", async () => {
    const key = "dash-journey-p-run";
    const body = new URLSearchParams({
      applicationId: APP_ID,
      environmentId: "",
      outcome: "Analyze the files and summarize the findings",
      attachments: "art-9\nart-10",
      spendLimitDollars: "",
      quality: "",
      latencySeconds: "",
      userId: "",
      idempotencyKey: key,
    }).toString();
    const response = await postForm("/build/execution", body);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    const createdId = location.replace("/runs/", "");
    expect(createdId).not.toBe("");
    // The durable world row's create fingerprint carries the artifact refs.
    const established = world.createIndex.get(key);
    expect(established).toBeDefined();
    const fingerprint = JSON.parse(established?.fingerprint ?? "{}") as Record<string, unknown>;
    expect(fingerprint.inputArtifactRefs).toEqual(["art-9", "art-10"]);
    // The Result view renders from the live row.
    const page = await html(await get(`/runs/${createdId}`));
    expect(page).toContain("Analyze the files and summarize the findings");
  });
});

// ---------------------------------------------------------------------------
// (q) the WORK-036 trust + failure-distinction journey: the header trust
//     strip (four separate facts) and the quality-failure notice
// ---------------------------------------------------------------------------

describe("(q) the WORK-036 trust-state and failure-distinction journey", () => {
  test("the execution header renders the four trust axes as separate facts", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(page).toContain('class="trust-strip"');
    const stripStart = page.indexOf('class="trust-strip"');
    const strip = page.slice(stripStart, page.indexOf("</ul>", stripStart));
    expect(strip.match(/<li>/g)?.length).toBe(4);
    for (const axis of [
      "Provider success",
      "Execution success",
      "Quality success",
      "Policy success",
    ]) {
      expect(page).toContain(axis);
    }
    expect(page).not.toMatch(/trust score|overall confidence/i);
  });

  test("a completed execution with a failed check renders the QUALITY-failure notice (not the execution-failure surface)", async () => {
    const page = await html(await get(`/runs/${QUALITY_ID}`));
    expect(page).toContain("The work completed, but 1 verification check failed");
    expect(page).toContain("quality failure");
    expect(page).toContain("different fact from an execution failure");
    expect(page).toContain("Review the evidence");
    expect(page).not.toContain("Zeck could not complete this execution");
  });

  test("a FAILED execution renders the EXECUTION-failure surface with the honest recoverability limitation", async () => {
    const page = await html(await get(`/runs/${FAILED_ID}`));
    expect(page).toContain("Zeck could not complete this execution");
    expect(page).toContain("execution failure");
    expect(page).toContain("the tool rejected the request after three attempts");
    // AC10 amendment: the limitation is explicit — no authoritative
    // recoverability/provider classification exists on this stream, and
    // the dashboard does not classify the recorded reason.
    expect(page).toContain(
      "no authoritative recoverability or provider/infrastructure classification",
    );
    expect(page).toContain("does not classify the recorded reason");
    // The rejected heuristic prose is gone.
    expect(page).not.toContain("When the recorded reason describes");
    expect(page).toContain("Start a new attempt");
    expect(page).not.toContain("The work completed, but");
  });

  test("a platform-recorded retryable fact is surfaced verbatim and makes the governed retry primary", async () => {
    const page = await html(await get(`/runs/${RETRYABLE_ID}`));
    expect(page).toContain("Recoverability (platform-recorded)");
    expect(page).toContain("recorded this failure as <strong>retryable</strong>");
    expect(page).toContain("failure class timeout");
    expect(page).toContain("A new attempt is the governed path");
    expect(page).toContain(
      'class="button-link" href="/build/execution?outcome=' +
        encodeURIComponent("Rebuild the search index"),
    );
    expect(page).toContain("distinct from a quality failure");
  });

  test("a platform-recorded not-retryable fact states the honest consequence (no blind-retry push)", async () => {
    const page = await html(await get(`/runs/${NONRETRY_ID}`));
    expect(page).toContain("recorded this failure as <strong>not retryable</strong>");
    expect(page).toContain("expected to fail the same way");
    expect(page).toContain("Refine the request before starting a new attempt");
    expect(page).not.toContain("A new attempt is the governed path");
    expect(page).not.toContain(
      "Recoverability (platform-recorded):</strong> the platform recorded this failure as <strong>retryable</strong>",
    );
  });

  test("the wait question renders with the consequence framing (the (d) companion)", async () => {
    // A fresh waiting row: the shared world's WAITING_ID was already
    // cancelled by the (d) journey.
    seedExecution(world, {
      id: WAITING2_ID,
      status: "WAITING_USER",
      description: "Draft the vendor renewal",
      eventTypes: [
        "execution.created",
        "execution.authorize",
        "execution.start",
        "execution.wait-user",
      ],
      lastEventPayload: { question: "Approve the external side effect?" },
    });
    const page = await html(await get(`/runs/${WAITING2_ID}`));
    expect(page).toContain("Approve the external side effect?");
    expect(page).toContain("What deciding means");
    expect(page).toContain("What cancelling means");
    expect(page).toContain("Return to your work");
  });
});

// ---------------------------------------------------------------------------
// (r) the WORK-036 activity journey: the timeline is the default; Graph,
//     Events and Raw are advanced views inside the disclosure
// ---------------------------------------------------------------------------

describe("(r) the WORK-036 activity-view journey (timeline default, advanced disclosure)", () => {
  test("the default Activity view renders the timeline FIRST with the advanced views inside the disclosure", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}?tab=activity`));
    const timeline = page.indexOf('<ol class="timeline">');
    const disclosure = page.indexOf("Advanced views: Graph, Events, Raw");
    expect(timeline).toBeGreaterThan(-1);
    expect(disclosure).toBeGreaterThan(timeline);
    // The advanced links + the honest graph absence live inside the
    // disclosure body, after its summary.
    const body = page.slice(disclosure);
    expect(body).toContain("The execution graph view is an expert surface");
    expect(body).toContain("view=events");
    expect(body).toContain("view=raw");
    // Nothing graph-shaped renders before the timeline (graph-first is
    // the rejected anti-pattern).
    expect(page.slice(0, timeline)).not.toContain("view=events");
  });

  test("the events and raw views are labeled advanced with a return-to-timeline link", async () => {
    const events = await html(await get(`/runs/${COMPLETED_ID}?tab=activity&view=events`));
    expect(events).toContain("Advanced view — raw events");
    expect(events).toContain("Return to the timeline");
    expect(events).toContain('<th scope="col">Event id</th>');
    const raw = await html(await get(`/runs/${COMPLETED_ID}?tab=activity&view=raw`));
    expect(raw).toContain("Advanced view — raw payloads");
    expect(raw).toContain("Return to the timeline");
    expect(raw).toContain("<pre class=");
  });
});

// ---------------------------------------------------------------------------
// WORK-037: the Build-experience journeys
//   (s) the workload creation journey: outcome-first form → proposal
//       (budget + the four-state completion preview) → the commitment
//       block (full consequence facts before Start) → POST → 303 → the
//       run page — with the wire request proven to carry the budget
//       constraint, the dataset refs and the task;
//   (t) the long-running workload view: the checkpoint/resume fixture
//       renders the section (progress, checkpoint recency, spend,
//       recovery state, the four-state distinction, no lease/heartbeat
//       mechanics) and an ordinary execution does NOT render it;
//   (u) the training-state distinction: the four states on the live run
//       page, the release row always the explicit absence;
//   (v) the deployment journeys: inventory/detail/proposal carry the
//       availability/execution distinction, no execution-status
//       vocabulary, and NO POST routes (operational controls are not
//       actionable — no governed route exists);
//   (w) the agent at-a-glance journey: the nine AC3 dimensions with the
//       honest absences, the version/selection disclosure, the
//       execution cross-link;
//   (x) the workload create authority: the same-key resubmit converges on
//       ONE execution (idempotency), and the created execution reads
//       through the bound application scope (tenancy).
// ---------------------------------------------------------------------------

describe("(s) the WORK-037 workload-creation journey (outcome-first, budget-visible, governed create)", () => {
  test("the form is purpose-first: the outcome field leads, no provider/model selection exists", async () => {
    const page = await html(await get("/build/workload"));
    expect(page).toContain("What should the workload do?");
    expect(page).toContain("Budget (dollars, optional)");
    expect(page).toContain("Dataset artifacts (optional)");
    expect(page.indexOf("wl-purpose")).toBeLessThan(page.indexOf("wl-budget"));
    // No provider/model/connection SELECTION fields exist anywhere (the
    // honest no-provider note is the only place those words appear).
    expect(page).not.toMatch(/name="(provider|model|connectionId|connection|agent|agentId|rail)"/i);
    expect(page).not.toMatch(/<select[^>]*name="(provider|model|connection)"/i);
  });

  test("the review step renders the proposal AND the full commitment block before Start", async () => {
    const review = await html(
      await get(
        `/build/workload?purpose=${encodeURIComponent(
          "Train a classifier on the ticket dataset",
        )}&applicationId=${APP_ID}&budgetDollars=50.25&datasets=${encodeURIComponent(
          "dataset-1\ndataset-2",
        )}&userId=user-9&idempotencyKey=dash-journey-s`,
      ),
    );
    expect(review).toContain("Review the proposed workload");
    // The proposal: budget, inputs, what this creates, the completion preview.
    expect(review).toContain("Proposed workload");
    expect(review).toContain("Declared budget: $50.25");
    expect(review).toContain("integer micro-USD cost constraint");
    expect(review).toContain("2 references sent on the create request");
    expect(review).toContain("Exactly one governed execution");
    expect(review).toContain("What completion will mean");
    for (const label of [
      "Compute complete",
      "Training complete",
      "Evaluation passed",
      "Release approved",
    ]) {
      expect(review).toContain(label);
    }
    // The commitment block: all the consequence facts before Start.
    expect(review).toContain("Start this workload?");
    expect(review).toContain("What will happen");
    expect(review).toContain("Who or what is affected");
    expect(review).toContain("What it costs");
    expect(review).toContain("Why it is allowed");
    expect(review).toContain("Can it be undone");
    expect(review).toContain("Approval required");
    expect(review).toContain("Idempotency");
    expect(review).toContain("dash-journey-s");
    expect(review).toContain('method="post" action="/build/workload"');
    expect(review).toContain(">Start this workload</button>");
    // Not now returns to editing with the key preserved.
    expect(review).toMatch(/href="\/build\/workload\?[^"]*edit=1[^"]*"/);
  });

  test("POST /build/workload creates through the governed create and 303-redirects to the run", async () => {
    world.createCalls.length = 0;
    const body = new URLSearchParams({
      applicationId: APP_ID,
      purpose: "Train a classifier on the ticket dataset",
      budgetDollars: "50.25",
      datasets: "dataset-1\ndataset-2",
      userId: "user-9",
      idempotencyKey: "dash-journey-s-create",
    }).toString();
    const response = await postForm("/build/workload", body);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/runs\//);
    // The wire request carried the workload facts through the ONE create
    // contract: the task, the budget constraint (integer micro-USD), the
    // dataset refs and the end-user attribution.
    expect(world.createCalls.length).toBe(1);
    const request = world.createCalls[0] as Record<string, unknown>;
    expect(request.applicationId).toBe(APP_ID);
    expect(request.task).toEqual({
      kind: "outcome",
      description: "Train a classifier on the ticket dataset",
    });
    expect(request.constraints).toEqual({ maxCostMicroUsd: "50250000" });
    expect(request.inputArtifactRefs).toEqual(["dataset-1", "dataset-2"]);
    expect(request.userId).toBe("user-9");
    // The run page renders for the created workload.
    const run = await html(await get(location));
    expect(run).toContain("Train a classifier on the ticket dataset");
  });

  test("an invalid form re-renders with per-field errors (422, never a silent drop)", async () => {
    const body = new URLSearchParams({
      applicationId: "",
      purpose: "",
      budgetDollars: "fifty",
      datasets: "dataset-1, BAD REF!;",
      idempotencyKey: "dash-journey-s-invalid",
    }).toString();
    const response = await postForm("/build/workload", body);
    expect(response.status).toBe(422);
    const page = await response.text();
    expect(page).toContain("The request could not be submitted");
    expect(page).toContain("The application id is required");
    expect(page).toContain("Describe what the workload should accomplish");
    expect(page).toContain("dollar amount");
    expect(page).toContain("one id per line");
  });
});

describe("(t) the WORK-037 long-running workload view (AC8: facts, never mechanics)", () => {
  test("the checkpoint/resume fixture renders the section with every fact", async () => {
    const page = await html(await get(`/runs/${LONGRUN_ID}`));
    expect(page).toContain("Long-running workload");
    expect(page).toContain("open the activity timeline");
    // Checkpoint recency: the platform's own typed facts.
    expect(page).toContain("Checkpoint 2 of 2 recorded");
    expect(page).toContain("position 9600");
    // Spend: the settled cost + the declared budget constraint.
    expect(page).toContain("Settled cost: $1.81");
    expect(page).toContain("budget constraint on the request is $50.00");
    // Recovery state: the recorded resume.
    expect(page).toContain("Recovered");
    expect(page).toContain("resume-recorded");
    // The lease/heartbeat mechanics note (never exposed).
    expect(page).toContain("lease and heartbeat mechanics are platform-internal");
    expect(page).not.toMatch(/worker epoch|lease epoch/i);
  });

  test("an ordinary execution does NOT render the long-running section", async () => {
    const page = await html(await get(`/runs/${RUNNING_ID}`));
    expect(page).not.toContain("Long-running workload");
    const completed = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(completed).not.toContain("Long-running workload");
  });

  test("the timeline still renders the checkpoint events as the progress view (default)", async () => {
    const page = await html(await get(`/runs/${LONGRUN_ID}?tab=activity`));
    expect(page).toContain("Checkpoint recorded");
  });
});

describe("(u) the WORK-037 training-state distinction (AC7: four states, never merged)", () => {
  test("the live run page renders the four distinct states with live facts and the release absence", async () => {
    const page = await html(await get(`/runs/${LONGRUN_ID}`));
    expect(page).toContain("Training, evaluation and release states");
    expect(page).toContain("Four distinct states");
    // Compute: the live status fact.
    expect(page).toContain("Not yet — the live status is RUNNING");
    // Training: the honest non-distinction (the running variant; the
    // apostrophe crosses the escape boundary as &#39;).
    expect(page).toContain("own workload states are not public");
    // Evaluation: the verification facts.
    expect(page).toContain("1 of 1 verification checks passed");
    // Release: the explicit absence, never a claim.
    expect(page).toContain("No release state exists on the public execution contract");
    expect(page).not.toMatch(/release approved[.:]?\s*(yes|true|granted)/i);
  });

  test("a COMPLETED workload with passing checks still never claims release approval", async () => {
    const page = await html(await get(`/runs/${LONGRUN_DONE_ID}`));
    // The completed variants: compute is the terminal fact, training is
    // the honest non-distinction, evaluation is the checks, release is
    // the absence.
    expect(page).toContain("the terminal state Completed");
    expect(page).toContain("does not separately distinguish");
    expect(page).toContain("1 of 1 verification checks passed");
    expect(page).toContain("never imply release approval");
    expect(page).not.toMatch(/release approved[.:]?\s*(yes|true|granted)/i);
  });

  test("an ordinary execution carries no training-state vocabulary (the distinction stays in the workload view)", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(page).not.toContain("Training, evaluation and release states");
    expect(page).not.toContain("Release approved");
    // The ordinary surface's own facts (status + verification) stay.
    expect(page).toContain("Completed");
  });
});

describe("(v) the WORK-037 deployment journeys (the availability/execution distinction)", () => {
  test("the inventory states the distinction and the honest absence, and links the live surfaces", async () => {
    const page = await html(await get("/deployments"));
    expect(page).toContain("A Deployment is persistent availability");
    expect(page).toContain("never an execution status");
    expect(page).toContain("not yet exposed by the public API");
    expect(page).toContain('href="/build/deployment"');
    expect(page).toContain('href="/runs"');
    expect(page).toContain('href="/agents"');
    // No execution-status badge vocabulary on the deployment surface.
    expect(page).not.toContain('class="badge status-');
  });

  test("the detail page carries the identifier-namespace distinction and the six-dimension glance grid", async () => {
    const page = await html(await get("/deployments/00000000-0000-7000-8000-0000000000e1"));
    expect(page).toContain("deployment 00000000-0000-7000-8000-0000000000e1");
    expect(page).toContain("different namespaces");
    expect(page).toContain("At a glance");
    for (const label of [
      "Availability",
      "Version",
      "Health",
      "Channels and endpoints",
      "Activity",
      "Operational controls",
    ]) {
      expect(page).toContain(label);
    }
    expect((page.match(/class="glance-cell"/g) ?? []).length).toBe(6);
    expect(page).not.toContain('class="badge status-');
    // The AC5 consequence vocabulary: governed path + no action buttons.
    expect(page).toContain("consequence preview before commitment");
    expect(page).toContain("no action buttons");
  });

  test("the proposal page is purpose-first and honestly unavailable (no create action)", async () => {
    const page = await html(
      await get(
        `/build/deployment?purpose=${encodeURIComponent("The support agent, always reachable")}`,
      ),
    );
    expect(page).toContain("What should stay available?");
    expect(page).toContain("The support agent, always reachable");
    expect(page).toContain("Proposed deployment design");
    expect(page).toContain("not yet exposed by the public API");
    // No POST form exists on the deployment proposal (no governed route).
    expect(page).not.toContain('method="post"');
  });

  test("no deployment command route exists (a direct POST is refused, zero wire mutations)", async () => {
    world.scopedCalls.length = 0;
    const before = world.durableCreates;
    for (const path of [
      "/deployments",
      "/deployments/00000000-0000-7000-8000-0000000000e1",
      "/build/deployment",
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        body: "x=1",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
      });
      expect([404, 405].includes(response.status), path).toBe(true);
    }
    expect(world.durableCreates).toBe(before);
  });
});

describe("(w) the WORK-037 agent at-a-glance journey (AC3 + AC9)", () => {
  test("the detail renders the nine dimensions: the live facts and the honest absences", async () => {
    const page = await html(await get(`/agents/${AGENT_ID}`));
    expect(page).toContain("At a glance");
    expect((page.match(/class="glance-cell"/g) ?? []).length).toBe(9);
    // The facts the agent projection carries.
    expect(page).toContain("Handles incoming tickets and escalates billing disputes.");
    expect(page).toContain("Active version validation state: validated");
    expect(page).toContain("1.1.0");
    // The honest absences.
    expect(page).toContain("no per-agent cost facts");
    expect(page).toContain("never represented as an execution status");
    expect(page).toContain("no capability facts");
    expect(page).toContain("no tool or integration facts");
    expect(page).toContain("no approval facts");
  });

  test("the versions and selection history stay under the advanced disclosure with the no-command note", async () => {
    const page = await html(await get(`/agents/${AGENT_ID}`));
    const advanced = page.indexOf("Versions and selection history (advanced)");
    expect(advanced).toBeGreaterThan(-1);
    const disclosureBody = page.slice(advanced, advanced + 2500);
    expect(disclosureBody).toContain("1.0.0");
    expect(disclosureBody).toContain("promotion");
    expect(disclosureBody).toContain("architect@example.test");
    expect(disclosureBody).toContain("no selection command is exposed");
  });

  test("the execution cross-link is honest (no agent attribution on the public execution contract)", async () => {
    const page = await html(await get(`/agents/${AGENT_ID}`));
    expect(page).toContain("Runs and evidence");
    expect(page).toContain("no agent attribution");
    expect(page).toContain("Look up an execution by id");
    expect(page).toContain('href="/runs"');
  });
});

describe("(x) the WORK-037 workload create authority (idempotency + tenancy)", () => {
  test("the same idempotency key with the same payload converges on ONE execution", async () => {
    world.createCalls.length = 0;
    const body = new URLSearchParams({
      applicationId: APP_ID,
      purpose: "Batch the nightly exports",
      budgetDollars: "5",
      datasets: "",
      userId: "",
      idempotencyKey: "dash-journey-x",
    }).toString();
    const first = await postForm("/build/workload", body);
    expect(first.status).toBe(303);
    const firstLocation = first.headers.get("location") ?? "";
    const second = await postForm("/build/workload", body);
    expect(second.status).toBe(303);
    const secondLocation = second.headers.get("location") ?? "";
    // ONE durable execution: both submits converge on the same run.
    expect(firstLocation).toBe(secondLocation);
    expect(world.createCalls.length).toBe(2);
    const created = world.executions.get(
      firstLocation.replaceAll("/runs/", "").replaceAll("/", ""),
    );
    expect(created).toBeDefined();
    expect(world.executions.size).toBeGreaterThanOrEqual(1);
  });

  test("the created workload's execution reads through the bound application scope (tenancy)", async () => {
    world.scopedCalls.length = 0;
    const body = new URLSearchParams({
      applicationId: APP_ID,
      purpose: "Scope-proof workload",
      budgetDollars: "",
      datasets: "",
      userId: "",
      idempotencyKey: "dash-journey-x-scope",
    }).toString();
    const created = await postForm("/build/workload", body);
    const location = created.headers.get("location") ?? "";
    expect(created.status).toBe(303);
    await html(await get(location));
    // Every scoped read carried the deployment's BOUND scope.
    const reads = world.scopedCalls.filter((call) =>
      call.path.startsWith(`/executions/${location.replaceAll("/runs/", "")}`),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const call of reads) {
      expect(call.application).toBe(APP_ID);
    }
    // A foreign scope in the URL query cannot widen the read scope.
    world.scopedCalls.length = 0;
    await html(await get(`${location}?applicationId=${OTHER_APP_ID}`));
    for (const call of world.scopedCalls) {
      expect(call.application).toBe(APP_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// (y) The WORK-038 trust-summary journey: the Result view's four-axis
//     summary (each fact linked to its evidence) + the four required
//     trust-state fixtures rendered as separate dimensions
// ---------------------------------------------------------------------------

describe("(y) the WORK-038 trust-summary journey (the result view's linked four-axis summary)", () => {
  test("the Result view renders the trust summary: four separate facts, each linked to its evidence location", async () => {
    const page = await html(await get(`/runs/${VERIFIED_ID}`));
    expect(page).toContain('class="trust-summary"');
    expect((page.match(/class="trust-summary-axis"/g) ?? []).length).toBe(4);
    expect((page.match(/class="axis-evidence"/g) ?? []).length).toBe(4);
    // Each axis's evidence link is contextual to THIS execution.
    expect(page).toContain(`href="/runs/${VERIFIED_ID}?tab=evidence#verification-results"`);
    expect(page).toContain(`href="/runs/${VERIFIED_ID}?tab=evidence#route-facts"`);
    expect(page).toContain(`href="/runs/${VERIFIED_ID}?tab=activity"`);
    // The never-a-score vocabulary and the verification chip.
    expect(page).toContain("never merged into a single score");
    expect(page).toContain("2/2 checks passed");
    expect(page).not.toMatch(/trust score|overall confidence|overall success/i);
  });

  test("provider-success/task-failure keeps the dimensions distinct on the rendered page", async () => {
    const page = await html(await get(`/runs/${PROVFAIL_ID}`));
    // The provider axis records the completed calls…
    expect(page).toContain("Provider calls completed (4)");
    // …while the execution axis records the task failure (never merged).
    expect(page).toContain("Zeck could not complete this execution");
    expect(page).not.toContain("Execution completed");
    expect(page).not.toMatch(/overall (success|trust)/i);
  });

  test("policy-blocked renders the denial as its own dimension (never a task failure)", async () => {
    const page = await html(await get(`/runs/${POLICY_ID}`));
    expect(page).toContain("Policy denied admission");
    expect(page).toContain("In progress (CREATED)");
    // A denial is not an execution failure — the failure surface stays absent.
    expect(page).not.toContain("Zeck could not complete this execution");
  });

  test("execution-success/quality-failure renders the two dimensions separately (the QUALITY fixture)", async () => {
    const page = await html(await get(`/runs/${QUALITY_ID}`));
    expect(page).toContain("Execution completed");
    expect(page).toContain("1 of 2 checks passed");
    expect(page).toContain("The work completed, but 1 verification check failed");
  });
});

// ---------------------------------------------------------------------------
// (z) The WORK-038 evidence-linking journey: every trust claim maps to
//     platform evidence — check refs LINK to public artifacts, opaque refs
//     stay verbatim (never a fabricated target)
// ---------------------------------------------------------------------------

describe("(z) the WORK-038 evidence-linking journey (claims linked to platform evidence)", () => {
  test("the Evidence view links each axis to its evidence and each check's refs to public artifacts", async () => {
    const page = await html(await get(`/runs/${VERIFIED_ID}?tab=evidence`));
    // The axes table carries the drill-down column.
    expect(page).toContain('<th scope="col">See the evidence</th>');
    expect(page).toContain(`href="/runs/${VERIFIED_ID}?tab=evidence#verification-results"`);
    // The check whose evidenceRefs point at the run's recorded output
    // artifact becomes a contextual artifact link…
    expect(page).toContain(`href="/assets/artifacts/${ARTIFACT_F2}?executionId=${VERIFIED_ID}"`);
    // …and the verification table keeps its criterion/status columns.
    expect(page).toContain('<th scope="col">Criterion</th>');
    expect(page).toContain("criterion-table-digest");
    expect(page).toContain("PASS");
    // The artifacts-referenced block lists the output with its digest.
    expect(page).toContain("digest-f2");
    // The contextual traversal strip renders (no index round-trip).
    expect(page).toContain('class="context-traversal"');
    expect(page).toContain(`href="/runs/${VERIFIED_ID}?tab=activity"`);
  });

  test("an OPAQUE evidence ref renders verbatim — never a fabricated link (AC9 discrimination)", async () => {
    const page = await html(await get(`/runs/${VERIFIED_ID}?tab=evidence`));
    expect(page).toContain("opaque-evidence-ref-9");
    // The ref with no public object carries the honest plain rendering —
    // a mutant linking it would emit an href for it.
    expect(page).not.toContain('href="/assets/artifacts/opaque-evidence-ref-9');
    expect(page).toContain("no public object with this id");
  });
});

// ---------------------------------------------------------------------------
// (aa) The WORK-038 artifact lineage journey: metadata, provenance, parent
//      lineage, verification references, usage references and the
//      contextual traversal — all from the platform's own records
// ---------------------------------------------------------------------------

describe("(aa) the WORK-038 artifact lineage journey (the AC5 artifact view)", () => {
  test("the artifact page renders the full AC5 set from public facts", async () => {
    // A browser that has opened the consumer run (so usage can resolve).
    const jar = new CookieJar();
    await get(`/runs/${CONSUMER_ID}`, jar);
    const page = await html(
      await get(`/assets/artifacts/${ARTIFACT_F2}?executionId=${VERIFIED_ID}`, jar),
    );
    // Metadata: exactly the public reference fields.
    expect(page).toContain("artifact id");
    expect(page).toContain("digest-f2");
    // Preview: the honest absence (never invented content).
    expect(page).toContain("Artifact content preview — not yet exposed by the public API");
    // Provenance: the producing execution and its outcome.
    expect(page).toContain("Provenance — the producing execution");
    expect(page).toContain("Verify the extracted clause table");
    // Source: what was asked.
    expect(page).toContain("Source — what was asked");
    // Parent lineage: the verified run's recorded inputs (f1 + the
    // hostile ref — escaped, never injected).
    expect(page).toContain("Parent lineage");
    expect(page).toContain(`href="/assets/artifacts/${ARTIFACT_F1}?executionId=${VERIFIED_ID}"`);
    expect(page).not.toContain("<script>ref-injection");
    expect(page).toContain("&lt;script&gt;ref-injection&lt;/script&gt;");
    // Verification references: the check whose evidence refs point here.
    expect(page).toContain("Verification references");
    expect(page).toContain("criterion-table-digest");
    expect(page).not.toContain("criterion-cross-check");
    // Usage references: the consumer run's recorded input.
    expect(page).toContain("Usage references");
    expect(page).toContain("Draft the renewal summary from the verified table");
    // Contextual traversal: result / evidence / activity of the producer.
    expect(page).toContain(`href="/runs/${VERIFIED_ID}?tab=evidence"`);
    expect(page).toContain(`href="/runs/${VERIFIED_ID}?tab=activity"`);
  });

  test("without the executionId param the producing execution resolves from the public recents scope", async () => {
    const jar = new CookieJar();
    // Opening the verified run first seeds the navigation cookie.
    await get(`/runs/${VERIFIED_ID}`, jar);
    const page = await html(await get(`/assets/artifacts/${ARTIFACT_F2}`, jar));
    expect(page).toContain("Provenance — the producing execution");
    expect(page).toContain("Verify the extracted clause table");
    expect(page).toContain("digest-f2");
  });

  test("an artifact with no resolvable producer renders the honest state (never a fabricated one)", async () => {
    const page = await html(await get("/assets/artifacts/00000000-0000-7000-8000-0000000000f9"));
    expect(page).toContain("Artifact detail — not yet exposed by the public API");
    expect(page).toContain("no artifact-by-id route");
    expect(page).not.toContain("Provenance — the producing execution");
  });

  test("a 404'd executionId param renders the honest error state (the scope-checked miss)", async () => {
    const page = await html(
      await get(
        `/assets/artifacts/${ARTIFACT_F2}?executionId=00000000-0000-7000-8000-0000000000e9`,
      ),
    );
    expect(page).toContain("The producing execution is not visible");
  });
});

// ---------------------------------------------------------------------------
// (ab) The WORK-038 Trust-surface journeys: the live per-execution
//      evidence and lineage pages and the evaluation status distinction
// ---------------------------------------------------------------------------

describe("(ab) the WORK-038 Trust surfaces journey (evidence, lineage, evaluations)", () => {
  test("/trust/evidence renders per-execution anchors with the verification chip and the honest cross-work note", async () => {
    const jar = new CookieJar();
    await get(`/runs/${VERIFIED_ID}`, jar);
    await get(`/runs/${COMPLETED_ID}`, jar);
    const page = await html(await get("/trust/evidence", jar));
    // Each recent run renders as an evidence anchor with its chip.
    expect(page).toContain(`href="/runs/${VERIFIED_ID}?tab=evidence"`);
    expect(page).toContain("2/2 checks passed");
    expect(page).toContain("Contract risk analysis");
    // The honest cross-work absence — never a fabricated search.
    expect(page).toContain("Cross-work evidence — not yet exposed by the public API");
    expect(page).toContain("no execution listing route");
  });

  test("/trust/evidence renders the honest empty state without recents", async () => {
    const page = await html(await get("/trust/evidence"));
    expect(page).toContain("No evidence to show yet");
    expect(page).toContain("Cross-work evidence — not yet exposed by the public API");
  });

  test("/trust/lineage renders the per-run chains (inputs → execution → outputs)", async () => {
    const jar = new CookieJar();
    await get(`/runs/${VERIFIED_ID}`, jar);
    const page = await html(await get("/trust/lineage", jar));
    expect(page).toContain('class="lineage-chains"');
    // The verified run's chain: its recorded inputs (f1) → the execution
    // → its outputs (f2), every link contextual.
    expect(page).toContain(`href="/assets/artifacts/${ARTIFACT_F1}?executionId=${VERIFIED_ID}"`);
    expect(page).toContain(`href="/runs/${VERIFIED_ID}"`);
    expect(page).toContain(`href="/assets/artifacts/${ARTIFACT_F2}?executionId=${VERIFIED_ID}"`);
    // The honest cross-work lineage absence.
    expect(page).toContain("Cross-work lineage graph — not yet exposed by the public API");
  });

  test("/improve/evaluations renders the four DISTINCT statuses and the advisory boundary", async () => {
    const page = await html(await get("/improve/evaluations"));
    expect(page).toContain("Observation");
    expect(page).toContain("Recommendation");
    expect(page).toContain("Validation");
    expect(page).toContain("Authoritative production status");
    expect((page.match(/class="distinction-state"/g) ?? []).length).toBe(4);
    // Learning stays advisory until validation and promotion are satisfied.
    expect(page).toContain("advisory only");
    expect(page).toContain("validation and promotion rules");
    // The honest authority absence + the live evidence pointer.
    expect(page).toContain("Evaluation records — not yet exposed by the public API");
    expect(page).toContain('href="/trust/evidence"');
  });
});

// ---------------------------------------------------------------------------
// (ac) The WORK-038 competence journey: discovery/detail structure as
//      explicit absences, use as a governed work action (never a local
//      execution shortcut)
// ---------------------------------------------------------------------------

describe("(ac) the WORK-038 competence journey (honest discovery, governed use)", () => {
  test("the competences page renders the discovery families as explicit absences — never fabricated rows", async () => {
    const page = await html(await get("/assets/competences"));
    for (const label of [
      "Task outcome",
      "Relevance",
      "Success rate",
      "Typical cost and time",
      "Verification status",
    ]) {
      expect(page).toContain(label);
    }
    expect((page.match(/class="glance-kind"/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(page).toContain("Competence discovery — not yet exposed by the public API");
    // No competence row is fabricated: no fake success-rate numbers.
    expect(page).not.toMatch(/\d+% success|success rate: \d/i);
  });

  test("the competence detail page renders the six detail families and the promotion honesty", async () => {
    const page = await html(await get("/assets/competences/competence-77"));
    for (const label of [
      "Provenance",
      "Procedures",
      "Validation population",
      "Uncertainty",
      "Compatibility",
      "Promotion state",
    ]) {
      expect(page).toContain(label);
    }
    expect(page).toContain("Competence detail — not yet exposed by the public API");
    // Promotion is the authority's own decision — never implied here.
    expect(page).toContain("implies a promotion");
  });

  test("using a competence is a governed work action — no picker, no local run, no shortcut", async () => {
    const discovery = await html(await get("/assets/competences"));
    expect(discovery).toContain("governed work action");
    expect(discovery).toContain('href="/build/execution"');
    expect(discovery).toContain("no competence-selection field");
    // No execution shortcut exists anywhere on the competence surfaces:
    // no POST form, no run button.
    expect(discovery).not.toMatch(/<form[^>]*method="post"/);
    const detail = await html(await get("/assets/competences/competence-77"));
    expect(detail).toContain("governed work action");
    expect(detail).not.toMatch(/<form[^>]*method="post"/);
    expect(detail).not.toMatch(/run (it|this) now|execute now/i);
  });
});

// ---------------------------------------------------------------------------
// (ad) The WORK-039 rules journey: the Controls families first, the live
//     blocked-runs list (each denial's recorded controlling rule), the
//     effective-policy composition as advanced detail
// ---------------------------------------------------------------------------

describe("(ad) the WORK-039 rules journey (controls first, live denial reasons)", () => {
  test("/admin/policies renders the seven control families — the live ones backed, the rest explicit absences", async () => {
    const page = await html(await get("/admin/policies"));
    expect(page).toContain("Rules and controls");
    expect(page).toContain("The controls");
    // AC1's exact family list, in order: quality, spend, latency, data,
    // tools, approvals, autonomy.
    expect(page).toContain("Quality");
    expect(page).toContain("Spend");
    expect(page).toContain("Latency");
    expect(page).toContain("Data");
    expect(page).toContain("Tools");
    expect(page).toContain("Approvals");
    expect(page).toContain("Autonomy");
    // The four live families carry the Platform-fact marker; the three
    // absent ones carry the Explicit-absence marker (never a fabricated
    // default).
    expect((page.match(/class="glance-kind">Platform fact/g) ?? []).length).toBeGreaterThanOrEqual(
      4,
    );
    expect(page).toContain("Explicit absence");
  });

  test("the blocked list renders the platform-recorded controlling rule per denied run (recents scope)", async () => {
    const jar = new CookieJar();
    await get(`/runs/${POLICY_ID}`, jar);
    const page = await html(await get("/admin/policies", jar));
    expect(page).toContain("Why work gets blocked");
    expect(page).toContain("the requested spend exceeds the effective policy ceiling");
    expect(page).toContain(`href="/runs/${POLICY_ID}"`);
    // The reason renders as the platform's own words — the composition
    // (set identity/version) stays honestly absent as advanced detail.
    expect(page).toContain("How the effective rules compose (advanced)");
  });

  test("without a denied run in the recents scope, no denial reason renders (nothing fabricated)", async () => {
    const page = await html(await get("/admin/policies"));
    expect(page).not.toContain("the requested spend exceeds the effective policy ceiling");
    expect(page).toContain("No run opened in this browser carries a recorded policy denial");
  });
});

// ---------------------------------------------------------------------------
// (ae) The WORK-039 spend journey: current usage, limits and major
//     categories in the simple view; reservations/settlement/ledger as
//     accounting detail; every figure a platform recording
// ---------------------------------------------------------------------------

describe("(ae) the WORK-039 spend journey (usage, limits, categories — never a second ledger)", () => {
  test("/admin/budgets renders the simple view: usage, limits and the provider categories", async () => {
    const jar = new CookieJar();
    await get(`/runs/${SPEND_ID}`, jar);
    const page = await html(await get("/admin/budgets", jar));
    expect(page).toContain('class="spend-summary"');
    expect(page).toContain("Current usage");
    expect(page).toContain("$6.25");
    expect(page).toContain("1 run with settled costs");
    expect(page).toContain("Limits");
    expect(page).toContain("1 run carries a declared spend limit");
    expect(page).toContain("Major categories");
    expect(page).toContain("neutral-p");
    // The per-run table: cost AND limit side by side, linked to the run.
    expect(page).toContain('class="kv spend-runs"');
    expect(page).toContain(`href="/runs/${SPEND_ID}"`);
    expect(page).toContain("$8.00");
  });

  test("a run without a settled cost renders the honest 'not settled yet' — never zero", async () => {
    const jar = new CookieJar();
    await get(`/runs/${POLICY_ID}`, jar);
    const page = await html(await get("/admin/budgets", jar));
    expect(page).toContain("not settled yet");
    expect(page).toContain("none declared");
  });

  test("the accounting detail is the advanced disclosure with the honest public absence", async () => {
    const page = await html(await get("/admin/budgets"));
    expect(page).toContain("Reservations, settlement and the ledger (accounting detail)");
    expect(page).toContain("Workspace budgets");
    expect(page).toContain("not yet exposed by the public API");
  });
});

// ---------------------------------------------------------------------------
// (af) The WORK-039 connections journey: the live routing facts, the
//     BYOK/secret-mediated story, no credential-shaped value anywhere
// ---------------------------------------------------------------------------

describe("(af) the WORK-039 connections journey (routing facts, never secrets)", () => {
  test("/assets/connections renders the routing facts from the runs opened in this browser", async () => {
    const jar = new CookieJar();
    await get(`/runs/${SPEND_ID}`, jar);
    const page = await html(await get("/assets/connections", jar));
    expect(page).toContain('class="connection-facts"');
    expect(page).toContain("Routing facts (live)");
    expect(page).toContain("neutral-p");
    expect(page).toContain("routed for 1 run opened in this browser");
    expect(page).toContain("bring your own keys");
    expect(page).toContain("Health");
  });

  test("the connections page states the secret-mediated boundary and renders no credential-shaped value", async () => {
    const page = await html(await get("/assets/connections"));
    expect(page).toContain("Connection inventory");
    expect(page).toContain("not yet exposed by the public API");
    expect(page).toContain("No credential, key or token is ever rendered");
    // No secret-shaped value ever appears (the hostile-ref discipline).
    expect(page).not.toMatch(/sk-[a-z0-9]{8,}|api[_-]?key\s*[:=]/i);
    expect(page).not.toMatch(/<form[^>]*method="post"/);
  });
});

// ---------------------------------------------------------------------------
// (ag) The WORK-039 environments journey: the environments recorded on
//     real runs (the default honestly), the authority absent
// ---------------------------------------------------------------------------

describe("(ag) the WORK-039 environments journey (recorded isolation boundaries)", () => {
  test("/admin/environments renders the recorded environments with run links (the default honestly)", async () => {
    const jar = new CookieJar();
    await get(`/runs/${ENV_ID}`, jar);
    await get(`/runs/${SPEND_ID}`, jar);
    const page = await html(await get("/admin/environments", jar));
    expect(page).toContain("env-staging");
    expect(page).toContain(`href="/runs/${ENV_ID}"`);
    expect(page).toContain("default");
    expect(page).toContain(`href="/runs/${SPEND_ID}"`);
    expect(page).toContain("Environment inventory and configuration");
    expect(page).toContain("not yet exposed by the public API");
  });

  test("without recents the page renders the honest empty scope note", async () => {
    const page = await html(await get("/admin/environments"));
    expect(page).toContain("No executions opened in this browser yet");
  });
});

// ---------------------------------------------------------------------------
// (ah) The WORK-039 team journey: safe operational intent — the live
//     approval queue, the membership absence
// ---------------------------------------------------------------------------

describe("(ah) the WORK-039 team journey (who decides what)", () => {
  test("/admin/team renders the live approval queue from the platform's waiting states", async () => {
    const jar = new CookieJar();
    await get(`/runs/${APPROVAL_ID}`, jar);
    const page = await html(await get("/admin/team", jar));
    expect(page).toContain("Who decides what");
    expect(page).toContain(`href="/runs/${APPROVAL_ID}"`);
    expect(page).toContain("a human review the governing policy required");
    expect(page).toContain("Members and roles");
    expect(page).toContain("not yet exposed by the public API");
  });

  test("no waiting runs render the honest empty queue (never a fabricated approver)", async () => {
    const page = await html(await get("/admin/team"));
    expect(page).toContain("No governed work is waiting for a decision right now");
  });
});

// ---------------------------------------------------------------------------
// (ai) The WORK-039 audit journey: the per-run governed-action ledgers
//     (the closest live record), the cross-work surface absent
// ---------------------------------------------------------------------------

describe("(ai) the WORK-039 audit journey (the governed-action record)", () => {
  test("/admin/audit renders the per-run event ledgers with the latest stage and the activity link", async () => {
    const jar = new CookieJar();
    await get(`/runs/${SPEND_ID}`, jar);
    const page = await html(await get("/admin/audit", jar));
    expect(page).toContain(`href="/runs/${SPEND_ID}?tab=activity"`);
    expect(page).toContain("4 recorded events");
    expect(page).toContain("Cross-work audit");
    expect(page).toContain("not yet exposed by the public API");
  });

  test("a policy-denied run's ledger includes the denial in its event count (the append-only record)", async () => {
    const jar = new CookieJar();
    await get(`/runs/${POLICY_ID}`, jar);
    const page = await html(await get("/admin/audit", jar));
    expect(page).toContain("2 recorded events");
  });
});

// ---------------------------------------------------------------------------
// (aj) The WORK-039 insights journey: the five recommendation families,
//     the three dispositions, the live evidence pointers
// ---------------------------------------------------------------------------

describe("(aj) the WORK-039 insights journey (the recommendation structure, honest ahead of facts)", () => {
  test("/improve/insights renders the five families as explicit absences — never fabricated rows", async () => {
    const page = await html(await get("/improve/insights"));
    expect(page).toContain("Observed evidence");
    expect(page).toContain("Expected impact");
    expect(page).toContain("Confidence");
    expect(page).toContain("Affected work");
    expect(page).toContain("Disposition");
    expect(page).toContain("not yet exposed by the public API");
  });

  test("the three dispositions render as distinct rows (advisory/review/applicable, never merged)", async () => {
    const page = await html(await get("/improve/insights"));
    expect(page).toContain("Advisory");
    expect(page).toContain("Review");
    expect(page).toContain("Applicable");
    expect(page).toContain("never a dashboard-side mutation");
  });

  test("the live evidence pointers link to the executions/evidence surfaces (IR4)", async () => {
    const page = await html(await get("/improve/insights"));
    expect(page).toContain('href="/trust/evidence"');
    expect(page).toContain('href="/improve/evaluations"');
    expect(page).toContain('href="/improve/learning"');
    // No apply mutation exists anywhere on the insights surface.
    expect(page).not.toMatch(/<form[^>]*method="post"/);
  });
});

// ---------------------------------------------------------------------------
// (ak) The WORK-039 learning journey: evidence / recommendation /
//     authoritative production — distinct, with the live selection record
// ---------------------------------------------------------------------------

describe("(ak) the WORK-039 learning journey (learning never authorizes)", () => {
  test("/improve/learning renders the three distinct stages with the never-authorizes boundary", async () => {
    const page = await html(await get("/improve/learning"));
    expect(page).toContain("Evidence");
    expect(page).toContain("Recommendation");
    expect(page).toContain("Authoritative production behavior");
    expect(page).toContain("Learning produces recommendations and evidence, never authorization");
  });

  test("the live production record renders the platform's own selection facts (promotion, who, when)", async () => {
    const page = await html(await get("/improve/learning"));
    expect(page).toContain("The live production record");
    expect(page).toContain("Support Triage Agent");
    expect(page).toContain("promoted by the platform's selection rules");
    expect(page).toContain("architect@example.test");
    expect(page).toContain(`href="/agents/${AGENT_ID}"`);
  });

  test("no apply mutation exists on the learning surface (the authority boundary is structural)", async () => {
    const page = await html(await get("/improve/learning"));
    expect(page).not.toMatch(/<form[^>]*method="post"/);
    expect(page).not.toMatch(/apply (this|now)|promote now/i);
  });
});

// ---------------------------------------------------------------------------
// (al) The WORK-039 blocked-run journey: the run page explains why the
//     action is blocked and which rule controls it (the recorded reason)
// ---------------------------------------------------------------------------

describe("(al) the WORK-039 blocked-run journey (why blocked, which rule)", () => {
  test("the policy-denied run page renders the blocked explanation with the platform's recorded reason", async () => {
    const page = await html(await get(`/runs/${POLICY_ID}`));
    expect(page).toContain('class="state state-blocked"');
    expect(page).toContain("Blocked by policy");
    expect(page).toContain("the requested spend exceeds the effective policy ceiling");
    expect(page).toContain("policy is the admission authority");
  });

  test("the whyPanel's permission answer carries the controlling rule verbatim", async () => {
    const page = await html(await get(`/runs/${POLICY_ID}`));
    expect(page).toContain("Why was that approach permitted?");
    expect(page).toContain("The controlling rule:");
    expect(page).toContain("never reworded");
  });

  test("a run with NO recorded denial renders no blocked explanation (the block never fabricates)", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(page).not.toContain("state state-blocked");
    expect(page).not.toContain("Blocked by policy");
  });
});

// ---------------------------------------------------------------------------
// (am) The WORK-039 create-refusal journey: a policy-boundary refusal at
//     admission renders the blocked vocabulary before any retry
// ---------------------------------------------------------------------------

describe("(am) the WORK-039 create-refusal journey (the governed create refused by policy)", () => {
  test("an over-ceiling spend limit is refused with the typed denial and the blocked explanation", async () => {
    const review = await html(
      await get(
        `/build/execution?outcome=${encodeURIComponent(
          "Transfer the funds to the vendor",
        )}&applicationId=${APP_ID}&spendLimitDollars=500`,
      ),
    );
    expect(review).toContain("Run this work?");
    const body = hiddenFieldsOf(review);
    const response = await postForm("/build/execution", body);
    expect(response.status).toBe(422);
    const page = await html(response);
    // The live region carries the typed code; the blocked explanation
    // renders the platform's message as the controlling rule.
    expect(page).toContain("The platform rejected this request");
    expect(page).toContain("POLICY_DENIED");
    expect(page).toContain('class="state state-blocked"');
    expect(page).toContain("the requested spend exceeds the effective policy ceiling");
    expect(page).toContain("Adjust the declared controls");
    // No execution was created (the refusal precedes any durable record).
    expect(world.createCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = world.createCalls[world.createCalls.length - 1];
    expect((lastCall?.constraints as Record<string, unknown>)?.maxCostMicroUsd).toBe("500000000");
  });

  test("adjusting the limit and resubmitting succeeds (the refusal never wedges the create)", async () => {
    const review = await html(
      await get(
        `/build/execution?outcome=${encodeURIComponent(
          "Transfer the funds to the vendor",
        )}&applicationId=${APP_ID}&spendLimitDollars=5`,
      ),
    );
    const body = hiddenFieldsOf(review);
    const response = await postForm("/build/execution", body);
    expect(response.status).toBe(303);
  });
});

// ---------------------------------------------------------------------------
// (an) The WORK-040 computer-use journey: the access/risk envelope and
//     the recorded session history on the run surface
// ---------------------------------------------------------------------------

describe("(an) the WORK-040 computer-use journey (the access/risk envelope)", () => {
  test("the run page renders the access modes, the isolation verdict and the session history", async () => {
    const page = await html(await get(`/runs/${COMPUTER_USE_ID}`));
    expect(page).toContain("Computer use");
    expect(page).toContain("deterministic");
    expect(page).toContain("browser");
    expect(page).toContain("desktop");
    expect(page).toContain("cu-session-1");
    expect(page).toContain("env-cu-9");
    expect(page).toContain("Filesystem and network constraints (advanced)");
    expect(page).toContain("Approval and risk before consequential interaction");
  });

  test("the recorded denial renders the platform's own reason verbatim", async () => {
    const page = await html(await get(`/runs/${COMPUTER_USE_ID}`));
    expect(page).toContain("POLICY_DENIED");
    expect(page).toContain("the requested desktop access exceeds the effective policy envelope");
  });

  test("the section renders NO computer-use action (read-only by construction)", async () => {
    const page = await html(await get(`/runs/${COMPUTER_USE_ID}`));
    expect(page).toContain("This section never issues a computer-use action");
    // No POST form exists inside ANY modality section (read-only by
    // construction — the shell's command dialog lives outside them).
    const sections = page.match(/<section class="modality-section"[\s\S]*?<\/section>/g) ?? [];
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section).not.toContain("<form");
    }
  });

  test("a run without computer-use events renders NO computer-use section", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(page).not.toContain("Computer use");
  });
});

// ---------------------------------------------------------------------------
// (ao) The WORK-040 realtime/messaging journey: the Deployment/Session/
//      Execution distinction and the live session provenance
// ---------------------------------------------------------------------------

describe("(ao) the WORK-040 realtime/messaging journey (the three-level distinction)", () => {
  test("the run page distinguishes Deployment, Session and Execution with the session provenance", async () => {
    const page = await html(await get(`/runs/${REALTIME_ID}`));
    expect(page).toContain("Realtime and messaging sessions");
    expect(page).toContain("Persistent availability");
    expect(page).toContain("Session provenance");
    expect(page).toContain("caller-support-77");
    expect(page).toContain("rail-realtime-voice-1");
    expect(page).toContain("realtime-turn");
    expect(page).toContain("planner outcome routed");
  });

  test("every session fact links back to the canonical run context (AC9)", async () => {
    const page = await html(await get(`/runs/${REALTIME_ID}`));
    expect(page).toContain(`href="/runs/${REALTIME_ID}"`);
    expect(page).toContain('href="/deployments"');
  });

  test("the deployments surface renders the three levels and the live session evidence", async () => {
    // Open the realtime run first so it lands in this browser's recents
    // (the shared jar carries the recents cookie to the deployments page).
    const jar = new CookieJar();
    await get(`/runs/${REALTIME_ID}`, jar);
    const page = await html(await get("/deployments", jar));
    expect(page).toContain("Availability and the governed work behind it");
    expect(page).toContain("Deployment");
    expect(page).toContain("Session");
    expect(page).toContain("Execution");
    expect(page).toContain(`href="/runs/${REALTIME_ID}"`);
  });

  test("the deployments surface renders the honest empty state without session evidence", async () => {
    const page = await html(await get("/deployments"));
    expect(page).toContain("No session evidence");
  });
});

// ---------------------------------------------------------------------------
// (ap) The WORK-040 media journey: asynchronous work, digest-only
//      lineage, verification and retry/cancel state
// ---------------------------------------------------------------------------

describe("(ap) the WORK-040 media journey (asynchronous media work)", () => {
  test("the run page renders the job lifecycle with the digest references", async () => {
    const page = await html(await get(`/runs/${MEDIA_ID}`));
    expect(page).toContain("Media generation");
    expect(page).toContain("job-submitted");
    expect(page).toContain("sha256-media-input-1");
    expect(page).toContain("sha256-media-output-1");
    expect(page).toContain("job-completed");
    expect(page).toContain("image");
  });

  test("the verification and retry/cancel state rides the run's own status and evidence", async () => {
    const page = await html(await get(`/runs/${MEDIA_ID}`));
    expect(page).toContain("verification results");
    expect(page).toContain("verified by the verification authority");
    expect(page).toContain("digest references only");
  });

  test("a run without media events renders NO media section", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(page).not.toContain("Media generation");
  });
});

// ---------------------------------------------------------------------------
// (aq) The WORK-040 training journey: resource selection, checkpoints as
//      advanced detail, the four-state distinction preserved
// ---------------------------------------------------------------------------

describe("(aq) the WORK-040 training journey (training/accelerator work)", () => {
  test("the run page renders the workload facts with the checkpoints as advanced detail", async () => {
    const page = await html(await get(`/runs/${TRAINING_ID}`));
    expect(page).toContain("Training / accelerator work");
    expect(page).toContain("training-workload-1");
    expect(page).toContain("fine-tune");
    expect(page).toContain("workload-completed");
    expect(page).toContain("Resource selection and checkpoints (advanced)");
    expect(page).toContain("sha256-metrics-ft-1");
    expect(page).toContain("$2.50");
  });

  test("the four states stay distinct — the release row stays the explicit absence", async () => {
    const page = await html(await get(`/runs/${TRAINING_ID}`));
    expect(page).toContain("never claims release");
    // The four-state distinction (the W037 long-running section) renders
    // the release row ONLY as the explicit absence — never a claim.
    const releaseRow = page.match(
      /<li>\s*<span class="distinction-state">Release approved[\s\S]*?<\/li>/,
    );
    expect(releaseRow).not.toBeNull();
    expect(releaseRow?.[0]).toContain("Explicit absence");
    expect(releaseRow?.[0]).not.toContain("Platform fact");
  });

  test("a run with only long-running checkpoints (no training vocabulary) renders NO training section", async () => {
    const page = await html(await get(`/runs/${LONGRUN_ID}`));
    expect(page).not.toContain("Training / accelerator work");
  });
});

// ---------------------------------------------------------------------------
// (ar) The WORK-040 economic journey: the four-axis separation and the
//      execution-bound provenance timeline (the envelope's honest absence)
// ---------------------------------------------------------------------------

describe("(ar) the WORK-040 economic journey (the four-axis separation)", () => {
  test("the run page renders the four separate axes and the provenance timeline", async () => {
    const page = await html(await get(`/runs/${ECONOMIC_ID}`));
    expect(page).toContain("Economic actions");
    expect(page).toContain("Bounded intent");
    expect(page).toContain("Authorization");
    expect(page).toContain("Settlement");
    expect(page).toContain("Resource / outcome verification");
    expect(page).toContain("ea-vendor-1");
    expect(page).toContain("recorded");
    expect(page).toContain("authorized");
    expect(page).toContain("settled");
  });

  test("the bounded envelope renders as its honest absence — no fabricated amount, recipient or expiration", async () => {
    const page = await html(await get(`/runs/${ECONOMIC_ID}`));
    expect(page).toContain("do not cross the public execution wire");
    expect(page).toContain("renders no economic action");
  });

  test("a run without economic events renders NO economic section", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(page).not.toContain("Economic actions");
  });
});

// ---------------------------------------------------------------------------
// (as) The WORK-040 inspection journey: the expert inspection tab
// ---------------------------------------------------------------------------

describe("(as) the WORK-040 inspection journey (the expert inspection tab)", () => {
  test("the tab nav carries the Inspection tab on every run page", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}`));
    expect(page).toContain(`href="/runs/${COMPLETED_ID}?tab=inspection"`);
    expect(page).toContain("Inspection");
  });

  test("a run with a recorded planning decision renders the full inspection view", async () => {
    const page = await html(await get(`/runs/${INSPECT_ID}?tab=inspection`));
    expect(page).toContain("Inspection");
    expect(page).toContain("strategy-deterministic-batch");
    expect(page).toContain("deterministic-first preference applied");
    expect(page).toContain("policy-set-7");
    expect(page).toContain("rev-42");
    expect(page).toContain("insufficient");
    expect(page).toContain("substrate-batch-1");
    expect(page).toContain("cost-above-ceiling");
    expect(page).toContain("sha256:decision-inspect-1");
    expect(page).toContain("policy-cost-ceiling");
    expect(page).toContain('href="/trust/lineage"');
    expect(page).toContain('href="/admin/audit"');
  });

  test("a run without a planning decision renders the honest absence — never a fabricated one", async () => {
    const page = await html(await get(`/runs/${COMPLETED_ID}?tab=inspection`));
    expect(page).toContain("No planning decision recorded");
    expect(page).not.toContain("strategy-deterministic-batch");
    expect(page).not.toContain("Selected approach");
  });

  test("the default flows are unchanged: the Result tab stays the landing view", async () => {
    const page = await html(await get(`/runs/${INSPECT_ID}`));
    expect(page).toContain("<h2>Result</h2>");
    expect(page).not.toContain("<h2>Inspection</h2>");
  });
});

// ---------------------------------------------------------------------------
// (at) The WORK-040 edge journey: the local safety boundary
// ---------------------------------------------------------------------------

describe("(at) the WORK-040 edge journey (the local safety boundary)", () => {
  test("the run page renders the boundary sentence and the workload-class evidence", async () => {
    const page = await html(await get(`/runs/${EDGE_ID}`));
    expect(page).toContain("Edge / embodied work");
    expect(page).toContain("embodied");
    expect(page).toContain("substrate-embodied-cell");
    expect(page).toContain("hardware-isolated");
    expect(page).toContain("Hard-real-time safety authority stays LOCAL");
    expect(page).toContain("No command, actuation or override exists on this page");
  });

  test("the current physical command and local safety state are honest absences", async () => {
    const page = await html(await get(`/runs/${EDGE_ID}`));
    expect(page).toContain("Current physical command");
    expect(page).toContain("does not cross the public wire");
    expect(page).toContain("Local safety state");
    expect(page).toContain("owned locally by the edge substrate");
  });

  test("a non-edge run renders NO edge section", async () => {
    const page = await html(await get(`/runs/${INSPECT_ID}`));
    expect(page).not.toContain("Edge / embodied work");
  });
});

// ---------------------------------------------------------------------------
// (au) The WORK-040 real-wire normalization journey: the platform's
//      prefixed step-event types light the long-running view
// ---------------------------------------------------------------------------

describe("(au) the WORK-040 real-wire normalization journey (prefixed step events)", () => {
  test("the prefixed checkpoint/resume events render the long-running workload section", async () => {
    const page = await html(await get(`/runs/${PREFIXED_LONGRUN_ID}`));
    expect(page).toContain("Long-running workload");
    expect(page).toContain("Checkpoint 1 of 1");
    expect(page).toContain("Recovered");
    expect(page).toContain("resume-recorded");
  });

  test("the activity timeline labels the prefixed step events with the platform's own vocabulary", async () => {
    const page = await html(await get(`/runs/${PREFIXED_LONGRUN_ID}?tab=activity`));
    expect(page).toContain("Checkpoint recorded");
    expect(page).toContain("Recovered (resume recorded)");
  });

  test("the unprefixed fixture vocabulary still lights the same view (one vocabulary)", async () => {
    const page = await html(await get(`/runs/${LONGRUN_ID}`));
    expect(page).toContain("Long-running workload");
    expect(page).toContain("Checkpoint 2 of 2");
  });
});

// ---------------------------------------------------------------------------
// (av) The WORK-040 correction journey (the Architect review of PR #72):
//      the deployments fail-closed discipline on the scoped events read —
//      ONLY the 404 absence renders as "no session facts"; every other
//      events-read failure is surfaced, never swallowed
// ---------------------------------------------------------------------------

describe("(av) the WORK-040 correction journey (the fail-closed deployments events read)", () => {
  test('an auth-class (403) events-read failure FAILS CLOSED — never a false "no session facts" success', async () => {
    // A browser whose recents cookie carries the realtime run; the
    // scoped events read for that run fails with 403 POLICY_DENIED
    // (the auth/policy class). The authoritative read FAILED — the
    // dashboard must surface it, not render a successful-looking
    // overview with the run silently missing from session evidence.
    const jar = new CookieJar();
    jar.set("zeck_recent_executions", REALTIME_ID);
    world.failEventList = { id: REALTIME_ID, status: 403 };
    try {
      const response = await get("/deployments", jar);
      expect(response.status).toBe(403);
      const page = await html(response);
      expect(page).toContain("Not authorized");
      expect(page).toContain("The governed API denied this view");
      // The false-success states never render: neither the overview
      // section nor the session-evidence empty state (which would mask
      // the failed read as "no session facts").
      expect(page).not.toContain("Availability and the governed work behind it");
      expect(page).not.toContain("No session evidence");
    } finally {
      world.failEventList = null;
    }
  });

  test("a transport-class (500) events-read failure FAILS CLOSED (the 502 upstream surface)", async () => {
    const jar = new CookieJar();
    jar.set("zeck_recent_executions", REALTIME_ID);
    world.failEventList = { id: REALTIME_ID, status: 500 };
    try {
      const response = await get("/deployments", jar);
      expect(response.status).toBe(502);
      const page = await html(response);
      expect(page).toContain("Upstream failure");
      expect(page).toContain("The Zeck API could not complete this view");
      expect(page).not.toContain("Availability and the governed work behind it");
      expect(page).not.toContain("No session evidence");
    } finally {
      world.failEventList = null;
    }
  });

  test("the normal 404 absence stays the HONEST absence — the page renders, the run contributes no session row", async () => {
    // The execution is live (its getExecution read succeeds — the recents
    // prune does not fire) but its event stream 404s: the 404 IS the
    // honest absence, so the overview renders normally and the empty
    // session state is TRUTHFUL (the authoritative read said 404).
    const eventsBackup = world.events.get(REALTIME_ID);
    world.events.delete(REALTIME_ID);
    try {
      const jar = new CookieJar();
      jar.set("zeck_recent_executions", REALTIME_ID);
      const response = await get("/deployments", jar);
      expect(response.status).toBe(200);
      const page = await html(response);
      expect(page).toContain("Availability and the governed work behind it");
      expect(page).toContain("No session evidence");
      expect(page).not.toContain("Not authorized");
      expect(page).not.toContain("Upstream failure");
    } finally {
      if (eventsBackup !== undefined) {
        world.events.set(REALTIME_ID, eventsBackup);
      }
    }
  });
});
