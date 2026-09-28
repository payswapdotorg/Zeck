/**
 * The certified Demo Mirror run service (PPR-018A scope items 7/8;
 * ACR-006 §5 + ACR-007 §9).
 *
 * THE AUTHORIZATION MACHINE (binding; the five impossibility gates
 * live here and in the runner):
 *
 *  1. the bound record's DERIVED status must be AI_EXECUTION_COMPLETE
 *     (evaluateCompatibility — the ONE status source; a demo can never
 *     upgrade or assert one — the fixture record clause is structural:
 *     recordBasis "fixture" can never derive COMPLETE);
 *  2. the entry must bind a pinned runtime (runBinding.kind
 *     "pinned-runtime") — "none" bindings never run;
 *  3. a driver must be registered for the binding's runtime id —
 *     an unregistered runtime is an honest miss, never a fallback;
 *  4. the driver's pins must EXACTLY match the bound record's pins —
 *     unpinned application execution is refused (domain/runtime's
 *     fail-closed check, re-verified against the STARTED session's
 *     own descriptor);
 *  5. the started session's provider-credential erasure check must
 *     pass — a certified runtime with a present provider credential
 *     is refused (ACR-007 §5), naming the env-var NAMES found.
 *
 * When every gate passes, the service executes the entry's
 * representative task THROUGH THE PINNED RUNTIME (never a synthetic
 * response), correlates every edge execution through the read-only
 * ZeckTraceSource, and returns the honest run facts. FAIL task
 * outcomes still render (ran=true, succeeded=false — an honest
 * certified run that did not preserve behavior); a bypass observed
 * during the run is named in the run's reason, never hidden.
 */

import { checkProviderCredentialErasure } from "../domain/credential-erasure";
import type { CompatibilityEvidenceRecord, ZeckTraceFact } from "../domain/evidence";
import type { DiscoveredEdgeInventory } from "../domain/execution-graph";
import type { PinnedApplication } from "../domain/revisions";
import type { RunOutcome, TaskRunOutcome } from "../domain/runtime";
import { deriveRunOutcome, runtimeBindingIssues, runtimeBindingOf } from "../domain/runtime";
import { evaluateCompatibility } from "../domain/status";
import type { DemoRunResult } from "../ports/demo-run";
import type {
  PinnedRuntimeDriver,
  PinnedRuntimeSession,
  PinnedRuntimeTask,
} from "../ports/runtime";
import type { ZeckTraceSource } from "../ports/zeck-trace";
import { zeckTraceFactOf } from "../ports/zeck-trace";
import type { PinnedRuntimeRegistry } from "./runtime-registry";

/** The entry shape the service runs (the demo registry's own entry, structurally). */
export interface DemoRunEntry {
  readonly demoId: string;
  readonly evidenceRecordId: string;
  readonly representativeTask: { readonly title: string; readonly description: string };
  readonly runBinding:
    | { readonly kind: "none" }
    | { readonly kind: "pinned-runtime"; readonly runtime: string };
}

export interface DemoRunServiceOptions {
  /** The pinned-runtime registry (where work orders registered their drivers). */
  readonly registry: PinnedRuntimeRegistry;
  /** The read-only Zeck execution trace source (correlation, never fabrication). */
  readonly traceSource: ZeckTraceSource;
  /** The provider-credential env-var NAMES the erasure gate audits (proof configuration). */
  readonly credentialEnvVarNames: readonly string[];
  /** The injected clock (ISO strings). */
  readonly now: () => string;
}

/** Create the certified Demo Mirror run service. */
export function createDemoRunService(options: DemoRunServiceOptions) {
  const { registry, traceSource, credentialEnvVarNames, now } = options;

  const authorize = (
    entry: DemoRunEntry,
    record: CompatibilityEvidenceRecord,
    inventory: DiscoveredEdgeInventory | null = null,
  ): {
    readonly authorized: boolean;
    readonly reason: string;
    readonly driver?: PinnedRuntimeDriver;
  } => {
    const assessment = evaluateCompatibility(record, inventory);
    if (assessment.status !== "AI_EXECUTION_COMPLETE") {
      return {
        authorized: false,
        reason: `The bound compatibility evidence does not certify this application (status ${assessment.status}) — the Demo Mirror never runs an uncertified integration path, and never fabricates a result.`,
      };
    }
    if (entry.runBinding.kind !== "pinned-runtime") {
      return {
        authorized: false,
        reason:
          "The bound record is certified, but this demo entry declares no pinned application runtime to execute — bind the certified integration's runtime to enable the run.",
      };
    }
    const driver = registry.resolve(entry.runBinding.runtime);
    if (driver === null) {
      return {
        authorized: false,
        reason: `No pinned runtime is registered under "${entry.runBinding.runtime}" in this deployment surface — the certified integration's driver must be bound by the deployment composition (the harness ships the seam; the Lead binds the application runtimes at merge). A synthetic response is never substituted.`,
      };
    }
    const binding = runtimeBindingOf(record.pinnedApplication);
    const pinIssues = runtimeBindingIssues(binding, {
      applicationId: driver.identity.applicationId,
      pin: driver.pin,
    });
    if (pinIssues.length > 0) {
      return {
        authorized: false,
        reason: `The registered runtime's binding does not match the bound record's exact pins — unpinned application execution is refused: ${pinIssues
          .map((issue) => issue.issue)
          .join("; ")}`,
      };
    }
    return { authorized: true, reason: "certified", driver };
  };

  const correlate = async (
    session: PinnedRuntimeSession,
    taskRun: TaskRunOutcome,
  ): Promise<readonly ZeckTraceFact[]> => {
    const facts: ZeckTraceFact[] = [];
    for (const edge of taskRun.edgeExecutions) {
      const read = await traceSource.readExecutionTrace(
        session.descriptor.applicationId,
        edge.executionId,
      );
      facts.push(
        zeckTraceFactOf(edge.edgeId, session.descriptor.applicationId, edge.executionId, read),
      );
    }
    return facts;
  };

  return {
    /** The authorization machine (pure over the entry + record + registry). */
    authorize,

    /** Run the certified path (or refuse honestly — never a synthetic response). */
    async run(
      entry: DemoRunEntry,
      record: CompatibilityEvidenceRecord,
      inventory: DiscoveredEdgeInventory | null = null,
    ): Promise<DemoRunResult> {
      const authorization = authorize(entry, record, inventory);
      if (!authorization.authorized || authorization.driver === undefined) {
        return { ran: false, reason: authorization.reason };
      }
      const driver = authorization.driver;
      const binding = runtimeBindingOf(record.pinnedApplication);
      const runCorrelationId = `demo-run:${entry.demoId}:${now()}`;
      let session: PinnedRuntimeSession | null = null;
      try {
        session = await driver.start({
          expectedApplicationId: binding.applicationId,
          expectedPin: binding.pin,
          runCorrelationId,
          now,
        });
        // Re-verify the STARTED session's own descriptor against the
        // record's binding (the driver is a translation boundary; the
        // harness verifies what actually started).
        const sessionIssues = runtimeBindingIssues(binding, {
          applicationId: session.descriptor.applicationId,
          pin: session.descriptor.pin,
        });
        if (sessionIssues.length > 0) {
          return {
            ran: false,
            reason: `The started runtime session does not match the bound record's exact pins — the run is refused: ${sessionIssues
              .map((issue) => issue.issue)
              .join("; ")}`,
          };
        }
        // The provider-credential erasure gate (ACR-007 §5): the
        // certified runtime must not carry provider credentials.
        const erasure = checkProviderCredentialErasure(credentialEnvVarNames, {
          has: (name) =>
            session?.environmentFacts.find((fact) => fact.envVarName === name)?.present === true,
        });
        if (!erasure.erased) {
          return {
            ran: false,
            reason: `The pinned runtime's environment carries provider credentials (${erasure.presentNames.join(", ")}) — a certified run may not execute a credential-bearing runtime (ACR-007 §5 provider-erasure criterion). The run is refused; the env-var names are recorded, never their values.`,
          };
        }
        const task: PinnedRuntimeTask = {
          taskId: `demo:${entry.demoId}`,
          title: entry.representativeTask.title,
          instruction: entry.representativeTask.description,
        };
        const taskRun = await session.executeTask(task);
        const traces = await correlate(session, taskRun);
        const outcome: RunOutcome = deriveRunOutcome({
          succeeded: taskRun.succeeded,
          bypassObserved:
            (taskRun.egressObservation?.status ?? "not-run") === "violations-detected",
          unavailable: taskRun.unavailable ?? null,
        });
        return {
          ran: true,
          reason: `Certified run executed the pinned integration through the demo binding (outcome ${outcome}).`,
          outcome: {
            taskRun,
            traces,
            egressObservation: taskRun.egressObservation ?? null,
            credentialErasure: { erased: erasure.erased, facts: erasure.facts },
            runtime: {
              runtimeId: session.descriptor.runtimeId,
              pin: session.descriptor.pin,
            },
            measuredAt: now(),
          },
        };
      } finally {
        if (session !== null) {
          await session.stop();
        }
      }
    },
  };
}

export type DemoRunService = ReturnType<typeof createDemoRunService>;
export type { PinnedApplication };
