/**
 * The file-based Demo Mirror record + entry source (PPR-018A scope
 * items 7/8 — the "sibling-consumer extension point" the PPR-017
 * delivery recorded: "real records ride the file-based store contract
 * (the dashboard's record source extends to it when the sibling
 * proofs land — one resolution path, no drift)").
 *
 * WHAT IT READS (all optional, all honest when absent):
 *  - EVIDENCE RECORDS: one JSON file per record in a configured
 *    evidence directory (the repo convention: deploy/evidence). A
 *    file contributes a record when it carries compatibility-record
 *    shape — either the whole document (a top-level `recordBasis`) or
 *    the work-order evidence wrapper (an `evidenceRecord` object with
 *    a `recordBasis`, the PPR-018 pattern). Files that are not
 *    record-shaped are other evidence kinds and are skipped (not
 *    defects — this source only claims the record-shaped ones).
 *    A record-shaped file that FAILS validation is a NAMED DEFECT
 *    (fail closed — a corrupt record never silently disappears).
 *  - DEMO ENTRIES: `demo-entry.json` files one level under a
 *    configured applications directory (the repo convention:
 *    compat/<application>/demo/demo-entry.json — the PPR-018 sibling
 *    pattern). Invalid entry files are NAMED DEFECTS.
 *
 * Everything is derived through the SAME resolution path as the
 * fixtures (demo-registry resolution, status derived from the record)
 * — one definition, no drift. The source adds NO status and NO verdict
 * of its own.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoMirrorEntry } from "../application/demo-registry";
import { validateDemoRegistry } from "../application/demo-registry";
import type { CompatibilityEvidenceRecord } from "../domain/evidence";
import { validateCompatibilityEvidenceRecord } from "../domain/evidence";
import type { DiscoveredEdgeInventory } from "../domain/execution-graph";
import { validateDiscoveredInventory } from "../domain/execution-graph";

/** A named source defect (fail-closed; surfaced, never skipped silently). */
export interface DemoRecordSourceIssue {
  readonly file: string;
  readonly issue: string;
}

export interface FileDemoRecordSourceOptions {
  /** The evidence directory to scan for record-shaped files (default: deploy/evidence). */
  readonly evidenceDirectory?: string;
  /** The applications root to scan for <app>/demo/demo-entry.json (default: compat). */
  readonly applicationsDirectory?: string;
  /** The entry file name inside <applicationsDirectory>/<app>/demo/ (default: demo-entry.json). */
  readonly entryFileName?: string;
}

/** One file-sourced record (the record + the file it came from + its discovery). */
export interface SourcedEvidenceRecord {
  readonly record: CompatibilityEvidenceRecord;
  /** The file the record was read from (evidence transparency). */
  readonly file: string;
  /**
   * The record's discovered edge inventory when the document carries
   * one (a top-level `discoveredInventory`, or the work-order wrapper's
   * sibling of its `evidenceRecord`); null when absent — the honest
   * unreconciled state certification refuses.
   */
  readonly discoveredInventory: DiscoveredEdgeInventory | null;
}

/** The composed file source: records + entries + named defects. */
export interface FileDemoRecordSource {
  /** Every valid record-shaped file, in stable recordId order. */
  readonly listRecords: () => readonly SourcedEvidenceRecord[];
  /** One record by id (null when absent — an honest miss). */
  readonly getRecord: (recordId: string) => CompatibilityEvidenceRecord | null;
  /** Every valid demo-entry file, in stable demoId order. */
  readonly listEntries: () => readonly { readonly entry: DemoMirrorEntry; readonly file: string }[];
  /** Every named defect (rendered verbatim; never silently skipped). */
  readonly issues: () => readonly DemoRecordSourceIssue[];
}

/** Does a parsed JSON document carry compatibility-record shape? (the candidate discriminator) */
function recordCandidateOf(
  parsed: unknown,
): { record: unknown; inventoryCandidate: unknown } | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const document = parsed as Record<string, unknown>;
  if (document.recordBasis === "fixture" || document.recordBasis === "live-proof") {
    return { record: document, inventoryCandidate: document.discoveredInventory };
  }
  const nested = document.evidenceRecord;
  if (
    typeof nested === "object" &&
    nested !== null &&
    ((nested as Record<string, unknown>).recordBasis === "fixture" ||
      (nested as Record<string, unknown>).recordBasis === "live-proof")
  ) {
    return {
      record: nested,
      inventoryCandidate: document.discoveredInventory,
    };
  }
  return null;
}

/** Create the file-based demo record + entry source (read-only, fail-closed). */
export function createFileDemoRecordSource(
  options: FileDemoRecordSourceOptions = {},
): FileDemoRecordSource {
  const evidenceDirectory = options.evidenceDirectory ?? join(process.cwd(), "deploy", "evidence");
  const applicationsDirectory = options.applicationsDirectory ?? join(process.cwd(), "compat");
  const entryFileName = options.entryFileName ?? "demo-entry.json";
  const issues: DemoRecordSourceIssue[] = [];
  const records = new Map<string, SourcedEvidenceRecord>();
  const entries: { entry: DemoMirrorEntry; file: string }[] = [];

  // --- evidence records -------------------------------------------------
  if (existsSync(evidenceDirectory)) {
    const files = readdirSync(evidenceDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    for (const name of files) {
      const file = join(evidenceDirectory, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch (error) {
        issues.push({ file, issue: `unparseable JSON (${String(error)})` });
        continue;
      }
      const candidate = recordCandidateOf(parsed);
      if (candidate === null) {
        continue; // not record-shaped — another evidence kind, not ours
      }
      const validation = validateCompatibilityEvidenceRecord(candidate.record);
      if (validation.length > 0) {
        issues.push({
          file,
          issue: `record-shaped but invalid: ${validation
            .map((issue) => `${issue.field}: ${issue.issue}`)
            .join("; ")}`,
        });
        continue;
      }
      const record = candidate.record as CompatibilityEvidenceRecord;
      // The discovered inventory: extracted when present, validated
      // fail-closed (an invalid inventory is a named defect, and the
      // record renders UNRECONCILED — never a silent pass).
      let discoveredInventory: DiscoveredEdgeInventory | null = null;
      if (candidate.inventoryCandidate !== undefined) {
        const inventoryIssues = validateDiscoveredInventory(candidate.inventoryCandidate);
        if (inventoryIssues.length > 0) {
          issues.push({
            file,
            issue: `invalid discovered inventory: ${inventoryIssues
              .map((issue) => `${issue.field}: ${issue.issue}`)
              .join("; ")}`,
          });
        } else {
          discoveredInventory = candidate.inventoryCandidate as DiscoveredEdgeInventory;
        }
      }
      if (records.has(record.recordId)) {
        issues.push({
          file,
          issue: `duplicate evidence record id ${record.recordId} (also present in ${records.get(record.recordId)?.file})`,
        });
        continue;
      }
      records.set(record.recordId, { record, file, discoveredInventory });
    }
  }

  // --- demo entries ------------------------------------------------------
  if (existsSync(applicationsDirectory)) {
    const applications = readdirSync(applicationsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const application of applications) {
      const file = join(applicationsDirectory, application, "demo", entryFileName);
      if (!existsSync(file)) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch (error) {
        issues.push({ file, issue: `unparseable JSON (${String(error)})` });
        continue;
      }
      const entry = parsed as DemoMirrorEntry;
      const registryIssues = validateDemoRegistry({ entries: [entry] });
      if (registryIssues.length > 0) {
        issues.push({
          file,
          issue: registryIssues
            .map((issue) =>
              issue.demoId === undefined ? issue.issue : `${issue.demoId}: ${issue.issue}`,
            )
            .join("; "),
        });
        continue;
      }
      if (entries.some((existing) => existing.entry.demoId === entry.demoId)) {
        issues.push({ file, issue: `duplicate demo id ${entry.demoId}` });
        continue;
      }
      entries.push({ entry, file });
    }
  }

  const recordList = [...records.values()].sort((a, b) =>
    a.record.recordId < b.record.recordId ? -1 : a.record.recordId > b.record.recordId ? 1 : 0,
  );
  const entryList = entries.sort((a, b) =>
    a.entry.demoId < b.entry.demoId ? -1 : a.entry.demoId > b.entry.demoId ? 1 : 0,
  );
  return {
    listRecords: () => [...recordList],
    getRecord: (recordId) => records.get(recordId)?.record ?? null,
    listEntries: () => [...entryList],
    issues: () => [...issues],
  };
}
