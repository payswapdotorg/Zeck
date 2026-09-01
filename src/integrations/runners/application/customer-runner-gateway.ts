/**
 * Customer-runner gateway (runners integration application; WORK-019,
 * ENV-003).
 *
 * THE external adoption surface for customer-controlled runners: the
 * gateway validates external submissions (untrusted input, fail-closed)
 * and DELEGATES every authority decision to the sandbox module's public
 * runner-fleet service — the substrate-federation/payment-rails
 * discipline: the integration holds no registry, no admission, no
 * authorization logic; everything is consumed, nothing is duplicated.
 *
 * Boundary posture (the Work Order's security model):
 *   - registration maps the external submission onto the fleet's
 *     registration input; the token crosses as the fleet's input (hashed
 *     by the authority before storage) — the gateway never persists it;
 *   - authorization/revocation are EXPLICIT operator actions delegated
 *     through the authority (a registered runner is untrusted until then);
 *   - reconnect proof is delegated: the authority compares the presented
 *     token's fingerprint and re-binds the EXISTING assignment;
 *   - health observation can be driven by endpoint probes (the platform's
 *     view of reachability) but the fleet's freshness window remains the
 *     authority's arbitration;
 *   - the gateway holds no execution surface: no execution creation,
 *     transition or ledger call exists here (runners are a substrate).
 */

import type {
  RunnerAssignmentRecord,
  RunnerFleetService,
  RunnerRecord,
} from "../../../modules/sandbox/public";
import type { ExternalRunnerRegistration } from "../domain/submission";
import { validateExternalRunnerRegistration } from "../domain/submission";

export interface RunnerGatewayActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface CustomerRunnerGatewayDeps {
  /** The sandbox module's PUBLIC runner-fleet service (the authority). */
  readonly fleet: RunnerFleetService;
}

export interface CustomerRunnerGateway {
  /**
   * Register one external customer runner. Validated here (fail-closed),
   * delegated to the fleet authority — convergent on identical identity
   * cores, conflicting on different ones.
   */
  registerCustomerRunner(
    submission: ExternalRunnerRegistration,
    actor: RunnerGatewayActor,
  ): Promise<RunnerRecord>;
  /** The explicit operator authorization (delegated — never implicit). */
  authorizeCustomerRunner(
    input: { readonly applicationId: string; readonly runnerId: string },
    actor: RunnerGatewayActor,
  ): Promise<RunnerRecord>;
  /** Revocation (delegated; releases any active assignment). */
  revokeCustomerRunner(
    input: { readonly applicationId: string; readonly runnerId: string; readonly reason: string },
    actor: RunnerGatewayActor,
  ): Promise<RunnerRecord>;
  /**
   * Reconnect proof for one external runner: the authority compares the
   * presented token's fingerprint and re-binds the runner to its EXISTING
   * assignment (never a new one, never a second logical execution).
   */
  reconnectCustomerRunner(
    input: {
      readonly applicationId: string;
      readonly runnerId: string;
      readonly registrationToken: string;
    },
    actor: RunnerGatewayActor,
  ): Promise<{ readonly runner: RunnerRecord; readonly assignment: RunnerAssignmentRecord | null }>;
  /** Observe a runner heartbeat (delegated to the fleet's observation). */
  observeHeartbeat(
    input: { readonly applicationId: string; readonly runnerId: string },
    actor: RunnerGatewayActor,
  ): Promise<RunnerRecord>;
}

export function createCustomerRunnerGateway(
  deps: CustomerRunnerGatewayDeps,
): CustomerRunnerGateway {
  const { fleet } = deps;
  return {
    async registerCustomerRunner(submission, actor) {
      const check = validateExternalRunnerRegistration(submission);
      if (!check.valid) {
        throw new Error(`the external runner registration is invalid: ${check.reason}`);
      }
      if (
        submission.applicationId !== actor.applicationId ||
        submission.tenantId !== actor.tenantId
      ) {
        throw new Error(
          "external runner registration scope must match the acting principal (tenant/application mismatch is rejected before the authority is consulted)",
        );
      }
      // Delegation: the fleet authority validates again, hashes the token
      // and owns the durable identity (the gateway never persists it).
      return fleet.registerRunner(
        {
          applicationId: submission.applicationId,
          tenantId: submission.tenantId,
          environmentId: submission.environmentId,
          slug: submission.slug,
          name: submission.name,
          runnerVersion: submission.runnerVersion,
          declaredCapabilities: submission.declaredCapabilities,
          registrationToken: submission.registrationToken,
        },
        `runner-register:${submission.slug}`,
        {
          actorId: actor.actorId,
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
        },
      );
    },

    async authorizeCustomerRunner(input, actor) {
      return fleet.authorizeRunner(input, `runner-authorize:${input.runnerId}`, {
        actorId: actor.actorId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
      });
    },

    async revokeCustomerRunner(input, actor) {
      return fleet.revokeRunner(input, `runner-revoke:${input.runnerId}`, {
        actorId: actor.actorId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
      });
    },

    async reconnectCustomerRunner(input, actor) {
      return fleet.reconnectRunner(input, {
        actorId: actor.actorId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
      });
    },

    async observeHeartbeat(input, actor) {
      return fleet.observeHeartbeat(input, {
        actorId: actor.actorId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
      });
    },
  };
}
