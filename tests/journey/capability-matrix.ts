/**
 * PPR-003 — the capability coverage matrix.
 *
 * Every workload family in docs/developer/machine/capability-manifest.json
 * (the machine truth, validated by tests/unit/developer-docs/machine-schemas.test.ts)
 * maps to the four facts the work order requires:
 *
 *  (a) discovery location — the console playground route (when the
 *      target serves an experience composition) + the machine manifest
 *      (the repository-resident discovery location);
 *  (b) availability state — the manifest's recorded classification and
 *      availability string (runnable | provider-gated — the honest
 *      AVAILABILITY.md vocabulary, never reinterpreted);
 *  (c) example/runnable path — the family's example file, existence-
 *      checked against the repository tree;
 *  (d) provider/access explanation — the manifest's providerAccess
 *      rows for the family's gate (credential env var NAMES only),
 *      or the recorded provenance for runnable families.
 *
 * PROVIDER-GATED IS NEVER LIVE SUCCESS: the matrix's target-side probe
 * asserts the honest DISCLOSURE (the gate is visible where the surface
 * is served), never a fabricated completion. Matrix integrity failures
 * (missing family, non-existent example, invalid vocabulary, a
 * value-shaped gate) are matrix-integrity findings.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { harnessRepositoryRoot } from "./identity-gate";
import type { AvailabilityClassification, CapabilityMatrixRow } from "./types";

/** The machine manifest location (the pinned fact source). */
export const CAPABILITY_MANIFEST_PATH = "docs/developer/machine/capability-manifest.json";

/** The examples inventory (cross-checked example paths + classifications). */
const EXAMPLES_MANIFEST_PATH = "docs/developer/machine/examples-manifest.json";

/** The manifest's own family-record shape (the projection we read). */
interface ManifestFamily {
  readonly family: string;
  readonly example: string;
  readonly classification: string;
  readonly taskShape?: unknown;
  readonly capabilityRequirements: readonly string[];
  readonly gatedBy?: string;
  readonly availability: string;
}

interface ManifestProviderAccess {
  readonly provider: string;
  readonly credentialEnvVar: string;
  readonly recordedAvailability: string;
}

interface CapabilityManifestFile {
  readonly workloadFamilies: readonly ManifestFamily[];
  readonly providerAccess: readonly ManifestProviderAccess[];
  readonly disclosureRules?: string;
}

/** An env-var NAME shape (the names-never-values doctrine). */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Load + project the machine manifest (fail closed on shape drift). */
export function loadCapabilityManifestFile(): CapabilityManifestFile {
  const root = harnessRepositoryRoot();
  const raw = readFileSync(join(root, CAPABILITY_MANIFEST_PATH), "utf8");
  const parsed = JSON.parse(raw) as CapabilityManifestFile;
  if (
    !Array.isArray(parsed.workloadFamilies) ||
    !Array.isArray(parsed.providerAccess) ||
    parsed.workloadFamilies.length === 0
  ) {
    throw new Error(`${CAPABILITY_MANIFEST_PATH} is not a capability manifest (schema drift)`);
  }
  return parsed;
}

/**
 * The matrix-integrity problems of the derived rows (each becomes a
 * matrix-integrity finding when non-empty). The integrity checks are
 * the work order's own: every family maps to its four facts, the
 * classification vocabulary is the honest two-state set, gates are env
 * var NAMES (never values) and the example path EXISTS in the
 * repository tree.
 */
export function matrixIntegrityProblems(rows: readonly CapabilityMatrixRow[]): readonly string[] {
  const problems: string[] = [];
  for (const row of rows) {
    if (row.classification !== "runnable" && row.classification !== "provider-gated") {
      problems.push(
        `${row.family}: classification "${row.classification}" is outside the honest vocabulary (runnable | provider-gated)`,
      );
    }
    if (row.classification === "provider-gated" && row.gatedBy === null) {
      // The honest exception: a provider-gated family whose gate is
      // "no rail at all" (not a credential) records the NOT RUN
      // boundary in its availability string — the manifest's own
      // vocabulary for realtime-voice, browser-use and computer-use.
      if (!/NOT RUN/i.test(row.availability)) {
        problems.push(
          `${row.family}: provider-gated family carries neither a gate (gatedBy) nor the NOT RUN boundary vocabulary in its availability`,
        );
      }
    }
    if (row.gatedBy !== null && !ENV_NAME_PATTERN.test(row.gatedBy)) {
      problems.push(
        `${row.family}: gate "${row.gatedBy}" is not an env var NAME (names, never values)`,
      );
    }
    if (row.examplePath.length === 0 || !row.examplePath.startsWith("examples/")) {
      problems.push(`${row.family}: example path "${row.examplePath}" is not an examples/ path`);
    } else if (!existsSync(join(harnessRepositoryRoot(), row.examplePath))) {
      problems.push(
        `${row.family}: example path ${row.examplePath} does not exist in the repository`,
      );
    }
    if (row.availability.trim().length === 0) {
      problems.push(
        `${row.family}: no recorded availability string (a gap must be recorded as a gap)`,
      );
    }
  }
  return problems;
}

/**
 * Derive the full coverage matrix from the machine manifest (the
 * pinned facts — never a reinterpretation). One row per workload
 * family.
 */
export function capabilityCoverageMatrix(): CapabilityMatrixRow[] {
  const manifest = loadCapabilityManifestFile();
  const rows: CapabilityMatrixRow[] = [];
  for (const family of manifest.workloadFamilies) {
    const classification: AvailabilityClassification =
      family.classification === "provider-gated" ? "provider-gated" : "runnable";
    const gatedBy = family.gatedBy ?? null;
    rows.push({
      family: family.family,
      classification,
      gatedBy,
      availability: family.availability,
      examplePath: family.example,
      capabilityRequirements: [...family.capabilityRequirements],
      discoveryLocation: {
        consoleRoute: `/console/playground/${family.family}`,
        machineManifest: CAPABILITY_MANIFEST_PATH,
      },
      providerAccessExplanation: providerAccessExplanationOf(family, manifest.providerAccess),
    });
  }
  return rows;
}

/**
 * The provider/access explanation (fact (d)): for a gated family, the
 * providerAccess rows of its gate's credential NAME (the recorded
 * availability, verbatim) or the honest no-provider boundary; for a
 * runnable family, its recorded provenance.
 */
function providerAccessExplanationOf(
  family: ManifestFamily,
  providerAccess: readonly ManifestProviderAccess[],
): string {
  if (family.classification !== "provider-gated" || family.gatedBy === undefined) {
    return `runnable — the family's recorded provenance: ${family.availability}`;
  }
  const matching = providerAccess.filter((entry) => entry.credentialEnvVar === family.gatedBy);
  if (matching.length === 0) {
    return `gated by the ${family.gatedBy} credential (name only); no providerAccess row carries that name — the recorded availability stands verbatim: ${family.availability}`;
  }
  return matching
    .map(
      (entry) =>
        `${entry.provider} (${entry.credentialEnvVar}, name only): ${entry.recordedAvailability}`,
    )
    .join("; ");
}

/** Counts by target-probe state (the matrix summary). */
export interface MatrixSummary {
  readonly familiesTotal: number;
  readonly familiesWithServedDisclosure: number;
  readonly familiesNotServed: number;
  readonly familiesDisclosureFailed: number;
}

export function summarizeMatrix(rows: readonly CapabilityMatrixRow[]): MatrixSummary {
  let served = 0;
  let notServed = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.targetProbe === undefined) {
      continue;
    }
    if (row.targetProbe.status === "pass") {
      served += 1;
    } else if (row.targetProbe.status === "not-run") {
      notServed += 1;
    } else {
      failed += 1;
    }
  }
  return {
    familiesTotal: rows.length,
    familiesWithServedDisclosure: served,
    familiesNotServed: notServed,
    familiesDisclosureFailed: failed,
  };
}

/** Cross-check the examples inventory (classification parity per example). */
export function examplesManifestParityProblems(): readonly string[] {
  const root = harnessRepositoryRoot();
  const raw = readFileSync(join(root, EXAMPLES_MANIFEST_PATH), "utf8");
  const parsed = JSON.parse(raw) as {
    readonly examples: readonly {
      readonly path: string;
      readonly family: string;
      readonly classification: string;
    }[];
  };
  const manifest = loadCapabilityManifestFile();
  const problems: string[] = [];
  for (const family of manifest.workloadFamilies) {
    const example = parsed.examples.find((entry) => entry.family === family.family);
    if (example === undefined) {
      problems.push(`${family.family}: no example inventory row carries the family`);
      continue;
    }
    if (example.classification !== family.classification) {
      problems.push(
        `${family.family}: example inventory classification "${example.classification}" != manifest "${family.classification}"`,
      );
    }
  }
  return problems;
}
