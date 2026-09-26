/**
 * The file-based compatibility evidence store (the evidence authority
 * pattern applied to compatibility: records are FILES, never DB rows —
 * the work order's no-migrations boundary).
 *
 * One JSON file per record under a configured directory (the file name
 * is conventionally `<recordId>.json` but identity comes from the
 * document's own `recordId`, never the file name). Every file is
 * validated on read: a structurally invalid file is a named failure of
 * the whole store (fail closed — a corrupt record can never silently
 * disappear from a projection, and can never be interpreted loosely).
 *
 * The store is READ-ONLY: no write or delete operation exists. Proof
 * harnesses and the Lead produce record files; this layer only reads
 * and validates them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompatibilityEvidenceRecord, EvidenceRecordIssue } from "../domain/evidence";
import { validateCompatibilityEvidenceRecord } from "../domain/evidence";
import type { CompatibilityEvidenceStore } from "../ports/evidence-store";

export interface FileEvidenceStoreOptions {
  /** The directory holding one `<recordId>.json` file per record. */
  readonly directory: string;
}

/** An invalid evidence file (fail-closed, named — never a silent skip). */
export class InvalidEvidenceRecordFileError extends Error {
  readonly file: string;
  readonly issues: readonly EvidenceRecordIssue[];
  constructor(file: string, issues: readonly EvidenceRecordIssue[]) {
    super(
      `invalid compatibility evidence record file ${file}: ${issues
        .map((issue) => `${issue.field}: ${issue.issue}`)
        .join("; ")}`,
    );
    this.name = "InvalidEvidenceRecordFileError";
    this.file = file;
    this.issues = issues;
  }
}

/** Create the file-based evidence store (reads + validates on demand). */
export function createFileCompatibilityEvidenceStore(
  options: FileEvidenceStoreOptions,
): CompatibilityEvidenceStore {
  const directory = options.directory;
  const readAll = (): CompatibilityEvidenceRecord[] => {
    const records: CompatibilityEvidenceRecord[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const file = join(directory, entry.name);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const issues = validateCompatibilityEvidenceRecord(parsed);
      if (issues.length > 0) {
        throw new InvalidEvidenceRecordFileError(file, issues);
      }
      records.push(parsed as CompatibilityEvidenceRecord);
    }
    records.sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
    return records;
  };
  return {
    async list() {
      return readAll();
    },
    async get(recordId) {
      return readAll().find((record) => record.recordId === recordId) ?? null;
    },
  };
}
