/**
 * The tenant-isolation application's deterministic fixture worlds
 * (VAL-024, AC2 + AC6).
 *
 * The controlled fake public API: a tenant-aware transport-level fake
 * that replays the REAL boundary shapes the platform's routes
 * produce — the 404 indistinguishable miss (byte-identical for a
 * foreign id and an unknown id), the 403 AUTHORIZATION_DENIED
 * membership boundary, the 403 TENANT_SCOPE_VIOLATION environment
 * check — while carrying the other tenant's canary content in its
 * fixture state (the zero-data-disclosure scan surface). A LEAKY
 * variant discloses the foreign row on cross-tenant reads (the
 * discrimination: the app's assertions must FAIL on it).
 *
 * The fake probe seams: deterministic implementations of the
 * platform-side operations for the driver unit tests (replaying the
 * REAL rejection shapes) plus the leaky seam (the breach detector)
 * and the over-denying seam (the control discrimination — a boundary
 * that denies even the own-namespace control fails the control row).
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  IsolationOperation,
  IsolationProbeObservation,
  IsolationWorldFacts,
} from "../../platform/tenant-isolation";
import { isolationDigestOf } from "../../platform/tenant-isolation";

/** The fixture world's tenant/application identities. */
export const FIXTURE_OWN_APPLICATION_ID = "app-fixture-own";
export const FIXTURE_FOREIGN_APPLICATION_ID = "app-fixture-foreign";
export const FIXTURE_FOREIGN_ENVIRONMENT_ID = "env-fixture-foreign";
export const FIXTURE_FOREIGN_EXECUTION_ID = "exec-fixture-foreign";
export const FIXTURE_OWN_EXECUTION_ID = "exec-fixture-own";
export const FIXTURE_FOREIGN_ARTIFACT_DIGEST = "a".repeat(64);
export const FIXTURE_OWN_ARTIFACT_DIGEST = "b".repeat(64);

/** The other tenant's canary content (labels + markers, never secrets). */
export const FIXTURE_FOREIGN_MARKERS = [
  {
    label: "foreign-execution-canary",
    marker: "TENANT-FX-CANARY-EXEC-7c31d9",
  },
  {
    label: "foreign-artifact-canary",
    marker: "TENANT-FX-CANARY-ARTIFACT-2e84a1",
  },
] as const;

/**
 * The controlled fake public API world: two tenants, two
 * applications, the foreign execution carrying canary content in its
 * task input. `leaky` flips the cross-tenant read into a disclosure
 * (the discrimination — the app must fail); `terminal` pins the
 * platform outcome the fake reports (the honest FAILED terminal must
 * fail the app's outcome contract).
 */
export function createFakeApiWorld(options: {
  readonly leaky?: boolean;
  readonly terminal?: "COMPLETED" | "FAILED";
}): {
  readonly transport: TransportImplementation;
  readonly state: {
    readonly executions: { id: string; status: string; applicationId: string }[];
    readonly foreignReads: number;
  };
} {
  const executions = new Map<string, { status: string; applicationId: string }>();
  let sequence = 0;
  const state = {
    executions: [] as { id: string; status: string; applicationId: string }[],
    foreignReads: 0,
  };
  // The foreign tenant's execution row (canary content in the task —
  // a leaky read would echo it back).
  const foreignRow = {
    id: FIXTURE_FOREIGN_EXECUTION_ID,
    status: "RUNNING",
    applicationId: FIXTURE_FOREIGN_APPLICATION_ID,
    task: {
      kind: "tenant-fx-lead-record",
      input: `confidential tenant-FX content ${FIXTURE_FOREIGN_MARKERS[0].marker}`,
    },
  };
  executions.set(FIXTURE_FOREIGN_EXECUTION_ID, {
    status: "RUNNING",
    applicationId: FIXTURE_FOREIGN_APPLICATION_ID,
  });

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  /** The 404 indistinguishable miss (identical for foreign and unknown ids). */
  const scopeCheckedMiss = (): Response =>
    jsonResponse(404, {
      code: "CAPABILITY_UNAVAILABLE",
      message: "execution not found",
      retryable: false,
    });

  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    const headers = (init as RequestInit | undefined)?.headers ?? {};
    // The application-scope selector (the X-Zeck-Application header).
    const scopeHeader = String(
      (headers as Record<string, unknown>)[
        Object.keys(headers).find((key) => key.toLowerCase() === "x-zeck-application") ?? ""
      ] ?? "",
    );
    const body = (init as { body?: string } | undefined)?.body;
    const parsedBody = body === undefined ? {} : (JSON.parse(body) as Record<string, unknown>);

    if (url.endsWith("/executions") && method === "POST") {
      const applicationId = String(parsedBody.applicationId ?? "");
      const environmentId =
        parsedBody.environmentId === undefined ? undefined : String(parsedBody.environmentId);
      // Application-id confusion: the actor holds no membership for the
      // foreign application (the scope resolver's boundary).
      if (applicationId === FIXTURE_FOREIGN_APPLICATION_ID) {
        return jsonResponse(403, {
          code: "AUTHORIZATION_DENIED",
          message: "actor holds no membership for this application",
          retryable: false,
          details: { applicationId },
        });
      }
      // The environment-ownership check: a foreign environment never
      // belongs to the target application.
      if (environmentId === FIXTURE_FOREIGN_ENVIRONMENT_ID) {
        return jsonResponse(403, {
          code: "TENANT_SCOPE_VIOLATION",
          message: "environment does not belong to the target application",
          retryable: false,
          details: { environmentId },
        });
      }
      sequence += 1;
      const id = `fake-exec-${sequence}`;
      executions.set(id, { status: "RUNNING", applicationId });
      state.executions.push({ id, status: "RUNNING", applicationId });
      return jsonResponse(201, {
        executionId: id,
        applicationId,
        status: "RUNNING",
        createdAt: new Date().toISOString(),
        replayed: false,
        lastEventSequence: 1,
      });
    }

    const execMatch = url.match(/\/executions\/([^/]+)(\/.*)?$/);
    if (execMatch !== null) {
      const executionId = execMatch[1] ?? "";
      const subPath = execMatch[2] ?? "";
      // The forged scope selector: the server derives the scope from
      // durable membership rows — the foreign selector never authorizes.
      if (scopeHeader === FIXTURE_FOREIGN_APPLICATION_ID) {
        return jsonResponse(403, {
          code: "AUTHORIZATION_DENIED",
          message: "actor holds no membership for this application",
          retryable: false,
          details: { applicationId: FIXTURE_FOREIGN_APPLICATION_ID },
        });
      }
      // Own-scope reads of the foreign execution: the scope-checked
      // miss — indistinguishable from missing (zero data, zero tenant
      // oracle). The LEAKY variant discloses the foreign row.
      if (executionId === FIXTURE_FOREIGN_EXECUTION_ID) {
        state.foreignReads += 1;
        if (options.leaky === true && subPath !== "/cancel") {
          return jsonResponse(200, {
            id: foreignRow.id,
            applicationId: foreignRow.applicationId,
            status: foreignRow.status,
            task: foreignRow.task,
            environmentId: null,
            constraints: null,
            metadata: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            terminalAt: null,
          });
        }
        if (method === "GET" || method === "POST") {
          return scopeCheckedMiss();
        }
      }
      const execution = executions.get(executionId);
      if (execution === undefined) {
        return scopeCheckedMiss();
      }
      if (subPath === "/cancel" && method === "POST") {
        return jsonResponse(200, {
          executionId,
          applicationId: execution.applicationId,
          status: "CANCELLED",
          createdAt: new Date().toISOString(),
          replayed: false,
          lastEventSequence: 2,
        });
      }
      if (subPath === "/events" && method === "GET") {
        return jsonResponse(200, []);
      }
      if (subPath === "/results" && method === "GET") {
        execution.status = options.terminal ?? "COMPLETED";
        return jsonResponse(200, {
          executionId,
          status: options.terminal ?? "COMPLETED",
          route: {
            provider: "fake-scope-authorities",
            model: "pre-dispatch-scope-checks",
            strategyClass: "tenant-isolation-probe",
            modelCalls: 0,
          },
          cost: null,
          usage: null,
          outputArtifacts: [],
          verification:
            (options.terminal ?? "COMPLETED") === "COMPLETED"
              ? [
                  {
                    id: "v1",
                    executionId,
                    criterionId: "typed-rejection",
                    strategy: "deterministic",
                    status: "PASS",
                    recordedBy: "fake-platform",
                  },
                ]
              : [],
          warnings: [],
          terminalAt: new Date().toISOString(),
        });
      }
      if (subPath === "" || subPath === "/verification") {
        execution.status = options.terminal ?? "COMPLETED";
        return jsonResponse(200, {
          id: executionId,
          applicationId: execution.applicationId,
          environmentId: null,
          status: options.terminal ?? "COMPLETED",
          task: { kind: "isolation-probe", input: "fixture" },
          constraints: null,
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          terminalAt: new Date().toISOString(),
        });
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
// The fake platform-side probe seams (driver unit tests)
// ---------------------------------------------------------------------------

/** The fixture world's stable facts (the foreign namespace untouched). */
export const FIXTURE_WORLD_FACTS: IsolationWorldFacts = {
  foreignExecutionCount: 1,
  foreignEventCount: 1,
  foreignArtifactCount: 1,
  foreignExecutionStatus: "RUNNING",
  foreignExecutionLastEventSequence: 1,
};

/**
 * The honest fake seam: every cross-tenant operation answers the REAL
 * rejection shape (the typed violation / the membership denial / the
 * null miss); the own-namespace controls are granted.
 */
export function createHonestFakeSeam(): {
  readonly probe: (input: {
    readonly probeOrdinal: number;
    readonly operation: IsolationOperation;
  }) => Promise<IsolationProbeObservation>;
  readonly calls: IsolationOperation[];
} {
  const calls: IsolationOperation[] = [];
  const probe = async (input: {
    readonly probeOrdinal: number;
    readonly operation: IsolationOperation;
  }): Promise<IsolationProbeObservation> => {
    calls.push(input.operation);
    switch (input.operation) {
      case "svc-create-foreign-application":
        return {
          kind: "denied",
          rejection: "TENANT_SCOPE_VIOLATION",
          message: "application belongs to a different tenant",
          latencyMs: 1,
          targetDigest: isolationDigestOf(input.operation),
          httpStatus: null,
        };
      case "svc-create-foreign-environment":
        return {
          kind: "denied",
          rejection: "TENANT_SCOPE_VIOLATION",
          message: "environment does not belong to the target application",
          latencyMs: 1,
          targetDigest: isolationDigestOf(input.operation),
          httpStatus: null,
        };
      case "svc-read-foreign-execution":
      case "svc-events-foreign-execution":
        return {
          kind: "miss",
          rejection: "SCOPE_CHECKED_MISS",
          message: "execution not found in this application (scope-checked miss, zero rows)",
          latencyMs: 1,
          targetDigest: isolationDigestOf(input.operation),
          httpStatus: null,
          rowsReturned: 0,
        };
      case "svc-transition-foreign-execution":
      case "svc-planning-foreign-execution":
        return {
          kind: "denied",
          rejection: "TENANT_SCOPE_VIOLATION",
          message:
            "execution not found in this application (missing or owned by another application)",
          latencyMs: 1,
          targetDigest: isolationDigestOf(input.operation),
          httpStatus: null,
        };
      case "svc-artifact-fetch-foreign":
      case "svc-artifact-adopt-foreign-parent":
        return {
          kind: "denied",
          rejection: "TENANT_SCOPE_VIOLATION",
          message: "artifact digest belongs to another tenant namespace",
          latencyMs: 1,
          targetDigest: isolationDigestOf(input.operation),
          httpStatus: null,
        };
      case "svc-resolve-forged-scope":
        return {
          kind: "denied",
          rejection: "AUTHORIZATION_DENIED",
          message: "actor holds no membership for this application",
          latencyMs: 1,
          targetDigest: isolationDigestOf(input.operation),
          httpStatus: null,
        };
      case "svc-read-own-execution":
      case "svc-artifact-fetch-own":
        return {
          kind: "granted",
          rejection: null,
          message: "granted (own-namespace access)",
          latencyMs: 1,
          targetDigest: isolationDigestOf(input.operation),
          httpStatus: null,
          rowsReturned: 1,
          dataDigest: isolationDigestOf(input.operation),
        };
      default: {
        const exhaustive: never = input.operation;
        throw new Error(`unhandled fake probe operation ${String(exhaustive)}`);
      }
    }
  };
  return { probe, calls };
}

/**
 * The LEAKY fake seam: the cross-tenant read DISCLOSES the foreign
 * row (the canary markers present in the observed text — labels only
 * in the record). The driver must journal the breach and FAIL.
 */
export function createLeakyFakeSeam(): (input: {
  readonly probeOrdinal: number;
  readonly operation: IsolationOperation;
}) => Promise<IsolationProbeObservation> {
  return async (input) => {
    if (input.operation === "svc-read-foreign-execution") {
      return {
        kind: "disclosed",
        rejection: null,
        message:
          "[REDACTED: foreign-content marker(s) foreign-execution-canary present in observed message — " +
          "the boundary evidence never carries the other tenant's content]",
        latencyMs: 1,
        targetDigest: isolationDigestOf(input.operation),
        httpStatus: 200,
        rowsReturned: 1,
        foreignMarkerLabels: ["foreign-execution-canary"],
      };
    }
    const honest = createHonestFakeSeam();
    return honest.probe(input);
  };
}

/**
 * The OVER-DENYING fake seam: even the own-namespace control is
 * denied (the boundary that denies everything). The control row's
 * granted expectations FAIL — the over-denial discrimination.
 */
export function createOverDenyingFakeSeam(): (input: {
  readonly probeOrdinal: number;
  readonly operation: IsolationOperation;
}) => Promise<IsolationProbeObservation> {
  return async (input) => {
    if (
      input.operation === "svc-read-own-execution" ||
      input.operation === "svc-artifact-fetch-own"
    ) {
      return {
        kind: "denied",
        rejection: "TENANT_SCOPE_VIOLATION",
        message: "over-denying fixture: own-namespace access denied",
        latencyMs: 1,
        targetDigest: isolationDigestOf(input.operation),
        httpStatus: null,
      };
    }
    const honest = createHonestFakeSeam();
    return honest.probe(input);
  };
}
