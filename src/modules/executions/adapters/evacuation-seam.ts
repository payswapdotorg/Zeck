/**
 * The lease evacuation seam (executions module adapter; WORK-048 /
 * D-07 — the module-side implementation of the platform recovery
 * plane's `LeaseEvacuationSeam`, the ONLY new seam D-07 consumes).
 *
 * The single lease system stays the executions module's long-running
 * domain (owner, monotonic epoch, guarded force-release). Regional
 * worker evacuation needs exactly one capability from it that the
 * worker-facing `WorkerLeaseAuthority` deliberately does not expose:
 * an AUTHORITY-side force release of a worker's live lease (the same
 * governed capability human interruption and termination already
 * use — "the human authority trumps worker ownership, never
 * silently"). This adapter exposes that existing capability to the
 * recovery tooling through the neutral platform seam type.
 *
 * Semantics are UNCHANGED and stay inside the frozen vocabulary:
 * the release cause is the existing `human-interruption` class (an
 * operator authority releasing a worker's lease); the evacuation
 * context is recorded where worker-plane coordination lives (the
 * claim's abandon detail), never in the frozen lease domain.
 */

import type { LeaseEvacuationSeam } from "../../../platform/recovery/evacuation";
import type { LeaseRecord } from "../domain/lease";
import type { SqlLongRunningExecutionStore } from "./sql-long-running-store";

/**
 * The bounded cause recorded on the force release (inside the frozen
 * `LEASE_RELEASE_CAUSES` vocabulary; the operational context lives
 * in the worker-plane claim abandon detail, not the lease domain).
 */
const RELEASE_CAUSE = "human-interruption";

export function createLeaseEvacuationSeam(
  store: SqlLongRunningExecutionStore,
  options?: { readonly now?: () => Date },
): LeaseEvacuationSeam {
  const now = options?.now ?? (() => new Date());
  return {
    async forceRelease(input) {
      const live = await store.getLease(input.applicationId, input.executionId);
      if (live === null || live.releasedAt !== null) {
        // Idempotent: no live lease exists (never-held or already
        // released) — nothing to fence.
        return { released: false };
      }
      const released: LeaseRecord | null = await store.forceReleaseLease({
        applicationId: input.applicationId,
        executionId: input.executionId,
        cause: RELEASE_CAUSE,
        now: now().toISOString(),
      });
      return { released: released !== null && released.releasedAt !== null };
    },
  };
}
