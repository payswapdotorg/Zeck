/**
 * The legal-hold service (audit module application layer; WORK-059 /
 * SEC-004).
 *
 * A hold placed on a scope SUSPENDS retention expiry for that scope
 * (the governed purge anti-joins active holds at the store level).
 * Holds are themselves audited: placement and release append evidence
 * records inside the same transaction as the hold write (governed
 * procedures, architecture invariant 4).
 */

import type { LegalHoldRecord, PlaceHoldInput } from "../domain";
import { scrubAuditText } from "../domain";
import type { LegalHoldStore } from "../ports/audit-store";

export interface LegalHoldServiceOptions {
  readonly holds: LegalHoldStore;
}

export interface LegalHoldService {
  /** Place a hold on a scope (idempotent per active scope+rationale). */
  placeHold(input: Omit<PlaceHoldInput, "reason"> & { reason: string }): Promise<LegalHoldRecord>;
  /** Release a hold (fail closed on unknown/already-released). */
  releaseHold(applicationId: string, holdId: string, releasedBy: string): Promise<LegalHoldRecord>;
  getHold(applicationId: string, holdId: string): Promise<LegalHoldRecord | null>;
  /** The active holds for a scope (the purge suspension surface). */
  listActiveHolds(applicationId: string): Promise<readonly LegalHoldRecord[]>;
}

export function createLegalHoldService(options: LegalHoldServiceOptions): LegalHoldService {
  const { holds } = options;

  return {
    async placeHold(input) {
      // The hold reason is bounded text: scrubbed before it becomes
      // audit evidence (defense in depth — the store validates too).
      return holds.placeHold({ ...input, reason: scrubAuditText(input.reason) });
    },

    async releaseHold(applicationId: string, holdId: string, releasedBy: string) {
      return holds.releaseHold(applicationId, holdId, releasedBy);
    },

    async getHold(applicationId: string, holdId: string) {
      return holds.getHold(applicationId, holdId);
    },

    async listActiveHolds(applicationId: string) {
      return holds.listActiveHolds(applicationId);
    },
  };
}
