/**
 * Append-only run-record storage (VAL-004, acceptance criterion 7).
 *
 * The store NEVER rewrites or deletes: every seal is appended with its
 * (runId, revision) identity; corrections appear as higher revisions
 * while historical revisions stay readable. Two implementations: the
 * in-memory store (tests, single-process analysis) and the JSONL store
 * (durable export — one canonical JSON line per revision).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { type ValidationRunRecord, validateRunRecord } from "./record";

/** The append-only run-record store contract. */
export interface RunRecordStore {
  /** Append a sealed revision (runId+revision must be new). */
  append(record: ValidationRunRecord): void;
  /** All revisions of one run, ascending. */
  revisionsOf(runId: string): readonly ValidationRunRecord[];
  /** The latest revision of one run (undefined when absent). */
  latest(runId: string): ValidationRunRecord | undefined;
  /** Every latest revision (the analysis set). */
  all(): readonly ValidationRunRecord[];
  /** Total stored revisions (append-only counter). */
  count(): number;
}

/** In-memory append-only store. */
export class InMemoryRunRecordStore implements RunRecordStore {
  private readonly byId = new Map<string, ValidationRunRecord[]>();

  append(record: ValidationRunRecord): void {
    assertAppendable(record, this.latest(record.runId));
    const list = this.byId.get(record.runId) ?? [];
    list.push(record);
    this.byId.set(record.runId, list);
  }

  revisionsOf(runId: string): readonly ValidationRunRecord[] {
    return [...(this.byId.get(runId) ?? [])];
  }

  latest(runId: string): ValidationRunRecord | undefined {
    const list = this.byId.get(runId);
    return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
  }

  all(): readonly ValidationRunRecord[] {
    const out: ValidationRunRecord[] = [];
    for (const list of this.byId.values()) {
      const latest = list.length > 0 ? list[list.length - 1] : undefined;
      if (latest !== undefined) {
        out.push(latest);
      }
    }
    return out;
  }

  count(): number {
    return [...this.byId.values()].reduce((sum, list) => sum + list.length, 0);
  }
}

/** Durable JSONL store: one canonical line per sealed revision. */
export class JsonlRunRecordStore implements RunRecordStore {
  private readonly memory = new InMemoryRunRecordStore();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        this.memory.append(JSON.parse(line) as ValidationRunRecord);
      }
    }
  }

  append(record: ValidationRunRecord): void {
    this.memory.append(record);
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  revisionsOf(runId: string): readonly ValidationRunRecord[] {
    return this.memory.revisionsOf(runId);
  }

  latest(runId: string): ValidationRunRecord | undefined {
    return this.memory.latest(runId);
  }

  all(): readonly ValidationRunRecord[] {
    return this.memory.all();
  }

  count(): number {
    return this.memory.count();
  }

  /** Reset the file (test isolation only — never in production paths). */
  unsafeClearForTests(): void {
    writeFileSync(this.path, "", "utf8");
  }
}

function assertAppendable(
  record: ValidationRunRecord,
  currentLatest: ValidationRunRecord | undefined,
): void {
  const violations = validateRunRecord(record);
  if (violations.length > 0) {
    const reasons = violations.map((v) => `${v.path}: ${v.reason}`).join("; ");
    throw new Error(`invalid run record ${record.runId} r${record.revision} — ${reasons}`);
  }
  if (currentLatest !== undefined && record.revision <= currentLatest.revision) {
    throw new Error(
      `append-only violation: ${record.runId} revision ${record.revision} must exceed ${currentLatest.revision}`,
    );
  }
  if (
    currentLatest !== undefined &&
    record.digest === currentLatest.digest &&
    record.revision > currentLatest.revision
  ) {
    // an identical digest at a higher revision is a no-op correction — allowed
  }
}
