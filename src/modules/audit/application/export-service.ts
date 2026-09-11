/**
 * The compliance export service (audit module application layer;
 * WORK-059 / SEC-004).
 *
 * GOVERNED, BOUNDED EXPORT: the operator (or a compliance automation
 * principal) requests an export of a bounded sequence window; the
 * service reads the window (one statement-snapshot read), assembles
 * the typed export with the chain proof and the purge manifests
 * covering gaps inside the window, appends the `audit.export-generated`
 * evidence record (the export itself is a governed action — WHO
 * exported WHAT window WHEN and WHY), and returns the verifiable
 * export object. Round-trip verification (`verifyExport`) is
 * deterministic and pure.
 *
 * The evidence record's identity content is the deterministic request
 * parameters (key/purpose/window): an idempotent retry converges to a
 * bounded no-op even when the chain head has advanced between
 * attempts (the head attestation is carried by the export, not the
 * record identity).
 */

import type { AuditDigestPort, ComplianceExport, ExportVerification } from "../domain";
import { AUDIT_BOUNDS, buildComplianceExport, verifyComplianceExport } from "../domain";
import type { AuditRecordStore } from "../ports/audit-store";
import { AuditProjectionError } from "../ports/audit-store";

export interface ComplianceExportRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  /** WHO: the requesting principal. */
  readonly requestedBy: string;
  /** WHY: the bounded export purpose. */
  readonly purpose: string;
  /** The requested window (inclusive sequence bounds; from >= 1). */
  readonly fromSequence: number;
  readonly toSequence: number;
  /** The caller's idempotency key for the export operation. */
  readonly idempotencyKey: string;
  readonly environment: string;
}

export interface ComplianceExportServiceOptions {
  readonly store: AuditRecordStore;
  readonly digest: AuditDigestPort;
  readonly now: () => Date;
}

export interface ComplianceExportService {
  /** Generate the governed, bounded export (and record its evidence). */
  exportRecords(request: ComplianceExportRequest): Promise<ComplianceExport>;
  /** Deterministic verification of an export value (pure). */
  verifyExport(value: unknown): ExportVerification;
}

export function createComplianceExportService(
  options: ComplianceExportServiceOptions,
): ComplianceExportService {
  const { store, digest, now } = options;

  return {
    async exportRecords(request: ComplianceExportRequest): Promise<ComplianceExport> {
      if (
        !Number.isInteger(request.fromSequence) ||
        !Number.isInteger(request.toSequence) ||
        request.fromSequence < 1 ||
        request.toSequence < request.fromSequence
      ) {
        throw new AuditProjectionError(
          "export request window must satisfy 1 <= fromSequence <= toSequence",
        );
      }
      // The requested window must fit ONE bounded export (larger
      // scopes page by sequence range — the export is bounded
      // evidence, not a dump).
      if (request.toSequence - request.fromSequence + 1 > AUDIT_BOUNDS.exportRecordsMax) {
        throw new AuditProjectionError(
          `export request window (${request.toSequence - request.fromSequence + 1} records) exceeds the bounded export size (${AUDIT_BOUNDS.exportRecordsMax}); page by sequence range`,
        );
      }
      if (request.purpose.length === 0 || request.purpose.length > AUDIT_BOUNDS.whyMax) {
        throw new AuditProjectionError("export purpose must be bounded non-empty text");
      }
      if (
        request.requestedBy.length === 0 ||
        request.requestedBy.length > AUDIT_BOUNDS.actorIdMax
      ) {
        throw new AuditProjectionError("export requester must be a bounded non-empty identity");
      }

      // One statement-snapshot read of the bounded window.
      const records = await store.listRecords(request.applicationId, {
        fromSequence: request.fromSequence,
        toSequence: request.toSequence,
        limit: AUDIT_BOUNDS.exportRecordsMax,
      });
      if (records.length > AUDIT_BOUNDS.exportRecordsMax) {
        throw new AuditProjectionError("export window exceeds the bounded export size");
      }

      // The purge manifests covering gaps inside the window (the
      // purge evidence may live outside the window itself).
      const manifests = await store.listPurgeManifests(request.applicationId, {
        fromSequence: request.fromSequence,
        toSequence: request.toSequence,
      });

      const head = await store.chainHead(request.applicationId);
      const firstRecord = records[0];
      const lastRecord = records[records.length - 1];
      const generatedAt = now().toISOString();

      const predecessorSequence = firstRecord === undefined ? 0 : firstRecord.chainSequence - 1;
      let windowPredecessorDigest: string | null = null;
      if (predecessorSequence === 0) {
        windowPredecessorDigest = "0".repeat(64);
      } else {
        // Attested boundary: the predecessor digest as read from the
        // durable chain at generation time.
        const predecessorPage = await store.listRecords(request.applicationId, {
          fromSequence: predecessorSequence,
          toSequence: predecessorSequence,
          limit: 1,
        });
        const predecessor = predecessorPage[0];
        windowPredecessorDigest = predecessor?.recordDigest ?? null;
      }

      const exportObject = buildComplianceExport(
        {
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          generatedBy: request.requestedBy,
          purpose: request.purpose,
          generatedAt,
          range: {
            fromSequence: firstRecord?.chainSequence ?? request.fromSequence,
            toSequence: lastRecord?.chainSequence ?? request.toSequence,
          },
          records,
          purgeManifests: manifests,
          chainProof: {
            genesis: "0".repeat(64),
            windowPredecessorDigest,
            windowPredecessorSequence: predecessorSequence,
            headSequenceAtGeneration: head?.lastSequence ?? 0,
            headDigestAtGeneration: head?.lastDigest ?? null,
            recordDigests: records.map((record) => record.recordDigest),
          },
        },
        digest,
      );

      // The export is a governed action: evidence record (identity
      // covers the deterministic request parameters).
      try {
        await store.appendRecord({
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          environment: request.environment,
          actor: { actorId: request.requestedBy, actorKind: "service-principal" },
          action: {
            kind: "audit.export-generated",
            command: "compliance-export",
            operationKey: request.idempotencyKey,
          },
          target: { kind: "application", id: request.applicationId },
          provenance: { seam: "audit.export", sourceRecordId: exportObject.exportId },
          rationale: { why: request.purpose },
          occurredAt: generatedAt,
          actionDetail: {
            fromSequence: exportObject.range.fromSequence,
            toSequence: exportObject.range.toSequence,
            exportId: exportObject.exportId,
          },
        });
      } catch (error) {
        throw new AuditProjectionError(
          "the audit projection failed to record the export evidence (fail closed)",
          error,
        );
      }

      return exportObject;
    },

    verifyExport(value: unknown): ExportVerification {
      return verifyComplianceExport(value, digest);
    },
  };
}
