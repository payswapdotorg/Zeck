/**
 * The tenant-isolation customer application (VAL-024).
 *
 * A real customer-style application: one pinned isolation-probe
 * corpus row per run, submitted through Zeck's public SDK boundary.
 * The application is the TENANT: before submitting its carrier task
 * it performs its own cross-tenant access attempts exactly as a
 * confused or hostile customer integration would — reading,
 * cancelling, fetching the result package of another tenant's
 * execution; creating work that references another tenant's
 * application and environment; constructing a client with a forged
 * application scope — and asserts the platform's typed rejections:
 * never data, never effects, never an admission. The carrier
 * submission then rides the standard customer flow (submit → poll →
 * result) and the platform drives the full probe battery (the
 * locked-row checks over the REAL platform path) with the isolation
 * journal; this application asserts the per-row deterministic outcome
 * contract from the corpus: the isolation-held battery COMPLETES with
 * PASS verification (a FAILED there means a probe was admitted, data
 * leaked or an effect landed — an honest isolation-failure finding,
 * never a fabricated isolation).
 *
 * The foreign references (the other tenant's execution, environment
 * and application ids) are RUN-TIME facts resolved by the integration
 * world (the crown seeds the foreign tenant; the fake API world hosts
 * the deterministic fixtures). Ids are the caller's own inputs; the
 * foreign CONTENT markers are planted canaries the app scans its own
 * probe outcomes against — any disclosure surfaces mechanically.
 */

import { createZeckClient, ZeckApiError, type ZeckClient } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type {
  ForeignContentMarker,
  ForeignWorldRefs,
  IsolationProbeKind,
  PlannedIsolationProbe,
} from "../../platform/tenant-isolation";
import { planIsolationProbes } from "../../platform/tenant-isolation";
import { TENANT_ISOLATION_CORPUS } from "./corpus";

/** The app's pinned corpus slice (`tenant-isolation.probe.v1` rows). */
export const TENANT_ISOLATION_TASKS = TENANT_ISOLATION_CORPUS.map((row) => ({
  kind: "isolation-probe" as const,
  scenario: row.rowId,
  probe: row.probe,
  /** The corpus row's own expected terminal (the app's outcome contract). */
  expectedTerminal: row.expected.terminal,
}));

/** The foreign-world references the app probes at run time. */
export type AppForeignRefs = ForeignWorldRefs;

/** One customer-side probe outcome (the app's own isolation journal). */
export interface SdkProbeOutcome {
  readonly probeId: string;
  readonly operation: string;
  readonly reference: string;
  /** The expected typed rejection (code + wire status) per the plan. */
  readonly expectedCode: string;
  readonly expectedStatus: number;
  readonly observedCode: string | null;
  readonly observedStatus: number | null;
  /** The probe observed its expected typed rejection. */
  readonly denied: boolean;
  /** Foreign content observed in the probe's own response (never expected). */
  readonly dataLeak: boolean;
  readonly latencyMs: number;
  readonly requestDigest: string;
  readonly message: string;
}

export interface TenantIsolationAppResult {
  /** The carrier's evidence record (the primary customer-path record). */
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  /** The app's own isolation journal (each probe recorded exactly once). */
  readonly probes: readonly SdkProbeOutcome[];
}

const IDEMPOTENCY_PREFIX = "val-024-tenant-isolation";

/**
 * Run the tenant-isolation application end to end over one pinned
 * corpus row. The transport implementation is injected (the SDK's
 * seam); the app never selects provider/model/rail (the platform's
 * authority — and the isolation probes need no provider at all).
 */
export async function runTenantIsolationApp(options: {
  readonly config: AppHarnessConfig;
  readonly token: string;
  readonly transport: TransportImplementation;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly environment: {
    readonly runtime: string;
    readonly toolchain: string;
    readonly database: string;
    readonly configuration: Readonly<Record<string, string>>;
  };
  readonly runSuffix: string;
  readonly taskIndex: number;
  /** The run-time foreign-world facts (seeded by the integration world). */
  readonly foreignRefs: AppForeignRefs;
}): Promise<TenantIsolationAppResult> {
  const row = TENANT_ISOLATION_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned tenant-isolation task slice is empty");
  }

  // The customer's own clients: the scoped client (the tenant's own
  // application scope) and the forged client (constructed with the
  // OTHER application's scope — the header-confusion probe).
  const scoped = createZeckClient({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.config.applicationId,
    fetchImpl: options.transport,
  });
  const forged = createZeckClient({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.foreignRefs.foreignApplicationId,
    fetchImpl: options.transport,
  });

  // The row's customer-side probe battery: the plan's wire-surface
  // probes, each attempted exactly once, each asserting the expected
  // typed rejection and scanning the surfaced boundary for foreign
  // content (the error evidence carries the boundary, never the
  // other tenant's content).
  const wireProbes = planIsolationProbes(row.probe).filter((planned) => planned.surface === "wire");
  const probes: SdkProbeOutcome[] = [];
  for (const [index, planned] of wireProbes.entries()) {
    const idempotencyKey = `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}-${index + 1}`;
    const startedAt = options.now().getTime();
    const observed = await attemptWireProbe({
      planned,
      scoped,
      forged,
      foreign: options.foreignRefs,
      ownApplicationId: options.config.applicationId,
      idempotencyKey,
    });
    const latencyMs = options.now().getTime() - startedAt;
    const denied = matchWireObservation(planned, observed);
    const dataLeak = observationLeaksForeignContent(observed, options.foreignRefs.contentMarkers);
    probes.push({
      probeId: planned.probeId,
      operation: planned.operation,
      reference: planned.reference,
      expectedCode:
        planned.expected.kind === "typed-error" ? planned.expected.code : planned.expected.kind,
      expectedStatus:
        planned.expected.kind === "typed-error" ? (planned.expected.httpStatus ?? 0) : 0,
      observedCode: observed.code,
      observedStatus: observed.status,
      denied,
      dataLeak,
      latencyMs,
      requestDigest: digestOf({ probe: planned.probeId, reference: planned.reference }),
      message: observed.message,
    });
  }

  // The carrier submission rides the standard customer flow: the task
  // carries the row's probe declaration; the platform drives the full
  // battery (the locked-row checks) with the isolation journal.
  const harness = new ValidationHarness({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.config.applicationId,
    transport: options.transport,
    runtime: {
      now: options.now,
      sleep: options.sleep,
      environment: options.environment,
    },
    identity: {
      program: "zeck-validation",
      workOrder: "VAL-024",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: {
        kind: "isolation-probe",
        scenario: row.rowId,
        probe: row.probe,
      },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}-carrier`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: the
  // isolation-held battery COMPLETES with PASS verification (every
  // probe of the app's own battery denied with its typed rejection
  // and zero data disclosure). A FAILED platform outcome — a probe
  // admitted, content leaked, an effect landed — fails this app's
  // assertion honestly (never a fabricated isolation).
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });
  const probesPassed =
    probes.every((probe) => probe.denied) && probes.every((probe) => !probe.dataLeak);

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && probesPassed,
    probes,
  };
}

// ---------------------------------------------------------------------------
// The customer-side probe battery (the wire-surface plan)
// ---------------------------------------------------------------------------

/** One wire attempt's observation. */
interface WireObservation {
  readonly kind: "typed-error" | "unexpected-success" | "unexpected-error";
  readonly code: string | null;
  readonly status: number | null;
  readonly message: string;
  readonly data: unknown;
}

/** Attempt ONE planned wire probe through the public SDK clients. */
async function attemptWireProbe(input: {
  readonly planned: PlannedIsolationProbe;
  readonly scoped: ZeckClient;
  readonly forged: ZeckClient;
  readonly foreign: AppForeignRefs;
  readonly ownApplicationId: string;
  readonly idempotencyKey: string;
}): Promise<WireObservation> {
  const { planned, scoped, forged, foreign, ownApplicationId, idempotencyKey } = input;
  const probeTask = { kind: "isolation-probe", scenario: "wire-probe", input: "probe-reference" };
  const attempt = async (operation: () => Promise<unknown>): Promise<WireObservation> => {
    try {
      const data = await operation();
      return {
        kind: "unexpected-success",
        code: null,
        status: null,
        message: `${planned.operation} admitted the ${planned.reference} probe (isolation failure)`,
        data,
      };
    } catch (error) {
      if (error instanceof ZeckApiError) {
        return {
          kind: "typed-error",
          code: error.body.code,
          status: error.status,
          message: error.body.message,
          data: null,
        };
      }
      return {
        kind: "unexpected-error",
        code: null,
        status: null,
        message: error instanceof Error ? error.message : String(error),
        data: null,
      };
    }
  };

  switch (planned.operation) {
    case "getExecution":
      return attempt(() =>
        planned.reference === "forged-application-scope"
          ? forged.getExecution(foreign.foreignExecutionId)
          : scoped.getExecution(foreign.foreignExecutionId),
      );
    case "cancelExecution":
      return attempt(() => scoped.cancelExecution(foreign.foreignExecutionId, idempotencyKey));
    case "getResult":
      return attempt(() => scoped.getResult(foreign.foreignExecutionId));
    case "listEvents":
      return attempt(() => scoped.listEvents(foreign.foreignExecutionId));
    case "listVerification":
      return attempt(() => scoped.listVerification(foreign.foreignExecutionId));
    case "createExecution":
      return attempt(() =>
        planned.reference === "foreign-application"
          ? scoped.createExecution(
              { applicationId: foreign.foreignApplicationId, task: probeTask },
              idempotencyKey,
            )
          : scoped.createExecution(
              {
                applicationId: ownApplicationId,
                environmentId: foreign.foreignEnvironmentId,
                task: probeTask,
              },
              idempotencyKey,
            ),
      );
    default:
      return {
        kind: "unexpected-error",
        code: null,
        status: null,
        message: `the wire surface carries no ${planned.operation} probe`,
        data: null,
      };
  }
}

/** Match one wire observation against the plan's expected rejection. */
function matchWireObservation(planned: PlannedIsolationProbe, observed: WireObservation): boolean {
  if (planned.expected.kind !== "typed-error") {
    return false;
  }
  if (observed.kind !== "typed-error" || observed.code !== planned.expected.code) {
    return false;
  }
  if (planned.expected.httpStatus !== null && observed.status !== planned.expected.httpStatus) {
    return false;
  }
  return true;
}

/** The mechanical foreign-content scan over one probe observation. */
function observationLeaksForeignContent(
  observed: WireObservation,
  markers: readonly ForeignContentMarker[],
): boolean {
  const text = JSON.stringify({
    code: observed.code,
    message: observed.message,
    data: observed.data,
  });
  if (text === undefined) {
    return false;
  }
  for (const marker of markers) {
    if (marker.material.length > 0 && text.includes(marker.material)) {
      return true;
    }
  }
  return false;
}

/** The FNV digest of any value — the evidence reference form. */
function digestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The probe plan lookup the app consumes (the platform's PURE derivation). */
export function wireProbesForProbeKind(
  probe: IsolationProbeKind,
): readonly PlannedIsolationProbe[] {
  return planIsolationProbes(probe).filter((planned) => planned.surface === "wire");
}
