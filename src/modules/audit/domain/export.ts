/**
 * Compliance evidence export (WORK-059 / SEC-004 domain).
 *
 * A BOUNDED, GOVERNED export of audit records with integrity digests
 * and a verifiable chain proof:
 *
 *  - bounded: at most `AUDIT_BOUNDS.exportRecordsMax` records and
 *    `exportManifestsMax` purge manifests per export (larger scopes
 *    page by sequence range — the export is evidence, not a dump);
 *  - integrity: every carried record is validated (both digests) by
 *    the verifier; the export object itself is content-addressed
 *    (`exportId` over the canonical export form) and carries
 *    `exportDigest` over its full content — any tampered byte fails
 *    verification;
 *  - chain proof: the exported window's linkage is verified with the
 *    same gap/manifest discipline as the full chain; the window
 *    boundary (the first record's predecessor) and the chain head at
 *    generation are ATTESTED by the generating service (read from the
 *    durable chain at generation time) — the verifier proves
 *    everything re-derivable from the export itself and never guesses
 *    what it cannot see (honest window semantics);
 *  - round-trip: serialize (canonical JSON) → deserialize → verify is
 *    deterministic and complete.
 */

import { canonicalAuditJson, isCanonicalizable } from "./canonical";
import type { PurgeManifest } from "./chain";
import { verifyAuditChain } from "./chain";
import type { AuditDigestPort, AuditRecord } from "./record";
import { validateAuditRecord } from "./record";
import { AUDIT_BOUNDS } from "./vocabularies";

/** The export chain proof: what the export attests about its window. */
export interface AuditChainProof {
  /** The genesis predecessor constant (verifiable invariant). */
  readonly genesis: string;
  /** The digest of the FIRST exported record's predecessor, as read from the durable chain at generation (attested). */
  readonly windowPredecessorDigest: string | null;
  /** The sequence of the first exported record's predecessor (0 = genesis). */
  readonly windowPredecessorSequence: number;
  /** The chain head sequence at generation time (attested). */
  readonly headSequenceAtGeneration: number;
  /** The chain head digest at generation time (attested). */
  readonly headDigestAtGeneration: string | null;
  /** Per-record digests, in sequence order (re-derived and compared by the verifier). */
  readonly recordDigests: readonly string[];
}

export interface ComplianceExport {
  /** Content-derived identity: digest over the canonical export form (identity-covered fields). */
  readonly exportId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** WHO requested the export. */
  readonly generatedBy: string;
  /** WHY: the bounded export purpose. */
  readonly purpose: string;
  /** When the export was generated. */
  readonly generatedAt: string;
  /** The exported window (inclusive sequence bounds). */
  readonly range: { readonly fromSequence: number; readonly toSequence: number };
  /** The bounded record set (sequence-ordered). */
  readonly records: readonly AuditRecord[];
  /** Purge manifests covering purged positions inside the window. */
  readonly purgeManifests: readonly PurgeManifest[];
  readonly chainProof: AuditChainProof;
  /** sha256 over the canonical FULL export (integrity). */
  readonly exportDigest: string;
}

export const EXPORT_VIOLATION_CODES = [
  "export-shape",
  "export-bounds",
  "export-chain",
  "export-identity-mismatch",
] as const;
export type ExportViolationCode = (typeof EXPORT_VIOLATION_CODES)[number];

export interface ExportViolation {
  readonly code: ExportViolationCode;
  readonly detail: string;
}

export interface ExportVerification {
  readonly ok: boolean;
  readonly violations: readonly ExportViolation[];
}

/** The identity-covered export form (everything except exportId/exportDigest). */
export type ComplianceExportForm = Omit<ComplianceExport, "exportId" | "exportDigest">;

/**
 * Build the export object (pure): assembles the typed export and its
 * digests from validated inputs. The caller (export service) supplies
 * validated records, manifests and the attested chain boundary.
 */
export function buildComplianceExport(
  form: ComplianceExportForm,
  digest: AuditDigestPort,
): ComplianceExport {
  if (form.records.length > AUDIT_BOUNDS.exportRecordsMax) {
    throw new Error(
      `export record count exceeds the bound (${form.records.length} > ${AUDIT_BOUNDS.exportRecordsMax})`,
    );
  }
  if (form.purgeManifests.length > AUDIT_BOUNDS.exportManifestsMax) {
    throw new Error(
      `export purge-manifest count exceeds the bound (${form.purgeManifests.length} > ${AUDIT_BOUNDS.exportManifestsMax})`,
    );
  }
  if (!isCanonicalizable(form)) {
    throw new TypeError("export form is not canonicalizable");
  }
  const identityForm = {
    applicationId: form.applicationId,
    tenantId: form.tenantId,
    generatedBy: form.generatedBy,
    purpose: form.purpose,
    range: form.range,
    records: form.records,
    purgeManifests: form.purgeManifests,
    chainProof: form.chainProof,
  };
  const exportId = digest.sha256Hex(canonicalAuditJson(identityForm));
  const full = { ...form, exportId };
  return { ...full, exportDigest: digest.sha256Hex(canonicalAuditJson(full)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DETAIL_MAX = 300;

function detail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

/**
 * Total, deterministic verification of a (deserialized) compliance
 * export:
 *
 *  1. shape + bounds (bounded record/manifest counts, ordered window);
 *  2. every record validates (both digests — tamper detection);
 *  3. the recordDigests proof matches the carried records;
 *  4. the window's chain linkage verifies (gaps must be manifest-covered);
 *  5. the export identity (`exportId`) and integrity (`exportDigest`)
 *     cover the carried content.
 */
export function verifyComplianceExport(
  value: unknown,
  digest: AuditDigestPort,
): ExportVerification {
  const violations: ExportViolation[] = [];
  const reject = (code: ExportViolationCode, text: string): void => {
    violations.push({ code, detail: detail(text) });
  };

  if (!isRecord(value)) {
    reject("export-shape", "compliance export must be an object");
    return { ok: false, violations };
  }
  const exportValue = value;

  for (const field of ["applicationId", "tenantId", "generatedBy", "purpose", "generatedAt"]) {
    if (typeof exportValue[field] !== "string" || (exportValue[field] as string).length === 0) {
      reject("export-shape", `export field "${field}" must be a non-empty string`);
    }
  }
  for (const field of ["exportId", "exportDigest"]) {
    const fieldValue = exportValue[field];
    if (typeof fieldValue !== "string" || !/^[0-9a-f]{64}$/.test(fieldValue)) {
      reject("export-shape", `export field "${field}" must be a sha256 hex digest`);
    }
  }
  if (!isRecord(exportValue.range)) {
    reject("export-shape", "export range must be an object");
    return { ok: false, violations };
  }
  const fromSequence = exportValue.range.fromSequence;
  const toSequence = exportValue.range.toSequence;
  if (
    !Number.isInteger(fromSequence) ||
    !Number.isInteger(toSequence) ||
    (fromSequence as number) < 1 ||
    (toSequence as number) < (fromSequence as number)
  ) {
    reject("export-shape", "export range must be [fromSequence, toSequence] with 1 <= from <= to");
  }
  if (!Array.isArray(exportValue.records) || !Array.isArray(exportValue.purgeManifests)) {
    reject("export-shape", "export records and purgeManifests must be arrays");
    return { ok: false, violations };
  }
  if ((exportValue.records as unknown[]).length > AUDIT_BOUNDS.exportRecordsMax) {
    reject("export-bounds", "export record count exceeds the bounded export size");
  }
  if ((exportValue.purgeManifests as unknown[]).length > AUDIT_BOUNDS.exportManifestsMax) {
    reject("export-bounds", "export manifest count exceeds the bounded export size");
  }

  // Records: validate each (tamper detection) and enforce window order.
  const records: AuditRecord[] = [];
  let previousSequence = 0;
  for (const recordValue of exportValue.records as unknown[]) {
    try {
      const record = validateAuditRecord(recordValue, digest);
      if (record.chainSequence <= previousSequence) {
        reject(
          "export-chain",
          `export records must be ordered by sequence (got ${record.chainSequence} after ${previousSequence})`,
        );
      }
      previousSequence = record.chainSequence;
      records.push(record);
    } catch (error) {
      reject("export-chain", `record failed validation: ${String(error)}`);
    }
  }

  // The proof's recordDigests must match the carried records exactly.
  const proof = exportValue.chainProof;
  if (!isRecord(proof) || !Array.isArray(proof.recordDigests)) {
    reject("export-shape", "export chainProof.recordDigests must be an array");
  } else {
    const carried = records.map((record) => record.recordDigest);
    const declared = (proof.recordDigests as unknown[]).map(String);
    if (!carriedDigestsMatch(carried, declared)) {
      reject("export-chain", "the chainProof recordDigests do not match the carried records");
    }
    if (typeof proof.genesis === "string" && proof.genesis !== "0".repeat(64)) {
      reject("export-chain", "the chainProof genesis must be the genesis constant");
    }
  }

  // Window linkage: gaps inside the window must be manifest-covered.
  const windowFrom =
    typeof fromSequence === "number" && Number.isInteger(fromSequence) ? fromSequence : 1;
  const window = verifyAuditChain(records, {
    digest,
    manifests: exportValue.purgeManifests as readonly PurgeManifest[],
    fromSequence: windowFrom,
  });
  for (const violation of window.violations) {
    reject("export-chain", `${violation.code}: ${violation.detail}`);
  }

  // Identity + integrity of the export object itself.
  const {
    exportId: claimedExportId,
    exportDigest: claimedExportDigest,
    ...form
  } = exportValue as unknown as ComplianceExport;
  try {
    const identityForm = {
      applicationId: form.applicationId,
      tenantId: form.tenantId,
      generatedBy: form.generatedBy,
      purpose: form.purpose,
      range: form.range,
      records: form.records,
      purgeManifests: form.purgeManifests,
      chainProof: form.chainProof,
    };
    const computedExportId = digest.sha256Hex(canonicalAuditJson(identityForm));
    if (computedExportId !== claimedExportId) {
      reject("export-identity-mismatch", "export content does not digest to the claimed exportId");
    }
    const computedExportDigest = digest.sha256Hex(
      canonicalAuditJson({ ...form, exportId: claimedExportId }),
    );
    if (computedExportDigest !== claimedExportDigest) {
      reject(
        "export-identity-mismatch",
        "export content does not digest to the claimed exportDigest (tampered export)",
      );
    }
  } catch (error) {
    reject("export-identity-mismatch", `export digest computation failed: ${String(error)}`);
  }

  return { ok: violations.length === 0, violations };
}

function carriedDigestsMatch(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
