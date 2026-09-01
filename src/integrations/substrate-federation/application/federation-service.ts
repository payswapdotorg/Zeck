/**
 * Substrate-federation integration application (WORK-031, CSX-004).
 *
 * THE federation service: external compute systems register their
 * substrates through the capabilities module's PUBLIC substrate
 * registry — the ONE claim authority (the integration holds no
 * registry, no validation regime, no admission surface; everything is
 * consumed, nothing is duplicated). Submissions are fail-closed: an
 * invalid declaration never reaches durable state.
 */

import type { SubstrateRegistry } from "../../../modules/capabilities/public";
import { validateComputationalSubstrate } from "../../../modules/capabilities/public";
import type { ExternalSubstrateSubmission } from "../domain/submission";
import type { SubstrateOperatorAdapter } from "../ports/operator-adapter";

export interface SubstrateFederationDeps {
  /** The capabilities module's PUBLIC substrate registry (the authority). */
  readonly substrateRegistry: SubstrateRegistry;
}

export interface SubstrateFederationActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface SubstrateFederationService {
  /**
   * Submit one external substrate declaration. Validated by the
   * capabilities authority, published through the public registry —
   * convergent on identical versions, fail-closed on conflicts.
   */
  submit(
    submission: ExternalSubstrateSubmission,
    actor: SubstrateFederationActor,
  ): Promise<{ readonly status: "published" | "converged"; readonly substrateId: string }>;
  /**
   * Federate ALL declarations of one operator adapter into the
   * registry (the composition-root wiring for external operators).
   */
  federateOperator(
    adapter: SubstrateOperatorAdapter,
    actor: SubstrateFederationActor,
  ): Promise<
    readonly { readonly status: "published" | "converged"; readonly substrateId: string }[]
  >;
}

export function createSubstrateFederationService(
  deps: SubstrateFederationDeps,
): SubstrateFederationService {
  const { substrateRegistry } = deps;
  return {
    async submit(submission, actor) {
      // The capabilities module's authority validates (fail-closed).
      const check = validateComputationalSubstrate(submission.substrate);
      if (!check.valid) {
        throw new Error(`the external substrate declaration is invalid: ${check.reason}`);
      }
      const outcome = await substrateRegistry.publish(submission.substrate, {
        actorId: actor.actorId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
      });
      return { status: outcome.status, substrateId: outcome.record.substrateId };
    },

    async federateOperator(adapter, actor) {
      const submissions = await adapter.listSubstrates(actor.applicationId);
      const results: {
        readonly status: "published" | "converged";
        readonly substrateId: string;
      }[] = [];
      for (const submission of submissions) {
        results.push(await this.submit(submission, actor));
      }
      return results;
    },
  };
}
