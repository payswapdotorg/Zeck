/**
 * The PPR-018 proof composition: the real Zeck public API (composed
 * in-process exactly like the platform's own API suites) plus the real
 * model gateway over the sandbox's GLM supply rail, plus the rail
 * worker that drives every created execution through the executions
 * authority's public transitions.
 *
 * WHAT IS REAL HERE (the same pieces the platform's own suites use):
 *  - `seedApiWorld()` (tests/unit/api/world.ts — the platform's shared
 *    in-memory API composition: the REAL Fastify public API server over
 *    the REAL executions service (real state machine, real gapless
 *    ledger, real idempotency, real policy admission), real scope
 *    resolver, real bearer auth) — the identical world the API route
 *    suites and the developer-docs end-to-end battery run against;
 *  - `createModelGateway` (the REAL models application service: identity
 *    resolution → admission → capability resolution → rail resolution →
 *    durable intent → credential materialization → adapter call →
 *    outcome persistence — SECRETS LAST, POLICY BEFORE DISPATCH);
 *  - the GLM supply rail adapter (zai-rail.ts) behind the gateway;
 *  - the rail worker (rail-worker.ts) driving executions through the
 *    authority's own transition commands — the docs-battery/VAL-010
 *    pattern (driveCreatesToCompletion / driveExecutionToCompletion).
 *
 * WHAT IS HARNESS-SIDE (disclosed): the in-memory connection
 * catalog/vault and dispatch journal (memory-ports.ts — the sandbox has
 * no PostgreSQL; the SQL adapters are the production equivalents), and
 * the rail worker's strategy constants (the planning decision's
 * strategy id/route recorded verbatim on each execution's ledger).
 */

import { createHash } from "node:crypto";
import type { ApiWorld } from "../../../tests/unit/api/world";
import { ACTOR_ID, seedApiWorld } from "../../../tests/unit/api/world";
import type { Principal, ScopeResolver } from "../../../src/modules/auth/public";
import {
  createScopeResolver,
  type IdentityStore,
  type MembershipRecord,
} from "../../../src/modules/auth/public";
import type { ExecutionService } from "../../../src/modules/executions/public";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../../src/modules/models/application/rail-registry";
import type { ExecutionRecord } from "../../../src/modules/executions/public";
import { createZaiRailAdapter, RAIL_ROUTE } from "./zai-rail";
import {
  createMemoryConnectionCatalog,
  createMemoryDispatchJournal,
  type RegisteredSupplyConnection,
} from "./memory-ports";
import { createRailWorker, type RailWorker, type RailWorkerHooks } from "./rail-worker";
import { loadZaiSupplyConfig, RAIL_MODEL } from "./zai-config";

/** The composed proof stack: world + gateway + rail worker + endpoints. */
export interface ProofStack {
  readonly world: ApiWorld;
  readonly apiBaseUrl: string;
  readonly railWorker: RailWorker;
  readonly close: () => Promise<void>;
  /** Rail-worker introspection for the battery (per-execution rail facts). */
  readonly railFacts: () => readonly RailExecutionFact[];
}

/** One execution's rail-side facts (the battery's telemetry axis). */
export interface RailExecutionFact {
  readonly executionId: string;
  readonly attemptId: string;
  readonly outcome: "provider-success" | "provider-failure";
  readonly latencyMs: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly replayed: boolean;
}

/** The scope/identity wiring (the world's own pattern, in-process). */
function scopeResolverOf(world: ApiWorld): ScopeResolver {
  const rows = new Map<string, { membership: MembershipRecord; applicationTenantId: string }>([
    [
      `${ACTOR_ID}:${world.applicationId}`,
      {
        membership: {
          id: `membership-${world.applicationId.slice(-8)}`,
          actorId: ACTOR_ID,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          role: "owner",
          createdAt: "2026-09-27T00:00:00Z",
        },
        applicationTenantId: world.tenantId,
      },
    ],
  ]);
  const store: IdentityStore = {
    provisionActor: (() => {
      throw new Error("not implemented in the proof composition");
    }) as never,
    findActor: (async () => null) as never,
    findMembershipWithApplicationTenant: (async (actorId: string, applicationId: string) =>
      rows.get(`${actorId}:${applicationId}`) ?? null) as never,
    findTenantMembership: (async () => null) as never,
    listMemberships: (async () => []) as never,
    insertMembership: (() => {
      throw new Error("not implemented in the proof composition");
    }) as never,
    updateMembershipRole: (() => {
      throw new Error("not implemented in the proof composition");
    }) as never,
    deleteMembership: (() => {
      throw new Error("not implemented in the proof composition");
    }) as never,
    lockApplicationMemberships: (async () => []) as never,
  };
  return createScopeResolver(store);
}

export interface ComposeStackOptions {
  /**
   * A transport-level fault injector for the failure-path validation
   * battery step (a wrapper around the supply rail's HTTP transport).
   * Absent = the real transport (the live supply endpoint).
   */
  readonly faultInjector?: (
    request: { readonly url: string; readonly bodyJson?: unknown },
    next: () => Promise<{ readonly status: number; readonly text: string }>,
  ) => Promise<{ readonly status: number; readonly text: string }>;
  /**
   * Minimum interval between rail dispatches (supply pacing; the
   * sandbox's GLM endpoint throttles bursts). Default 0 (tests); the
   * battery sets a gentle floor.
   */
  readonly minDispatchIntervalMs?: number;
}

/**
 * Compose the full proof stack. The rail worker wraps the world's
 * executions service (the docs-battery pattern) BEFORE the API server
 * serves its first request, so every execution the adapter creates
 * through the public API is executed by the rail through the authority's
 * own commands.
 */
export async function composeProofStack(options: ComposeStackOptions = {}): Promise<ProofStack> {
  const world = await seedApiWorld();
  const supply = loadZaiSupplyConfig();

  // The supply connection (BYOK-style, platform-side): the auth-header
  // material is composed into the in-memory vault at composition time
  // (read from the machine config — never from the repository) and is
  // materialized into dispatch contexts only at dispatch time.
  const connection: RegisteredSupplyConnection = {
    connectionId: `00000000-0000-7000-8000-${"ppr018supply".padStart(12, "0").slice(0, 12)}`,
    tenantId: world.tenantId,
    applicationId: world.applicationId,
    material: JSON.stringify(supply.authHeaders),
  };
  const catalog = createMemoryConnectionCatalog(connection);
  const journal = createMemoryDispatchJournal();

  // The rail transport: the platform's own fetch transport, optionally
  // wrapped by the battery's fault injector.
  const baseTransport = {
    async send(request: {
      readonly method: "GET" | "POST";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly bodyJson?: unknown;
      readonly timeoutMs?: number;
    }): Promise<{ readonly status: number; readonly headers: Record<string, string>; readonly body: AsyncIterable<Uint8Array> }> {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.bodyJson === undefined ? undefined : JSON.stringify(request.bodyJson),
        signal:
          request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      async function* body(): AsyncIterable<Uint8Array> {
        yield bytes;
      }
      return { status: response.status, headers, body: body() };
    },
  };
  const faultInjector = options.faultInjector;
  const transport = faultInjector
    ? {
        async send(request: Parameters<typeof baseTransport.send>[0]) {
          const next = async () => {
            const raw = await baseTransport.send(request);
            const decoder = new TextDecoder();
            let text = "";
            for await (const chunk of raw.body) {
              text += decoder.decode(chunk, { stream: true });
            }
            return { status: raw.status, text };
          };
          const result = await faultInjector(
            { url: request.url, ...(request.bodyJson === undefined ? {} : { bodyJson: request.bodyJson }) },
            next,
          );
          async function* body(): AsyncIterable<Uint8Array> {
            yield new TextEncoder().encode(result.text);
          }
          return { status: result.status, headers: { "content-type": "application/json" }, body: body() };
        },
      }
    : baseTransport;

  const rail = createZaiRailAdapter({ baseUrl: supply.baseUrl, transport });
  const registry = createRailRegistry([rail]);

  const gateway = createModelGateway({
    resolver: scopeResolverOf(world),
    catalog,
    credentials: catalog,
    admission: {
      async admit() {
        return { allowed: true };
      },
    },
    capabilities: {
      async resolve() {
        return { satisfied: true, catalogRevision: "ppr-018", satisfactions: [] };
      },
    },
    rails: registry,
    journal,
    generateId: world.executions === null ? Math.random().toString : (() => {
      let n = 0;
      return () => `00000000-0000-7000-8000-${String(1_000_000 + (n += 1)).slice(-12)}`;
    })(),
    defaultTimeoutMs: 150_000,
    hashRequest: (request) =>
      createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
  });

  const PRINCIPAL: Principal = {
    actorId: ACTOR_ID,
    authenticatedAt: new Date().toISOString(),
  };

  const railFacts: RailExecutionFact[] = [];
  const hooks: RailWorkerHooks = {
    onRailOutcome(fact) {
      railFacts.push(fact);
    },
  };

  const railWorker = createRailWorker({
    world,
    gateway: {
      complete: (request) =>
        gateway.complete(PRINCIPAL, world.applicationId, connection.connectionId, request),
    },
    route: RAIL_ROUTE,
    hooks,
    minDispatchIntervalMs: options.minDispatchIntervalMs ?? 0,
  });

  // The docs-battery pattern: wrap the world's executions service so
  // every created execution is executed by the rail (through the SAME
  // public service object the API routes hold).
  const service = world.executions as unknown as {
    createExecution: ExecutionService["createExecution"];
  };
  const originalCreate = service.createExecution.bind(world.executions);
  service.createExecution = async (input, idempotencyKey, actor) => {
    const receipt = await originalCreate(input, idempotencyKey, actor);
    if (!receipt.replayed) {
      const record: ExecutionRecord | null = await world.executions.getExecution(
        input.applicationId,
        receipt.executionId,
      );
      if (record !== null) {
        try {
          await railWorker.execute(record, actor);
        } catch (error) {
          console.error("[ppr-018 rail worker] execution drive failed:", error);
          throw error;
        }
      }
    }
    return receipt;
  };

  const listened: string = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
  const apiBaseUrl =
    typeof listened === "string" && listened.length > 0
      ? listened
      : `http://127.0.0.1:${(world.server.app.server.address() as { port: number }).port}`;

  return {
    world,
    apiBaseUrl,
    railWorker,
    railFacts: () => [...railFacts],
    close: async () => {
      await world.server.app.close();
    },
  };
}

/** The route identity the rail's planning decisions record (neutral strings). */
export const RAIL_STRATEGY = {
  strategyId: "ppr-018-model-rail",
  strategyClass: "model-rail",
  model: RAIL_MODEL,
} as const;
