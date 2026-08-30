/**
 * Dispatch admission port (models module outbound).
 *
 * ENFORCES the frozen "policy before dispatch" invariant
 * (`spec/architecture.md` §2.4, architecture-lock invariant 3,
 * `IMPLEMENTATION.md` §7): no provider adapter receives executable work
 * before an admission decision allows it. There is deliberately NO default
 * allow-all implementation in this module — a gateway cannot be constructed
 * without an admission authority, so the invariant holds by construction
 * even before the `/policies` Work Order ships the real engine. Tests inject
 * allow/deny fakes; production composition roots inject the policy engine.
 */

import type { ModelRequest } from "../domain/request";

export interface AdmissionInput {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly connectionId: string;
  readonly rail: string;
  readonly request: ModelRequest;
}

export type AdmissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface DispatchAdmission {
  admit(input: AdmissionInput): Promise<AdmissionDecision>;
}
