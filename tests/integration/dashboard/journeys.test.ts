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
}

function seedExecution(world: FakeWorld, input: SeedInput): Execution {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(input.status);
  const execution: Execution = {
    id: input.id,
    applicationId: APP_ID,
    environmentId: null,
    status: input.status,
    task: { kind: "outcome", description: input.description },
    constraints: null,
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
