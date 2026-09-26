/**
 * The compatibility evidence store port — FILE-BASED by program rule
 * (the work order's boundary: "No DB migrations (evidence records are
 * files per the evidence authority pattern)").
 *
 * Evidence records are durable JSON documents (one file per record),
 * read-only to this layer: the store LISTS and GETS records; there is
 * no write/delete operation on the port by construction — recording a
 * new proof's evidence is the proof harness's (and ultimately the
 * Lead's) act, never the projection's.
 */

import type { CompatibilityEvidenceRecord } from "../domain/evidence";

/** The read-only evidence-record store. */
export interface CompatibilityEvidenceStore {
  /** Every valid record in the store, in stable (recordId) order. */
  list(): Promise<readonly CompatibilityEvidenceRecord[]>;
  /** One record by id; null when absent (a miss is honest, never an error). */
  get(recordId: string): Promise<CompatibilityEvidenceRecord | null>;
}
