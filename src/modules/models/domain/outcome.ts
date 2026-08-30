/**
 * Dispatch outcome contracts (models module domain, CON-005).
 *
 * A model dispatch ends in exactly one of two durable outcome classes on the
 * PROVIDER axis:
 *
 *   * `provider-success` — the rail returned a well-formed response; this is
 *     transport success and carries NO quality judgement whatsoever
 *     (`spec/architecture.md` §18: "A successful provider call is never
 *     itself sufficient evidence of task correctness");
 *   * `provider-failure` — a normalized provider failure.
 *
 * Quality/verification outcomes are a DIFFERENT durable axis owned by the
 * verification authority (`VERIFICATION_FAILED` / `VERIFICATION_INCONCLUSIVE`
 * in the canonical taxonomy). The dispatch journal's CHECK constraint
 * (migration 0002) makes the separation physical: quality classes are not
 * representable on the provider axis.
 */

import type { ProviderFailure } from "./provider-failure";
import type { ModelResponse } from "./response";

export type ModelCallOutcome =
  | { readonly kind: "provider-success"; readonly response: ModelResponse }
  | { readonly kind: "provider-failure"; readonly failure: ProviderFailure };

/** Durable dispatch statuses recorded in the journal (migration 0002). */
export const DISPATCH_STATUSES = ["dispatching", "succeeded", "provider-failed", "denied"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** Outcome classes representable on the provider axis (CON-005 proof). */
export const PROVIDER_AXIS_OUTCOME_CLASSES = ["provider-success", "provider-failure"] as const;
export type ProviderAxisOutcomeClass = (typeof PROVIDER_AXIS_OUTCOME_CLASSES)[number];

export function outcomeClassOf(outcome: ModelCallOutcome): ProviderAxisOutcomeClass {
  return outcome.kind;
}
