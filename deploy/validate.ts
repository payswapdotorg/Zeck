/**
 * deploy/validate — the deployment configuration validation gate
 * (WORK-042 Required Verification: "deployment configuration
 * validation"; extended by WORK-047 / D-06).
 *
 * Pure repository check, no network, no mutation:
 *  1. the five manifests load and pass every cross-consistency rule
 *     (fail closed, full problem list);
 *  2. deterministic naming computes for EVERY environment's resource
 *     set within provider constraints;
 *  3. established provider port contracts exist in the repository;
 *  4. planned provider ports reference real roadmap phases;
 *  5. the secret-plaintext scan over raw manifest sources is clean
 *     (credential-shaped content is unrepresentable in manifests);
 *  6. (D-06) the repository-resident release policy loads, its gate
 *     vocabulary is closed, and it COVERS the environments.json
 *     promotion ladder requirements (drift is unrepresentable);
 *  7. (D-06) the repository-resident quota-guards policy loads with
 *     ordered, actionable thresholds (unbounded weakening is
 *     unrepresentable);
 *  8. (D-06) the release-control migration is in the shipped set.
 *
 * Exit 0 = the configuration is valid; exit 1 = violations listed.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedMigrations } from "../src/platform/db/startup";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import { computeResourceNames, previewBranchSlug } from "../src/platform/deployment/naming";
import { loadQuotaGuardsPolicy } from "../src/platform/observability/alerts";
import { loadReleasePolicy } from "../src/platform/release/policy";
import {
  checkPlannedPhases,
  checkPortContracts,
  loadManifest,
  REPOSITORY_ROOT,
  scanManifestsForSecretPlaintext,
} from "./lib";

export interface DeploymentValidationReport {
  readonly valid: boolean;
  readonly problems: readonly string[];
  readonly environments: number;
  readonly providers: number;
  readonly resourceKinds: number;
  readonly variables: number;
  readonly secretReferenceInventories: number;
  readonly releaseGateKinds: number;
  readonly quotaGuards: number;
  readonly operationalThresholds: number;
  readonly migrations: number;
}

/** The full validation core (the CLI and the D-06 validation gate share one path). */
export function validateDeploymentConfiguration(): DeploymentValidationReport {
  const problems: string[] = [];
  const manifest = loadManifest();
  const conventions = namingConventionsOf(manifest);

  // Naming computes for every environment (including a deterministic
  // preview branch example proving the per-branch path).
  for (const environment of ["local", "preview", "staging", "production"] as const) {
    try {
      computeResourceNames(
        conventions,
        environment,
        manifest.resources[environment],
        environment === "preview"
          ? previewBranchSlug("work/WORK-042-example", conventions.previewBranchSlugMaxLength)
          : undefined,
      );
    } catch (error) {
      problems.push(`naming (${environment}): ${(error as Error).message}`);
    }
  }

  problems.push(...checkPortContracts(manifest));
  problems.push(...checkPlannedPhases(manifest));
  problems.push(...scanManifestsForSecretPlaintext(manifest.sources));

  // The D-06 repository-resident release policy: closed vocabulary +
  // environments.json ladder coverage (fail closed on drift).
  let releaseGateCount = 0;
  try {
    const source = readFileSync(
      resolve(REPOSITORY_ROOT, "deploy", "manifests", "release-policy.json"),
      "utf8",
    );
    const policy = loadReleasePolicy(source, manifest);
    releaseGateCount = policy.gateKinds.length;
  } catch (error) {
    problems.push(`release-policy.json: ${(error as Error).message}`);
  }

  // The D-06 quota-guards policy: ordered, actionable thresholds.
  let quotaGuardCount = 0;
  let operationalThresholdCount = 0;
  try {
    const source = readFileSync(
      resolve(REPOSITORY_ROOT, "deploy", "manifests", "quota-guards.json"),
      "utf8",
    );
    const policy = loadQuotaGuardsPolicy(source);
    quotaGuardCount = policy.guards.length;
    operationalThresholdCount = policy.operationalThresholds.length;
  } catch (error) {
    problems.push(`quota-guards.json: ${(error as Error).message}`);
  }

  // The D-06 release-control schema is shipped (the ledger exists in
  // the authoritative migration set).
  const shipped = shippedMigrations();
  if (!shipped.some((migration) => migration.name.includes("release_control"))) {
    problems.push(
      "migrations: the release_control ledger migration (0029_release_control.sql) is missing from the shipped set",
    );
  }

  return {
    valid: problems.length === 0,
    problems,
    environments: manifest.environments.length,
    providers: manifest.providers.length,
    resourceKinds: Object.keys(conventions.kinds).length,
    variables: manifest.variables.length,
    secretReferenceInventories: Object.keys(manifest.secretReferences).length,
    releaseGateKinds: releaseGateCount,
    quotaGuards: quotaGuardCount,
    operationalThresholds: operationalThresholdCount,
    migrations: shipped.length,
  };
}

function main(): void {
  const report = validateDeploymentConfiguration();
  console.log(JSON.stringify({ tool: "deploy/validate", ...report }, null, 2));
  process.exit(report.valid ? 0 : 1);
}

const IS_ENTRY =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  main();
}
