/**
 * Models dispatch-seam adapter (policies module; WORK-007).
 *
 * Implements the models module's REQUIRED `DispatchAdmission` port (WORK-003
 * shipped it REQUIRED with no default-allow implementation — "production
 * composition roots inject the policy engine"; this adapter is that
 * injection) against the REAL policy authority. The model gateway consults
 * admission BEFORE any secret materialization or transport; provider/model
 * eligibility is decided by the effective policy here.
 *
 * Type-only coupling to `models/public` (zero runtime dependency).
 */

import type { DispatchAdmission } from "../../models/public";
import type { PolicyAuthority } from "../ports/policy-authority";

export function createDispatchAdmission(authority: PolicyAuthority): DispatchAdmission {
  return {
    async admit(input) {
      const result = await authority.admitDispatch({
        context: {
          tenantId: input.tenantId,
          applicationId: input.applicationId,
        },
        facts: {
          provider: input.rail,
          model: input.request.model,
        },
      });
      if (result.allowed) {
        return { allowed: true } as const;
      }
      return {
        allowed: false,
        reason:
          result.reason ?? result.denial?.message ?? "dispatch denied by the effective policy",
      } as const;
    },
  };
}
