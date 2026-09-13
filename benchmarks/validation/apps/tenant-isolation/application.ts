/**
 * The tenant-isolation customer application (VAL-024).
 *
 * A real customer-style application: one pinned isolation-probe corpus
 * row per run — the cross-tenant read/transition/planning, the
 * artifact fetch/adoption, the cross-application state probe, the
 * application-id confusion, the cross-tenant environment reference,
 * the forged application-scope selector and the own-tenant control —
 * submitted through Zeck's public SDK boundary. The application
 * performs its own app-side probe (the row's public-SDK operation
 * against the run-time world refs: the other tenant's execution /
 * environment / application / artifact digest) and asserts the per-row
 * typed-rejection contract: a probe that receives the typed rejection
 * (or the 404 indistinguishable miss) with ZERO data disclosure
 * verifies the boundary; a probe that receives foreign data or an
 * unexpected success is a disclosure the app NEVER passes (a fabricated
 * boundary is never tolerated). The app never selects
 * provider/model/rail (the platform's authority).
 */

import { createZeckClient, ZeckApiError } from "../../../../sdk";
import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import {
  type AppProbeObservation,
  classifySdkRejection,
  type ForeignContentMarker,
  isolationDigestOf,
  redactForeignMarkers,
  scanForForeignContent,
  verifyIsolationContract,
} from "../../platform/tenant-isolation";
import { ISOLATION_CORPUS } from "./corpus";

/**
 * The run-time world references the app's probes address (the served
 * world binds them; the corpus itself stays secret-free and
 * repository-reproducible — roles, never ids).
 */
export interface TenantIsolationWorldRefs {
  /** The OTHER tenant's application id (confusion probes). */
  readonly foreignApplicationId: string;
  /** The OTHER tenant's environment id (create probes). */
  readonly foreignEnvironmentId: string;
  /** The OTHER tenant's execution id (read/transition/state probes). */
  readonly foreignExecutionId: string;
  /** The OTHER tenant's artifact digest (artifact probes). */
  readonly foreignArtifactDigest: string;
  /** One's OWN tenant's artifact digest (the control). */
  readonly ownArtifactDigest: string;
  /** The other tenant's canary content (labels + markers, never secrets). */
  readonly foreignMarkers: readonly ForeignContentMarker[];
}

/** The app's pinned corpus slice (`isolation-probe.v1` rows). */
export const TENANT_ISOLATION_TASKS = ISOLATION_CORPUS.map((row) => ({
  kind: "isolation-probe",
  scenario: row.rowId,
  family: row.family,
  targetRole: row.targetRole,
  /** The corpus row's own expected terminal (the app's outcome contract). */
  expectedTerminal: row.expected.terminal,
}));

/** The app's full run outcome (evidence + assertions + probe facts). */
export interface TenantIsolationAppResult {
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly appCriteria: readonly LabVerificationCriterion[];
  readonly observations: readonly AppProbeObservation[];
  readonly probeFacts: {
    readonly rowId: string;
    readonly probeKind: string;
    readonly rejection: string | null;
    readonly httpStatus: number | null;
    readonly latencyMs: number;
  }[];
}

const IDEMPOTENCY_PREFIX = "val-024-tenant-isolation";

/**
 * Run the tenant-isolation application end to end over one pinned
 * corpus row. The transport implementation is injected (the SDK's
 * seam).
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
  /** The run-time world refs the app-side probe addresses. */
  readonly worldRefs: TenantIsolationWorldRefs;
}): Promise<TenantIsolationAppResult> {
  const row = ISOLATION_CORPUS[options.taskIndex];
  if (row === undefined) {
    throw new Error("the pinned tenant-isolation task slice is empty");
  }
  const markers = options.worldRefs.foreignMarkers;

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

  // ---- the submission phase (the probe execution the platform drives) ----
  const idempotencyKey = `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: {
        kind: "isolation-probe",
        rowId: row.rowId,
        family: row.family,
        targetRole: row.targetRole,
      },
    },
    idempotencyKey,
  );

  // ---- the app-side probe phase (the customer-boundary operation) ----
  // The app's own SDK clients: the own-scope client and, for the
  // forged-scope row, a client whose selector names the OTHER tenant's
  // application (the client NEVER authorizes — the server derives the
  // scope from durable membership rows).
  const ownClient = createZeckClient({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.config.applicationId,
    fetchImpl: options.transport,
  });
  const forgedClient = createZeckClient({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.worldRefs.foreignApplicationId,
    fetchImpl: options.transport,
  });

  const observations: AppProbeObservation[] = [];
  const probeKey = `${IDEMPOTENCY_PREFIX}-probe-${options.runSuffix}-${options.taskIndex}`;
  const probeTask = {
    kind: "isolation-probe",
    rowId: row.rowId,
    family: row.family,
    targetRole: row.targetRole,
  };

  /** Record one SDK probe call's observed outcome (honest, never fabricated). */
  const observe = (
    operation: string,
    targetId: string,
    attempt: () => Promise<unknown>,
    isControl: boolean,
  ): Promise<void> =>
    attempt()
      .then((value) => {
        // A 2xx answer on a CROSS-tenant probe is a boundary breach
        // (foreign data or a foreign effect crossed); on the own-tenant
        // control it is the granted row. Scan the observed text for the
        // other tenant's canary content either way (labels only).
        const text = JSON.stringify(value ?? null) ?? "";
        const found = scanForForeignContent(text, markers);
        observations.push({
          probe: observations.length + 1,
          operation,
          kind: isControl ? "granted" : "disclosed",
          rejection: null,
          httpStatus: 200,
          message: isControl
            ? redactForeignMarkers("granted (own-namespace access)", markers)
            : redactForeignMarkers(
                "the boundary did not reject the cross-tenant probe (2xx observed)",
                markers,
              ),
          latencyMs: 0,
          targetDigest: isolationDigestOf(targetId),
          foreignMarkerLabels: found,
          dataDigest: isolationDigestOf(text),
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ZeckApiError) {
          const rejection = classifySdkRejection({
            status: error.status,
            code: error.body.code,
          });
          observations.push({
            probe: observations.length + 1,
            operation,
            kind: rejection === null ? "disclosed" : "denied",
            rejection,
            httpStatus: error.status,
            message: redactForeignMarkers(error.body.message, markers),
            latencyMs: 0,
            targetDigest: isolationDigestOf(targetId),
            foreignMarkerLabels: scanForForeignContent(error.body.message, markers),
            dataDigest: null,
          });
          return;
        }
        // An unexpected (non-wire) failure: recorded honestly — the
        // sequence comparison fails the contract, never a fabricated
        // boundary verification.
        observations.push({
          probe: observations.length + 1,
          operation,
          kind: "unexpected",
          rejection: null,
          httpStatus: null,
          message: redactForeignMarkers(
            `unexpected probe failure (the boundary could not be verified): ${
              error instanceof Error ? error.message : String(error)
            }`,
            markers,
          ),
          latencyMs: 0,
          targetDigest: isolationDigestOf(targetId),
          foreignMarkerLabels: [],
          dataDigest: null,
        });
      });

  if (row.appProbe !== undefined) {
    const appProbe = row.appProbe;
    switch (appProbe.operation) {
      case "sdk-read-foreign-execution": {
        await observe(
          appProbe.operation,
          options.worldRefs.foreignExecutionId,
          () => ownClient.getExecution(options.worldRefs.foreignExecutionId),
          false,
        );
        break;
      }
      case "sdk-cancel-foreign-execution": {
        await observe(
          appProbe.operation,
          options.worldRefs.foreignExecutionId,
          () => ownClient.cancelExecution(options.worldRefs.foreignExecutionId, probeKey),
          false,
        );
        break;
      }
      case "sdk-events-foreign-execution": {
        await observe(
          appProbe.operation,
          options.worldRefs.foreignExecutionId,
          () => ownClient.listEvents(options.worldRefs.foreignExecutionId),
          false,
        );
        break;
      }
      case "sdk-create-foreign-application": {
        await observe(
          appProbe.operation,
          options.worldRefs.foreignApplicationId,
          () =>
            ownClient.createExecution(
              { applicationId: options.worldRefs.foreignApplicationId, task: probeTask },
              probeKey,
            ),
          false,
        );
        break;
      }
      case "sdk-create-foreign-environment": {
        await observe(
          appProbe.operation,
          options.worldRefs.foreignEnvironmentId,
          () =>
            ownClient.createExecution(
              {
                applicationId: options.config.applicationId,
                environmentId: options.worldRefs.foreignEnvironmentId,
                task: probeTask,
              },
              probeKey,
            ),
          false,
        );
        break;
      }
      case "sdk-forged-scope-read": {
        // The forged selector: the client names the OTHER tenant's
        // application; the server must derive the scope from durable
        // membership rows and deny before any execution row is read.
        await observe(
          appProbe.operation,
          options.worldRefs.foreignApplicationId,
          () => forgedClient.getExecution(submitted.executionId),
          false,
        );
        break;
      }
      case "sdk-read-own-execution": {
        await observe(
          appProbe.operation,
          submitted.executionId,
          () => ownClient.getExecution(submitted.executionId),
          true,
        );
        break;
      }
      default: {
        const exhaustive: never = appProbe.operation;
        throw new Error(`unhandled SDK probe operation ${String(exhaustive)}`);
      }
    }
  }

  // ---- the completion + retrieval phase ----
  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // ---- the assertion phase ----
  // The outcome contract: the corpus-declared terminal (every row in
  // this corpus pins COMPLETED — a verified boundary; a platform-side
  // disclosure or criteria failure flips the terminal honestly to
  // FAILED, failing this assertion) + PASS verification statuses.
  const harnessPassed = harness.assertOutcome({
    expectTerminalStatus: row.expected.terminal,
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: [row.expected.terminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  // The isolation contract: the app's own probe observations judged
  // against the row's declared app contract (typed rejection, zero
  // disclosure, the miss-indistinguishability discipline).
  const appCriteria = verifyIsolationContract({
    expected: row.expected.appObservations,
    observations,
  });
  const isolationPassed = appCriteria.every((criterion) => criterion.status === "PASS");

  return {
    evidence: harness.evidence(),
    passed: harnessPassed && isolationPassed,
    appCriteria,
    observations,
    probeFacts: observations.map((obs) => ({
      rowId: row.rowId,
      probeKind: obs.kind,
      rejection: obs.rejection,
      httpStatus: obs.httpStatus,
      latencyMs: obs.latencyMs,
    })),
  };
}
