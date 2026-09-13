/**
 * The tenant-isolation application's deterministic fixtures (VAL-024,
 * AC2).
 *
 * Controlled fakes that replay the REAL platform boundary shapes —
 * every offline row is reproducible with zero network, zero
 * credentials and zero provider contact (the isolation probes need no
 * provider: the scope checks are pre-dispatch):
 *
 *   * the foreign-content markers — the SYNTHETIC canary material
 *     planted in the foreign tenant's execution task, metadata and
 *     ledger rows. Any cross-tenant data disclosure would surface the
 *     material mechanically; evidence carries the marker LABEL and
 *     digest only, never the material itself;
 *   * `createFakeApiWorld` — a fake public API over the SDK's injected
 *     transport seam replaying the REAL wire semantics: the
 *     carrier-creation flow, the scope-checked miss (404, another
 *     application's execution is indistinguishable from a missing
 *     one), the server-side scope derivation refusing a foreign
 *     application scope (403 AUTHORIZATION_DENIED — the header never
 *     authorizes by itself), and the create-path typed violations
 *     (403 TENANT_SCOPE_VIOLATION for another application's
 *     environment);
 *   * `createFakeIsolationWorld` — the fake platform surface (the
 *     executions-service seam, the wire seam and the SQL row-count
 *     seam) replaying the REAL locked-row semantics: the
 *     application-scoped lock returns no row for a foreign execution
 *     (TENANT_SCOPE_VIOLATION), the locked row's tenant wins over a
 *     tenant-mismatched command (TENANT_SCOPE_VIOLATION), reads are
 *     scope-checked misses (null / zero rows) and every denied probe
 *     writes nothing (the arbitration insert rolls back — the
 *     row-count invariants read the fake world's own write ledger).
 *
 * Every mutation option is a DELIBERATELY WEAKENED stand-in for the
 * discrimination tests (AC6): a fake that admits a forged scope, leaks
 * foreign reads, ignores the tenant check or writes on denial — each
 * mutation must FAIL the probe assertions, proving they are
 * load-bearing.
 */

import {
  type ForeignContentMarker,
  type IsolationCountSnapshotter,
  type IsolationExecutionsSurface,
  type IsolationWireSurface,
  isolationDigestOf,
} from "../../platform/tenant-isolation";

// ---------------------------------------------------------------------------
// The synthetic foreign-content markers (never real content)
// ---------------------------------------------------------------------------

/** The foreign tenant's task-content canary (synthetic, planted). */
export const FOREIGN_TASK_CANARY = "TENANT-B-CONTENT-CANARY-VAL024-8841";
/** The foreign tenant's metadata classification marker (synthetic, planted). */
export const FOREIGN_METADATA_MARKER = "TENANT-B-CLASSIFICATION-VAL024-7723";
/** The foreign tenant's ledger-event marker (synthetic, planted). */
export const FOREIGN_EVENT_MARKER = "TENANT-B-EVENT-MARKER-VAL024-6617";

const markerOf = (label: string, material: string): ForeignContentMarker => ({
  label,
  material,
  digest: isolationDigestOf(material),
});

/** The planted foreign-content markers the mechanical scan hunts. */
export const FOREIGN_CONTENT_MARKERS: readonly ForeignContentMarker[] = [
  markerOf("foreign-task-canary", FOREIGN_TASK_CANARY),
  markerOf("foreign-metadata-marker", FOREIGN_METADATA_MARKER),
  markerOf("foreign-event-marker", FOREIGN_EVENT_MARKER),
];

// ---------------------------------------------------------------------------
// The fixed synthetic world identities (deterministic, never real)
// ---------------------------------------------------------------------------

export const OWN_APPLICATION_ID = "11111111-1111-7111-8111-111111111111";
export const OWN_TENANT_ID = "22222222-2222-7222-8222-222222222222";
export const OWN_ACTOR_ID = "33333333-3333-7333-8333-333333333333";
export const FOREIGN_APPLICATION_ID = "44444444-4444-7444-8444-444444444444";
export const FOREIGN_TENANT_ID = "55555555-5555-7555-8555-555555555555";
export const FOREIGN_ACTOR_ID = "66666666-6666-7666-8666-666666666666";
export const FOREIGN_ENVIRONMENT_ID = "77777777-7777-7777-8777-777777777777";
export const FOREIGN_EXECUTION_ID = "88888888-8888-7888-8888-888888888888";

/** The foreign-world reference bundle over the fixed identities. */
export function fixedForeignRefs(): {
  readonly foreignApplicationId: string;
  readonly foreignTenantId: string;
  readonly foreignActorId: string;
  readonly foreignExecutionId: string;
  readonly foreignEnvironmentId: string;
  readonly contentMarkers: readonly ForeignContentMarker[];
} {
  return {
    foreignApplicationId: FOREIGN_APPLICATION_ID,
    foreignTenantId: FOREIGN_TENANT_ID,
    foreignActorId: FOREIGN_ACTOR_ID,
    foreignExecutionId: FOREIGN_EXECUTION_ID,
    foreignEnvironmentId: FOREIGN_ENVIRONMENT_ID,
    contentMarkers: FOREIGN_CONTENT_MARKERS,
  };
}

// ---------------------------------------------------------------------------
// The fake public API world (the SDK's injected transport seam)
// ---------------------------------------------------------------------------

/**
 * The fake public API world: replays the REAL wire semantics over the
 * SDK's injected transport. The carrier flow behaves like the real API
 * (create → receipt, poll → terminal, results → the packaged outcome);
 * every cross-tenant access attempt gets the REAL wire boundary: the
 * scope-checked miss (404 CAPABILITY_UNAVAILABLE — never data), the
 * refused forged scope (403 AUTHORIZATION_DENIED) and the create-path
 * typed violation (403 TENANT_SCOPE_VIOLATION).
 */
export function createFakeApiWorld(options?: {
  /** Discrimination mutation: the foreign read LEAKS the foreign execution. */
  readonly leakForeignReads?: boolean;
  /** Discrimination mutation: the forged scope is ADMITTED (200 + data). */
  readonly admitForgedScope?: boolean;
  /** Discrimination mutation: the foreign-environment create is ADMITTED. */
  readonly admitForeignEnvironment?: boolean;
  /** Discrimination mutation: the foreign-application create is ADMITTED (id confusion). */
  readonly admitForeignApplicationCreate?: boolean;
  /** The carrier's terminal (default COMPLETED; FAILED discriminates the app). */
  readonly carrierTerminal?: "COMPLETED" | "FAILED";
  /** The carrier's verification statuses (FAIL discriminates the app). */
  readonly carrierVerification?: "PASS" | "FAIL";
}): {
  readonly transport: (input: unknown, init?: unknown) => Promise<Response>;
  readonly state: {
    readonly executionsCreated: number;
    readonly carriers: readonly string[];
  };
} {
  const mutations = {
    leakForeignReads: options?.leakForeignReads ?? false,
    admitForgedScope: options?.admitForgedScope ?? false,
    admitForeignEnvironment: options?.admitForeignEnvironment ?? false,
    admitForeignApplicationCreate: options?.admitForeignApplicationCreate ?? false,
  };
  const carrierTerminal = options?.carrierTerminal ?? "COMPLETED";
  const carrierVerification = options?.carrierVerification ?? "PASS";
  const carriers = new Map<string, { status: string }>();
  const state = { executionsCreated: 0, carriers: [] as string[] };
  let sequence = 0;

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const foreignExecutionBody = (): Record<string, unknown> => ({
    id: FOREIGN_EXECUTION_ID,
    applicationId: FOREIGN_APPLICATION_ID,
    environmentId: null,
    status: "CREATED",
    task: { kind: "foreign-workload", input: FOREIGN_TASK_CANARY },
    constraints: null,
    metadata: { classification: FOREIGN_METADATA_MARKER },
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
    terminalAt: null,
  });

  const transport = async (input: unknown, init?: unknown): Promise<Response> => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    const headers = ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
    const applicationScope = headers["x-zeck-application"] ?? "";
    const body =
      method === "POST" && typeof (init as RequestInit | undefined)?.body === "string"
        ? (JSON.parse((init as RequestInit).body as string) as Record<string, unknown>)
        : {};

    // POST /executions — the create path (the body carries the applicationId).
    if (url.endsWith("/executions") && method === "POST") {
      const applicationId = String(body.applicationId ?? "");
      const environmentId =
        body.environmentId === undefined ? undefined : String(body.environmentId);
      if (applicationId === FOREIGN_APPLICATION_ID) {
        if (mutations.admitForeignApplicationCreate) {
          // The mutation: the confused application-id create is
          // admitted (the server-side scope derivation removed).
          sequence += 1;
          const id = `confused-${sequence}`;
          carriers.set(id, { status: "RUNNING" });
          state.executionsCreated += 1;
          state.carriers.push(id);
          return jsonResponse(201, {
            executionId: id,
            applicationId: FOREIGN_APPLICATION_ID,
            status: "RUNNING",
            createdAt: new Date(1_000).toISOString(),
            replayed: false,
            lastEventSequence: 1,
          });
        }
        // The server-side scope derivation: the actor holds no membership
        // for the foreign application — AUTHORIZATION_DENIED, before any
        // durable write (the REAL resolver semantics).
        return jsonResponse(403, {
          code: "AUTHORIZATION_DENIED",
          message: "actor holds no membership for this application",
          retryable: false,
        });
      }
      if (environmentId !== undefined && environmentId !== "") {
        if (environmentId === FOREIGN_ENVIRONMENT_ID && !mutations.admitForeignEnvironment) {
          // The REAL typed violation through the public path: the
          // environment does not belong to the target application.
          return jsonResponse(403, {
            code: "TENANT_SCOPE_VIOLATION",
            message: "environment does not belong to the target application",
            retryable: false,
          });
        }
      }
      sequence += 1;
      const id = `carrier-${sequence}`;
      carriers.set(id, { status: "RUNNING" });
      state.executionsCreated += 1;
      state.carriers.push(id);
      return jsonResponse(201, {
        executionId: id,
        applicationId,
        status: "RUNNING",
        createdAt: new Date(1_000).toISOString(),
        replayed: false,
        lastEventSequence: 1,
      });
    }

    // /executions/:id[/cancel|/results|/events|/verification]
    const match = url.match(/\/executions\/([^/]+)(\/[a-z]+)?$/);
    if (match !== null) {
      const executionId = match[1] ?? "";
      const suffix = match[2] ?? "";

      // The forged application scope: the header names the FOREIGN
      // application — the server-side resolver finds no membership.
      if (applicationScope === FOREIGN_APPLICATION_ID) {
        if (mutations.admitForgedScope) {
          return jsonResponse(200, foreignExecutionBody());
        }
        return jsonResponse(403, {
          code: "AUTHORIZATION_DENIED",
          message: "actor holds no membership for this application",
          retryable: false,
        });
      }

      // The foreign execution through the OWN scope: the scope-checked
      // miss — another application's execution is indistinguishable
      // from a missing one (404, never data).
      if (executionId === FOREIGN_EXECUTION_ID && !carriers.has(executionId)) {
        if (mutations.leakForeignReads) {
          if (suffix === "") {
            return jsonResponse(200, foreignExecutionBody());
          }
          if (suffix === "/results") {
            return jsonResponse(200, {
              executionId: FOREIGN_EXECUTION_ID,
              status: "CREATED",
              route: {
                provider: "foreign-provider",
                model: "foreign-model",
                strategyClass: "foreign-workload",
                modelCalls: 1,
              },
              cost: { totalMicroUsd: "4242", currency: "usd" },
              usage: { inputTokens: 88, outputTokens: 41 },
              outputArtifacts: [],
              verification: [
                {
                  id: "foreign-v1",
                  executionId: FOREIGN_EXECUTION_ID,
                  criterionId: "foreign-criterion",
                  strategy: "deterministic",
                  status: "PASS",
                  recordedBy: "foreign-platform",
                },
              ],
              warnings: [],
              terminalAt: null,
            });
          }
          if (suffix === "/events") {
            return jsonResponse(200, [
              { eventId: "foreign-event-1", payload: { marker: FOREIGN_EVENT_MARKER } },
            ]);
          }
          if (suffix === "/verification") {
            return jsonResponse(200, [
              { criterionId: "foreign-criterion", status: "PASS", recordedBy: "foreign-platform" },
            ]);
          }
        }
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }

      const carrier = carriers.get(executionId);
      if (carrier === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      if (method === "GET" && suffix === "") {
        carrier.status = carrierTerminal;
        return jsonResponse(200, {
          id: executionId,
          applicationId: OWN_APPLICATION_ID,
          environmentId: null,
          status: carrierTerminal,
          task: { kind: "isolation-probe", scenario: "control" },
          constraints: null,
          metadata: {},
          createdAt: new Date(1_000).toISOString(),
          updatedAt: new Date(1_000).toISOString(),
          terminalAt: new Date(1_000).toISOString(),
        });
      }
      if (method === "POST" && suffix === "/cancel") {
        carrier.status = "CANCELLED";
        return jsonResponse(200, {
          executionId,
          applicationId: OWN_APPLICATION_ID,
          status: "CANCELLED",
          createdAt: new Date(1_000).toISOString(),
          replayed: false,
          lastEventSequence: 2,
        });
      }
      if (suffix === "/results") {
        return jsonResponse(200, {
          executionId,
          status: carrierTerminal,
          route: {
            provider: "tenant-isolation-probe",
            model: "pre-dispatch-scope-checks",
            strategyClass: "tenant-isolation-probe",
            modelCalls: 0,
          },
          cost: null,
          usage: null,
          outputArtifacts: [],
          verification: [
            {
              id: "v1",
              executionId,
              criterionId: "typed-rejection-observed",
              strategy: "deterministic",
              status: carrierVerification,
              recordedBy: "fake-platform",
            },
          ],
          warnings: [],
          terminalAt: new Date(1_000).toISOString(),
        });
      }
      if (suffix === "/events") {
        return jsonResponse(200, []);
      }
      if (suffix === "/verification") {
        return jsonResponse(200, []);
      }
    }

    return jsonResponse(500, {
      code: "PROVIDER_ERROR",
      message: `unmapped fake route ${url}`,
      retryable: true,
    });
  };

  return { transport, state };
}

// ---------------------------------------------------------------------------
// The fake platform surface (the driver's seams)
// ---------------------------------------------------------------------------

/** The mutations the discrimination tests inject (each weakens ONE protection). */
export interface FakeWorldMutations {
  /** The read seam returns the foreign execution for the own scope (data leak). */
  readonly leakForeignReads?: boolean;
  /** The transition tenant check is removed (the mismatched command is admitted). */
  readonly ignoreTenantCheck?: boolean;
  /** The locked-row scope check is removed (the foreign execution is admitted). */
  readonly ignoreLockScope?: boolean;
  /** The create-path application-tenant check is removed. */
  readonly ignoreCreateScope?: boolean;
  /** The environment-ownership check is removed. */
  readonly ignoreEnvironmentScope?: boolean;
  /** The wire's forged scope is admitted (200 with the foreign record). */
  readonly admitForgedScope?: boolean;
  /** A denied write leaves a durable row anyway (the unaccounted write). */
  readonly writeOnDenial?: boolean;
}

/**
 * The fake isolation world: the executions-service seam, the wire seam
 * and the row-count seam over one in-memory world that replays the
 * REAL locked-row semantics. Every write lands in the world's write
 * ledger — the row-count invariants read it exactly like the SQL
 * counts the integration seam reads. The driver's carrier is seeded
 * by `seedCarrier` (the crown submits it through the real API; the
 * fake world hosts it for the driver's lifecycle + battery).
 */
export function createFakeIsolationWorld(options?: { readonly mutations?: FakeWorldMutations }): {
  readonly executions: IsolationExecutionsSurface;
  readonly wire: IsolationWireSurface;
  readonly counts: IsolationCountSnapshotter;
  readonly state: {
    readonly ownWrites: { readonly raw: readonly string[] };
    readonly foreignWrites: { readonly raw: readonly string[] };
    readonly foreignExecutionTouched: boolean;
  };
  readonly seedCarrier: () => string;
} {
  const mutations: FakeWorldMutations = options?.mutations ?? {};
  const ownWrites = {
    executions: 0,
    executionEvents: 0,
    verificationResults: 0,
    idempotencyRecords: 0,
    raw: [] as string[],
  };
  const foreignWrites = {
    executions: 0,
    executionEvents: 0,
    verificationResults: 0,
    idempotencyRecords: 0,
    raw: [] as string[],
  };
  let foreignExecutionTouched = false;
  // The seeded foreign execution's durable shape (the canary material).
  const foreignExecution = {
    id: FOREIGN_EXECUTION_ID,
    applicationId: FOREIGN_APPLICATION_ID,
    tenantId: FOREIGN_TENANT_ID,
    status: "CREATED",
    task: { kind: "foreign-workload", input: FOREIGN_TASK_CANARY },
    metadata: { classification: FOREIGN_METADATA_MARKER },
  };
  // The driver's carrier (own application, own tenant) — seeded lazily.
  let carrier: { id: string; status: string; events: unknown[] } | null = null;

  const recordOwnWrite = (
    kind: "executions" | "executionEvents" | "verificationResults" | "idempotencyRecords",
    note: string,
  ): void => {
    ownWrites[kind] += 1;
    ownWrites.raw.push(note);
  };
  const recordForeignWrite = (
    kind: "executions" | "executionEvents" | "verificationResults" | "idempotencyRecords",
    note: string,
  ): void => {
    foreignWrites[kind] += 1;
    foreignWrites.raw.push(note);
  };

  const executions: IsolationExecutionsSurface = {
    async createExecution(input, _key, actor) {
      if (input.applicationId === FOREIGN_APPLICATION_ID) {
        if (mutations.ignoreCreateScope) {
          recordForeignWrite("executions", "foreign-application create ADMITTED (mutation)");
          foreignExecutionTouched = true;
          return { executionId: `mutated-${FOREIGN_EXECUTION_ID}`, status: "CREATED" };
        }
        if (actor.tenantId !== FOREIGN_TENANT_ID) {
          if (mutations.writeOnDenial) {
            recordForeignWrite("idempotencyRecords", "denied create left a ledger row (mutation)");
          }
          throw new FakeTypedRejection(
            "TENANT_SCOPE_VIOLATION",
            "application belongs to a different tenant",
          );
        }
      }
      if (input.environmentId !== undefined && input.environmentId === FOREIGN_ENVIRONMENT_ID) {
        if (mutations.ignoreEnvironmentScope) {
          recordOwnWrite("executions", "foreign-environment create ADMITTED (mutation)");
          return { executionId: `mutated-env-create`, status: "CREATED" };
        }
        if (mutations.writeOnDenial) {
          recordOwnWrite("idempotencyRecords", "denied env create left a ledger row (mutation)");
        }
        throw new FakeTypedRejection(
          "TENANT_SCOPE_VIOLATION",
          "environment does not belong to the target application",
        );
      }
      // A legitimate own-application create (the control flow).
      recordOwnWrite("executions", "legitimate create");
      recordOwnWrite("executionEvents", "execution.created");
      recordOwnWrite("idempotencyRecords", "create arbitration");
      return { executionId: `own-${ownWrites.executions}`, status: "CREATED" };
    },
    async getExecution(applicationId, executionId) {
      if (executionId === FOREIGN_EXECUTION_ID && applicationId === FOREIGN_APPLICATION_ID) {
        return foreignExecution;
      }
      if (executionId === FOREIGN_EXECUTION_ID && applicationId !== FOREIGN_APPLICATION_ID) {
        if (mutations.ignoreLockScope || mutations.leakForeignReads) {
          return foreignExecution;
        }
        return null;
      }
      if (carrier !== null && executionId === carrier.id && applicationId === OWN_APPLICATION_ID) {
        return {
          id: carrier.id,
          applicationId: OWN_APPLICATION_ID,
          tenantId: OWN_TENANT_ID,
          status: carrier.status,
        };
      }
      return null;
    },
    async listEvents(applicationId, executionId) {
      if (executionId === FOREIGN_EXECUTION_ID && applicationId === FOREIGN_APPLICATION_ID) {
        return [{ eventId: "foreign-event-1", payload: { marker: FOREIGN_EVENT_MARKER } }];
      }
      if (
        executionId === FOREIGN_EXECUTION_ID &&
        applicationId === OWN_APPLICATION_ID &&
        (mutations.ignoreLockScope || mutations.leakForeignReads)
      ) {
        return [{ eventId: "foreign-event-1", payload: { marker: FOREIGN_EVENT_MARKER } }];
      }
      if (carrier !== null && executionId === carrier.id && applicationId === OWN_APPLICATION_ID) {
        return [...carrier.events];
      }
      return [];
    },
    async listVerificationResults(applicationId, executionId) {
      if (executionId === FOREIGN_EXECUTION_ID && applicationId === FOREIGN_APPLICATION_ID) {
        return [{ criterionId: "foreign-criterion", status: "PASS" }];
      }
      if (
        executionId === FOREIGN_EXECUTION_ID &&
        applicationId === OWN_APPLICATION_ID &&
        mutations.leakForeignReads
      ) {
        return [{ criterionId: "foreign-criterion", status: "PASS" }];
      }
      return [];
    },
    async transition(command) {
      const lockMiss =
        command.executionId === FOREIGN_EXECUTION_ID &&
        command.applicationId !== FOREIGN_APPLICATION_ID;
      if (lockMiss && !mutations.ignoreLockScope) {
        if (mutations.writeOnDenial) {
          recordOwnWrite("executionEvents", "denied transition left an event (mutation)");
        }
        throw new FakeTypedRejection(
          "TENANT_SCOPE_VIOLATION",
          "execution not found in this application (missing or owned by another application)",
        );
      }
      const tenantMismatch =
        command.executionId !== FOREIGN_EXECUTION_ID && command.tenantId !== OWN_TENANT_ID;
      if (tenantMismatch && !mutations.ignoreTenantCheck) {
        if (mutations.writeOnDenial) {
          recordOwnWrite("executionEvents", "denied transition left an event (mutation)");
        }
        throw new FakeTypedRejection(
          "TENANT_SCOPE_VIOLATION",
          "execution belongs to a different tenant",
        );
      }
      // An admitted transition (a mutated probe crossing the boundary).
      if (command.executionId === FOREIGN_EXECUTION_ID) {
        recordForeignWrite("executionEvents", "foreign execution TRANSITIONED (isolation failure)");
        foreignExecutionTouched = true;
        return { execution: { ...foreignExecution, status: "CANCELLED" }, replayed: false };
      }
      if (carrier !== null && command.executionId === carrier.id) {
        recordOwnWrite("executionEvents", `legitimate transition: ${command.reason ?? ""}`);
        recordOwnWrite("idempotencyRecords", "transition arbitration");
        carrier.events.push({ cause: command.reason, transition: command.command });
        carrier.status = "RUNNING";
        return { execution: { id: carrier.id, status: carrier.status }, replayed: false };
      }
      throw new FakeTypedRejection(
        "TENANT_SCOPE_VIOLATION",
        "execution not found in this application (missing or owned by another application)",
      );
    },
    async recordStepEvent(input) {
      const lockMiss =
        input.executionId === FOREIGN_EXECUTION_ID &&
        input.applicationId !== FOREIGN_APPLICATION_ID;
      if (lockMiss && !mutations.ignoreLockScope) {
        if (mutations.writeOnDenial) {
          recordOwnWrite("executionEvents", "denied step event left a row (mutation)");
        }
        throw new FakeTypedRejection(
          "TENANT_SCOPE_VIOLATION",
          "execution not found in this application (missing or owned by another application)",
        );
      }
      const tenantMismatch =
        input.executionId !== FOREIGN_EXECUTION_ID && input.actor.tenantId !== OWN_TENANT_ID;
      if (tenantMismatch && !mutations.ignoreTenantCheck) {
        if (mutations.writeOnDenial) {
          recordOwnWrite("executionEvents", "denied step event left a row (mutation)");
        }
        throw new FakeTypedRejection(
          "TENANT_SCOPE_VIOLATION",
          "execution belongs to a different tenant",
        );
      }
      if (input.executionId === FOREIGN_EXECUTION_ID) {
        recordForeignWrite("executionEvents", "foreign execution JOURNALED (isolation failure)");
        foreignExecutionTouched = true;
        return { sequence: 2, replayed: false };
      }
      if (carrier !== null && input.executionId === carrier.id) {
        recordOwnWrite("executionEvents", `journal: ${String(input.cause ?? "step")}`);
        recordOwnWrite("idempotencyRecords", "step-event arbitration");
        carrier.events.push({ cause: input.cause, payload: input.payload });
        return { sequence: carrier.events.length + 1, replayed: false };
      }
      throw new FakeTypedRejection(
        "TENANT_SCOPE_VIOLATION",
        "execution not found in this application (missing or owned by another application)",
      );
    },
    async recordPlanningDecision(input) {
      const lockMiss =
        input.executionId === FOREIGN_EXECUTION_ID &&
        input.applicationId !== FOREIGN_APPLICATION_ID;
      if (lockMiss && !mutations.ignoreLockScope) {
        if (mutations.writeOnDenial) {
          recordOwnWrite("executionEvents", "denied planning decision left a row (mutation)");
        }
        throw new FakeTypedRejection(
          "TENANT_SCOPE_VIOLATION",
          "execution not found in this application (missing or owned by another application)",
        );
      }
      const tenantMismatch =
        input.executionId !== FOREIGN_EXECUTION_ID && input.tenantId !== OWN_TENANT_ID;
      if (tenantMismatch && !mutations.ignoreTenantCheck) {
        if (mutations.writeOnDenial) {
          recordOwnWrite("executionEvents", "denied planning decision left a row (mutation)");
        }
        throw new FakeTypedRejection(
          "TENANT_SCOPE_VIOLATION",
          "execution belongs to a different tenant",
        );
      }
      if (input.executionId === FOREIGN_EXECUTION_ID) {
        recordForeignWrite("executionEvents", "foreign planning decision (isolation failure)");
        foreignExecutionTouched = true;
        return { sequence: 2, replayed: false };
      }
      if (carrier !== null && input.executionId === carrier.id) {
        recordOwnWrite("executionEvents", "planning decision");
        recordOwnWrite("idempotencyRecords", "planning arbitration");
        carrier.events.push({ cause: "planning.decision-recorded", decisionId: input.decisionId });
        return { sequence: carrier.events.length + 1, replayed: false };
      }
      throw new FakeTypedRejection(
        "TENANT_SCOPE_VIOLATION",
        "execution not found in this application (missing or owned by another application)",
      );
    },
  };

  // The wire seam throws the ZeckApiError shape (status + typed body)
  // — exactly what the public client surfaces to the driver.
  const wireError = (status: number, code: string, message: string): never => {
    throw Object.assign(new Error(message), {
      status,
      body: { code, message, retryable: false },
    });
  };

  const wire: IsolationWireSurface = {
    scoped: {
      async createExecution(request, _key) {
        if (request.applicationId === FOREIGN_APPLICATION_ID) {
          return wireError(
            403,
            "AUTHORIZATION_DENIED",
            "actor holds no membership for this application",
          );
        }
        if (
          request.environmentId !== undefined &&
          request.environmentId === FOREIGN_ENVIRONMENT_ID
        ) {
          if (mutations.ignoreEnvironmentScope) {
            recordOwnWrite(
              "executions",
              "foreign-environment create ADMITTED over the wire (mutation)",
            );
            return { executionId: "mutated-env-create-wire", status: "CREATED" };
          }
          return wireError(
            403,
            "TENANT_SCOPE_VIOLATION",
            "environment does not belong to the target application",
          );
        }
        recordOwnWrite("executions", "wire legitimate create");
        recordOwnWrite("executionEvents", "execution.created");
        recordOwnWrite("idempotencyRecords", "create arbitration");
        return { executionId: `own-wire-${ownWrites.executions}`, status: "CREATED" };
      },
      async getExecution(executionId) {
        if (executionId === FOREIGN_EXECUTION_ID) {
          if (mutations.leakForeignReads || mutations.ignoreLockScope) {
            return foreignExecution;
          }
          return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
        }
        if (carrier !== null && executionId === carrier.id) {
          return { id: carrier.id, status: carrier.status };
        }
        return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
      },
      async cancelExecution(executionId, _key) {
        if (executionId === FOREIGN_EXECUTION_ID) {
          if (mutations.ignoreLockScope) {
            recordForeignWrite(
              "executionEvents",
              "foreign CANCELLED over the wire (isolation failure)",
            );
            foreignExecutionTouched = true;
            return { executionId, status: "CANCELLED", replayed: false };
          }
          return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
        }
        if (carrier !== null && executionId === carrier.id) {
          recordOwnWrite("executionEvents", "wire legitimate cancel");
          recordOwnWrite("idempotencyRecords", "cancel arbitration");
          carrier.status = "CANCELLED";
          return { executionId, status: "CANCELLED", replayed: false };
        }
        return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
      },
      async getResult(executionId) {
        if (executionId === FOREIGN_EXECUTION_ID) {
          if (mutations.leakForeignReads) {
            return {
              executionId,
              status: "CREATED",
              verification: [{ criterionId: "foreign-criterion", status: "PASS" }],
              outputArtifacts: [],
            };
          }
          return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
        }
        if (carrier !== null && executionId === carrier.id) {
          return { executionId, status: "COMPLETED", verification: [], outputArtifacts: [] };
        }
        return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
      },
      async listEvents(executionId) {
        if (executionId === FOREIGN_EXECUTION_ID) {
          if (mutations.leakForeignReads) {
            return [{ eventId: "foreign-event-1", payload: { marker: FOREIGN_EVENT_MARKER } }];
          }
          return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
        }
        if (carrier !== null && executionId === carrier.id) {
          return [...carrier.events];
        }
        return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
      },
      async listVerification(executionId) {
        if (executionId === FOREIGN_EXECUTION_ID) {
          if (mutations.leakForeignReads) {
            return [{ criterionId: "foreign-criterion", status: "PASS" }];
          }
          return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
        }
        if (carrier !== null && executionId === carrier.id) {
          return [];
        }
        return wireError(404, "CAPABILITY_UNAVAILABLE", "execution not found");
      },
    },
    forged: {
      async getExecution(_executionId) {
        if (mutations.admitForgedScope) {
          return foreignExecution;
        }
        return wireError(
          403,
          "AUTHORIZATION_DENIED",
          "actor holds no membership for this application",
        );
      },
      async createExecution(request, _key) {
        if (request.applicationId === FOREIGN_APPLICATION_ID && !mutations.admitForgedScope) {
          return wireError(
            403,
            "AUTHORIZATION_DENIED",
            "actor holds no membership for this application",
          );
        }
        return foreignExecution;
      },
    },
  };

  const counts: IsolationCountSnapshotter = async () => ({
    ownApplication: {
      executions: ownWrites.executions,
      executionEvents: ownWrites.executionEvents,
      verificationResults: ownWrites.verificationResults,
      idempotencyRecords: ownWrites.idempotencyRecords,
    },
    foreignApplication: {
      executions: foreignWrites.executions,
      executionEvents: foreignWrites.executionEvents,
      verificationResults: foreignWrites.verificationResults,
      idempotencyRecords: foreignWrites.idempotencyRecords,
    },
  });

  return {
    executions,
    wire,
    counts,
    state: {
      get ownWrites() {
        return { raw: [...ownWrites.raw] };
      },
      get foreignWrites() {
        return { raw: [...foreignWrites.raw] };
      },
      get foreignExecutionTouched() {
        return foreignExecutionTouched;
      },
    },
    seedCarrier: () => {
      carrier = { id: "carrier-execution", status: "RUNNING", events: [] };
      return carrier.id;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake lifecycle binding (the in-memory mirror of the ledger)
// ---------------------------------------------------------------------------

/**
 * Bind a fake lifecycle over the fake world's carrier: the driver's
 * transitions journal onto the carrier (legitimate own writes), each
 * probe outcome journals EXACTLY once (the in-memory mirror of the
 * `agent-action-recorded` ledger vocabulary), and the completion
 * records the criteria AFTER the row-count window closes.
 */
export function createFakeLifecycle(world: { readonly executions: IsolationExecutionsSurface }): {
  readonly lifecycle: {
    readonly transition: (command: {
      readonly executionId: string;
      readonly step: "authorize" | "plan" | "queue" | "start" | "verify";
      readonly reason: string;
    }) => Promise<void>;
    readonly recordPlanningDecision: (input: {
      readonly executionId: string;
      readonly route: {
        readonly provider: string;
        readonly model: string;
        readonly strategyClass: string;
      };
    }) => Promise<void>;
    readonly recordProbeOutcome: (input: {
      readonly executionId: string;
      readonly record: {
        readonly probeId: string;
        readonly denied: boolean;
        readonly requestDigest: string;
      };
    }) => Promise<void>;
    readonly complete: (input: {
      readonly executionId: string;
      readonly verdict: "pass" | "fail";
      readonly criteria: readonly { readonly criterionId: string; readonly status: string }[];
    }) => Promise<void>;
  };
  readonly journal: {
    readonly probeIds: readonly string[];
    readonly transitions: readonly string[];
  };
  /** Discrimination mutation: journal EVERY probe TWICE. */
  readonly duplicateJournal: () => void;
} {
  const probeIds: string[] = [];
  const transitions: string[] = [];
  let transitionCounter = 0;
  let duplicate = false;
  const lifecycle = {
    async transition(command: { readonly step: string; readonly executionId: string }) {
      transitionCounter += 1;
      transitions.push(command.step);
      await world.executions.transition(
        {
          command: "queue",
          applicationId: OWN_APPLICATION_ID,
          tenantId: OWN_TENANT_ID,
          executionId: command.executionId,
          actorId: OWN_ACTOR_ID,
          reason: `fake-lifecycle-${command.step}-${transitionCounter}`,
        },
        `fake-lifecycle-${command.executionId}-${transitionCounter}`,
      );
    },
    async recordPlanningDecision(input: {
      readonly executionId: string;
      readonly route: {
        readonly provider: string;
        readonly model: string;
        readonly strategyClass: string;
      };
    }) {
      await world.executions.recordPlanningDecision(
        {
          applicationId: OWN_APPLICATION_ID,
          executionId: input.executionId,
          tenantId: OWN_TENANT_ID,
          actorId: OWN_ACTOR_ID,
          decisionId: `fake-decision-${input.executionId.slice(-8)}`,
          planId: `fake-plan-${input.executionId.slice(-8)}`,
          payload: { route: input.route },
        },
        `fake-decision-${input.executionId.slice(-8)}`,
      );
    },
    async recordProbeOutcome(input: {
      readonly executionId: string;
      readonly record: {
        readonly probeId: string;
        readonly denied: boolean;
        readonly requestDigest: string;
      };
    }) {
      const passes = duplicate ? 2 : 1;
      for (let pass = 0; pass < passes; pass += 1) {
        probeIds.push(input.record.probeId);
        await world.executions.recordStepEvent(
          {
            executionId: input.executionId,
            applicationId: OWN_APPLICATION_ID,
            actor: { actorId: OWN_ACTOR_ID, tenantId: OWN_TENANT_ID },
            command: "agent-action-recorded",
            cause: `val-024-isolation-probe-${input.record.probeId}`,
            reference: {
              probeId: input.record.probeId,
              denied: input.record.denied,
              requestDigest: input.record.requestDigest,
            },
            payload: { probeId: input.record.probeId },
          },
          `val-024-${input.executionId}-probe-${probeIds.length}`,
        );
      }
    },
    async complete(input: {
      readonly executionId: string;
      readonly verdict: "pass" | "fail";
      readonly criteria: readonly { readonly criterionId: string; readonly status: string }[];
    }) {
      await world.executions.transition(
        {
          command: input.verdict,
          applicationId: OWN_APPLICATION_ID,
          tenantId: OWN_TENANT_ID,
          executionId: input.executionId,
          actorId: OWN_ACTOR_ID,
          reason: `val-024-${input.verdict}`,
        },
        `val-024-${input.executionId}-${input.verdict}`,
      );
    },
  };
  return {
    lifecycle,
    journal: {
      get probeIds() {
        return [...probeIds];
      },
      get transitions() {
        return [...transitions];
      },
    },
    duplicateJournal: () => {
      duplicate = true;
    },
  };
}

/** The REAL typed rejection shape the fake surfaces throw (the pinned vocabulary). */
export class FakeTypedRejection extends Error {
  readonly code: string;
  readonly httpStatus: number | null;

  constructor(code: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "FakeTypedRejection";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
