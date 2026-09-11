/**
 * The audit projection service (audit module application layer;
 * WORK-059 / SEC-004).
 *
 * THE PROJECTION'S SINGLE WRITE PATH: `record` scrubs (defense in
 * depth — the seam observers scrub first, the service re-checks),
 * validates and appends through the durable store port. The service
 * is EVIDENCE-shaped: append + read + deterministic verification.
 * There is no admission, authorization or decision surface here
 * (architecture invariant 2 — proven by the architecture tests).
 *
 * DETERMINISTIC VERIFICATION: `verifyChain` pages through the full
 * durable chain and runs the pure domain verifier — the same records
 * always produce the same verdict (replayable by deterministic audit).
 */

import type { AuditDigestPort, AuditRecord, AuditSubmission, ChainVerification } from "../domain";
import {
  scrubAuditDetail,
  scrubAuditText,
  validateAuditSubmission,
  verifyAuditChain,
} from "../domain";
import type { AuditAppendOutcome, AuditListOptions, AuditRecordStore } from "../ports/audit-store";
import { AuditProjectionError } from "../ports/audit-store";

export interface AuditServiceOptions {
  readonly store: AuditRecordStore;
  readonly digest: AuditDigestPort;
}

export interface AuditService {
  /** Record one observed governed action (the projection write path). */
  record(submission: AuditSubmission): Promise<AuditAppendOutcome>;
  getRecord(applicationId: string, recordId: string): Promise<AuditRecord | null>;
  listRecords(applicationId: string, options?: AuditListOptions): Promise<readonly AuditRecord[]>;
  /** Deterministic full-chain verification (paged; pure verdict). */
  verifyChain(applicationId: string): Promise<ChainVerification>;
}

const PAGE_SIZE = 1000;

export function createAuditService(options: AuditServiceOptions): AuditService {
  const { store, digest } = options;

  return {
    async record(submission: AuditSubmission) {
      // Defense in depth: the seam observers scrub; the service's write
      // path re-checks (a submission that smuggled a secret-shaped key
      // or unbounded detail fails closed HERE, before the authority).
      const detail = scrubAuditDetail(submission.actionDetail);
      if (!detail.admissible) {
        throw new AuditProjectionError(
          `audit submission rejected at the scrub gate: ${detail.reason}`,
        );
      }
      const why = scrubAuditText(submission.rationale.why);
      const validated = validateAuditSubmission({
        ...submission,
        rationale: { ...submission.rationale, why },
        actionDetail: detail.detail,
      });
      try {
        return await store.appendRecord(validated);
      } catch (error) {
        throw new AuditProjectionError(
          "the audit projection failed to durably record the governed action",
          error,
        );
      }
    },

    async getRecord(applicationId: string, recordId: string) {
      return store.getRecord(applicationId, recordId);
    },

    async listRecords(applicationId: string, listOptions?: AuditListOptions) {
      return store.listRecords(applicationId, listOptions);
    },

    async verifyChain(applicationId: string): Promise<ChainVerification> {
      // Page through the durable chain by sequence (bounded memory),
      // then verify the whole chain with the pure domain verifier.
      const records: AuditRecord[] = [];
      let cursor = 1;
      for (;;) {
        const page = await store.listRecords(applicationId, {
          fromSequence: cursor,
          limit: PAGE_SIZE,
        });
        records.push(...page);
        if (page.length < PAGE_SIZE) {
          break;
        }
        cursor = (page[page.length - 1] as AuditRecord).chainSequence + 1;
      }
      return verifyAuditChain(records, { digest });
    },
  };
}
