/**
 * Validation run identity contract (VAL-001, acceptance criterion 4).
 *
 * Every validation run must carry a stable identifier and enough metadata
 * to reproduce the experiment later (application revision, Zeck revision,
 * corpus revision, environment descriptor, inputs, policy/capabilities,
 * model routing, tools, retries, outputs, cost and latency are all part of
 * the evaluation discipline the Tech Lead contract mandates). This module
 * defines the contract and derives the deterministic run id: the identity
 * is a pure SHA-256 digest of the canonical run configuration — the same
 * configuration always yields the same id, and any change to a
 * reproduction-relevant field yields a different id.
 */

import { createHash } from "node:crypto";

/** The reproduction-relevant environment descriptor (no secrets). */
export interface RunEnvironmentDescriptor {
  readonly runtime: string;
  readonly toolchain: string;
  readonly database: string;
  readonly configuration: Readonly<Record<string, string>>;
}

/** The complete metadata every validation run must record. */
export interface RunMetadata {
  readonly program: string;
  readonly workOrder: string;
  /** The exact Zeck repository revision the run executes against. */
  readonly baseRevision: string;
  /** The revision of the validation application under test. */
  readonly applicationRevision: string;
  /** The revision of the golden corpus the run consumes. */
  readonly corpusRevision: string;
  /** The customer-style integration surface the application rides. */
  readonly integrationSurface: string;
  readonly environment: RunEnvironmentDescriptor;
  /** Wall-clock observation timestamp (metadata only — never part of the id). */
  readonly observedAt: string;
}

/** A field path that was missing or empty in a run metadata record. */
export interface RunMetadataViolation {
  readonly path: string;
  readonly reason: "missing" | "empty";
}

/** The required non-empty scalar fields of run metadata. */
const REQUIRED_STRING_FIELDS = [
  "program",
  "workOrder",
  "baseRevision",
  "applicationRevision",
  "corpusRevision",
  "integrationSurface",
  "observedAt",
] as const;

/** The required non-empty fields of the environment descriptor. */
const REQUIRED_ENVIRONMENT_FIELDS = ["runtime", "toolchain", "database"] as const;

/**
 * Validate that a run metadata record carries every reproduction-relevant
 * field. A run without complete metadata is not admissible evidence.
 */
export function checkRunMetadata(metadata: RunMetadata): readonly RunMetadataViolation[] {
  const violations: RunMetadataViolation[] = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = metadata[field];
    if (value === undefined || value === null) {
      violations.push({ path: field, reason: "missing" });
    } else if (typeof value !== "string" || value.length === 0) {
      violations.push({ path: field, reason: "empty" });
    }
  }
  for (const field of REQUIRED_ENVIRONMENT_FIELDS) {
    const value = metadata.environment?.[field];
    if (value === undefined || value === null) {
      violations.push({ path: `environment.${field}`, reason: "missing" });
    } else if (typeof value !== "string" || value.length === 0) {
      violations.push({ path: `environment.${field}`, reason: "empty" });
    }
  }
  return violations;
}

/**
 * Derive the deterministic validation run id.
 *
 * The id digests the canonical JSON of the run CONFIGURATION — everything
 * needed to reproduce the run — and deliberately excludes the observation
 * timestamp so re-running the same configuration against the same
 * revisions yields the same identity.
 */
export function deriveRunId(metadata: RunMetadata): string {
  const configuration = {
    program: metadata.program,
    workOrder: metadata.workOrder,
    baseRevision: metadata.baseRevision,
    applicationRevision: metadata.applicationRevision,
    corpusRevision: metadata.corpusRevision,
    integrationSurface: metadata.integrationSurface,
    environment: {
      runtime: metadata.environment.runtime,
      toolchain: metadata.environment.toolchain,
      database: metadata.environment.database,
      configuration: sortedRecord(metadata.environment.configuration),
    },
  };
  const canonical = canonicalJson(configuration);
  return `val-run-${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Stable key order for record serialization. */
function sortedRecord(record: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key] ?? "";
  }
  return out;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
