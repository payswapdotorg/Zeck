/**
 * Customer-runner environment provider adapter (sandbox module; WORK-019,
 * ENV-003).
 *
 * Implements the neutral `SandboxProvider` port for the `customer-runner`
 * environment kind — the customer-controlled execution substrate. The
 * adapter is the BRIDGE between the sandbox service's dispatch and the
 * runner fleet's governed lifecycle:
 *
 * ```text
 * sandbox service (admitted snapshot, dispatch claim)
 *   → provider.execute(spec)
 *       → fleet.selectEligibleRunner   (deterministic eligible choice)
 *       → fleet.assignRunner           (idempotent key `runner-assign:<sandboxId>`,
 *                                      health/trust/capability-gated, exclusive)
 *       → fleet.dispatchAssignment     (the one-shot handoff claim)
 *       → channel.deliverHandoff       (the REQUIRED neutral transport seam —
 *                                      the runner executes the ADMITTED work
 *                                      remotely; disconnects/reconnects are
 *                                      adapter mechanics)
 *       → fleet.reportResult           (the one-shot outcome; authorization-
 *                                      and lease-bounded)
 *   → observation (the sandbox-axis outcome of the remote execution)
 * ```
 *
 * Identity preservation (the Work Order's execution-handoff rule): the
 * assignment is keyed by the PARENT SANDBOX identity — a retry of the same
 * logical dispatch replays the SAME assignment and the SAME handoff; a
 * reconnect re-binds to the SAME assignment (the channel adapter owns the
 * mechanics). No path in this adapter can create a second execution or a
 * second assignment for one logical dispatch (M9/M11).
 *
 * The untrusted boundary (the Work Order's security model): everything the
 * runner receives is the SANITIZED admitted snapshot (task argv + explicit
 * public env, limits, network allowlist, opaque refs, secret REFERENCES);
 * everything the runner returns is a sandbox-axis observation that the
 * fleet validates and terminalizes. The runner can never touch an
 * authority surface.
 */

import { PlatformError } from "../../../shared/errors";
import type { RunnerFleetService } from "../application/runner-fleet";
import type { SandboxEnvironmentKind } from "../domain/environment";
import type { RunnerAssignmentRecord, RunnerHandoff, RunnerResultReport } from "../domain/runner";
import type { RunnerChannel } from "../ports/runner-channel";
import type {
  SandboxExecutionObservation,
  SandboxProvider,
  SandboxRuntimeSpec,
} from "../ports/sandbox-provider";
import type { SandboxStore } from "../ports/sandbox-store";
import { failClosed } from "./microvm-provider";

export interface CustomerRunnerSandboxProviderOptions {
  /** The runner fleet service (the governed assignment authority). */
  readonly fleet: RunnerFleetService;
  /** The REQUIRED neutral transport seam to customer runners. */
  readonly channel: RunnerChannel;
  /** The sandbox module's own store (the admitted parent sandbox row). */
  readonly sandboxStore: SandboxStore;
  /** Assignment lease duration (ms) for handoffs this provider creates. */
  readonly leaseDurationMs?: number;
}

export class CustomerRunnerSandboxProvider implements SandboxProvider {
  readonly runtimeKind: SandboxEnvironmentKind = "customer-runner";
  private readonly fleet: RunnerFleetService;
  private readonly channel: RunnerChannel;
  private readonly sandboxStore: SandboxStore;
  private readonly leaseDurationMs: number | undefined;

  constructor(options: CustomerRunnerSandboxProviderOptions) {
    this.fleet = options.fleet;
    this.channel = options.channel;
    this.sandboxStore = options.sandboxStore;
    this.leaseDurationMs = options.leaseDurationMs;
  }

  async execute(spec: SandboxRuntimeSpec): Promise<SandboxExecutionObservation> {
    const actor = {
      // The sandbox's own durable identity is the provenance actor (the
      // sandbox-service precedent: the substrate acts on behalf of the
      // admitted work, bound to the parent execution).
      actorId: spec.sandboxId,
      applicationId: spec.applicationId,
      tenantId: spec.tenantId,
    };

    // ----- 1. The admitted parent row (identity chain + environment). ------
    const sandbox = await this.sandboxStore.findSandbox(spec.applicationId, spec.sandboxId);
    if (sandbox === null) {
      return failClosed(
        "the parent sandbox execution row is unreadable; the customer-runner substrate fails closed",
      );
    }
    const environmentId = sandbox.environmentId;

    // ----- 2. Substrate-class requirements (descriptive matching). ---------
    // The environment's RUNTIME capability requirement was already resolved
    // by the capabilities AUTHORITY at admission; fleet matching is the
    // substrate-class match: the runner must declare the compute/memory
    // classes executing work always needs, plus network/filesystem classes
    // when the admitted spec uses them.
    const requiredCapabilities: string[] = ["customer-runner", "cpu", "memory"];
    if (spec.network.egress === "allowlist") {
      requiredCapabilities.push("network");
    }
    if (spec.filesystem.workspace !== "none") {
      requiredCapabilities.push("filesystem");
    }

    // ----- 3. Deterministic eligible-runner selection. ---------------------
    const runner = await this.fleet.selectEligibleRunner({
      applicationId: spec.applicationId,
      environmentId,
      requiredCapabilities,
    });
    if (runner === null) {
      return failClosed(
        "no eligible customer runner is available (authorized, healthy, capability-matching and free); the sandbox fails closed instead of dispatching to an ineligible runner",
      );
    }

    // ----- 4. The idempotent, exclusive, guarded assignment. ---------------
    let assignment: RunnerAssignmentRecord;
    try {
      assignment = await this.fleet.assignRunner(
        {
          applicationId: spec.applicationId,
          executionId: spec.executionId,
          sandboxId: spec.sandboxId,
          environmentId,
          runnerId: runner.id,
          requiredCapabilities,
          ...(this.leaseDurationMs === undefined ? {} : { leaseDurationMs: this.leaseDurationMs }),
        },
        `runner-assign:${spec.sandboxId}`,
        actor,
      );
    } catch (error) {
      // Typed assignment rejections (revocation races, health races, slot
      // races) are honest substrate failures — never silent fallbacks.
      return this.observationOfError(error, "the customer-runner assignment was rejected");
    }

    // ----- 5. The one-shot dispatch handoff. --------------------------------
    let handoff: RunnerHandoff;
    try {
      handoff = await this.fleet.dispatchAssignment(
        { applicationId: spec.applicationId, assignmentId: assignment.id },
        actor,
      );
    } catch (error) {
      return this.observationOfError(error, "the customer-runner dispatch handoff failed");
    }

    // ----- 6. Remote execution through the REQUIRED neutral channel. -------
    let report: RunnerResultReport;
    try {
      report = await this.channel.deliverHandoff(handoff);
    } catch (error) {
      report = {
        outcomeClass: "sandbox-failure" as const,
        outputDigest: null,
        output: null,
        usageMicroUsd: null,
        failure: {
          failureClass: "adapter-error" as const,
          message:
            error instanceof Error
              ? `the runner channel failed to deliver the handoff: ${error.message}`
              : "the runner channel failed to deliver the handoff",
          retryable: true,
        },
      };
    }

    // ----- 7. The one-shot result report (authorization/lease-bounded). ----
    try {
      await this.fleet.reportResult(
        { applicationId: spec.applicationId, assignmentId: assignment.id, report },
        actor,
      );
    } catch (error) {
      // A report rejection (lease expiry, revocation mid-flight) is a
      // durable, honest failure — the observation mirrors it.
      return this.observationOfError(error, "the customer-runner result report was rejected");
    }

    return {
      outcomeClass: report.outcomeClass,
      outputDigest: report.outputDigest,
      output: report.output,
      usageMicroUsd: report.usageMicroUsd,
      failure: report.failure,
    };
  }

  /** Map a typed fleet rejection onto the honest sandbox-axis failure. */
  private observationOfError(error: unknown, context: string): SandboxExecutionObservation {
    const timedOut = error instanceof PlatformError && error.code === "EXPIRED";
    return {
      outcomeClass: "sandbox-failure",
      outputDigest: null,
      output: null,
      usageMicroUsd: null,
      failure: {
        failureClass: timedOut ? "timeout" : "adapter-error",
        message:
          error instanceof PlatformError
            ? `${context}: ${error.message}`
            : `${context}: ${error instanceof Error ? error.message : String(error)}`,
        retryable: error instanceof PlatformError ? error.retryable : true,
      },
    };
  }
}
