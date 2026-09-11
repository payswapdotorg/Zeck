/**
 * deploy/validate — the deployment configuration validation gate
 * (WORK-042 Required Verification: "deployment configuration
 * validation"; extended by WORK-047 / D-06, WORK-057 / D-08 HA, and
 * WORK-060 / D-08 wave B).
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
 *  8. (D-06) the release-control migration is in the shipped set;
 *  9. (D-07) the repository-resident recovery-targets document loads
 *     with bounded, numeric RTO/RPO targets for EVERY environment
 *     class (aspirational or missing targets are unrepresentable);
 * 10. (D-08 / WORK-057) the recovery-targets `ha` extension loads
 *     fail-closed for every environment: primary+standby topology,
 *     bounded replication-path RPO targets (asynchronous and
 *     synchronous), bounded failover RTO, scope and measurement
 *     procedure (drift is unrepresentable);
 * 11. (D-08 / WORK-060, SEC-003) every environment declares its
 *     connectivity profile over the closed internal-path vocabulary,
 *     and the PRODUCTION class declares a private-path profile that
 *     spans hosts (tunnel or private-endpoint): public internal
 *     communication is unrepresentable in the environment matrix, and
 *     a loopback-only production cannot carry its multi-host HA
 *     topology;
 * 12. (D-08 / WORK-060, SEC-003) every environment declares its
 *     first-class region dimension (the repository-declared
 *     data-at-rest region consumed by residency enforcement);
 * 13. (D-08 / WORK-060, AVA-003) every durable concern declares
 *     exactly one typed alternate provider with a governed-procedure
 *     failover profile (a durable concern depending on a single
 *     external provider is unrepresentable).
 *
 * Exit 0 = the configuration is valid; exit 1 = violations listed.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHaTopologyDocument } from "../src/platform/db/ha/topology";
import { shippedMigrations } from "../src/platform/db/startup";
import { isPrivateOnlyProfile } from "../src/platform/deployment/connectivity";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import { DURABLE_CONCERNS } from "../src/platform/deployment/manifest";
import { computeResourceNames, previewBranchSlug } from "../src/platform/deployment/naming";
import { loadQuotaGuardsPolicy } from "../src/platform/observability/alerts";
import { parseRecoveryTargets } from "../src/platform/recovery/rto-rpo";
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
  readonly recoveryTargetEnvironments: number;
  /** (D-08) environments whose HA topology extension parsed fail-closed. */
  readonly haTopologyEnvironments: number;
  /** (D-08 / WORK-060) environments declaring a private-path connectivity profile. */
  readonly connectivityEnvironments: number;
  /** (D-08 / WORK-060) environments declaring the first-class region dimension. */
  readonly regionEnvironments: number;
  /** (D-08 / WORK-060) durable concerns with a typed alternate provider declared. */
  readonly providerRedundancyProfiles: number;
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

  // The D-07 repository-resident recovery targets: bounded, numeric,
  // present for EVERY environment class of the environments.json
  // matrix (an environment without recovery objectives is
  // unrepresentable; aspirational prose is unrepresentable).
  let recoveryTargetCount = 0;
  try {
    const source = readFileSync(
      resolve(REPOSITORY_ROOT, "deploy", "manifests", "recovery-targets.json"),
      "utf8",
    );
    const targets = parseRecoveryTargets(source);
    recoveryTargetCount = Object.keys(targets.targets).length;
    for (const environment of manifest.environments) {
      if (targets.targets[environment.id] === undefined) {
        problems.push(
          `recovery-targets.json: no recovery target defined for environment "${environment.id}" (every environment class needs measured objectives)`,
        );
      }
    }
  } catch (error) {
    problems.push(`recovery-targets.json: ${(error as Error).message}`);
  }

  // The D-08 HA topology extension (WORK-057): every environment
  // declares its primary+standby topology with bounded failover
  // objectives — the extension is validated by the platform parser
  // (fail-closed on drift), never silently accepted.
  let haTopologyCount = 0;
  try {
    const source = readFileSync(
      resolve(REPOSITORY_ROOT, "deploy", "manifests", "recovery-targets.json"),
      "utf8",
    );
    const document = JSON.parse(source) as unknown;
    const haTopologies = parseHaTopologyDocument(document);
    haTopologyCount = Object.keys(haTopologies).length;
    for (const environment of manifest.environments) {
      if (haTopologies[environment.id] === undefined) {
        problems.push(
          `recovery-targets.json: no ha topology declared for environment "${environment.id}" (every environment class declares its HA topology)`,
        );
      }
    }
  } catch (error) {
    problems.push(`recovery-targets.json ha extension: ${(error as Error).message}`);
  }

  // Rule 11 (D-08 / WORK-060, SEC-003): every environment declares a
  // connectivity profile over the CLOSED internal-path vocabulary
  // (the manifest loader rejects `public` and unknown values), and the
  // PRODUCTION class declares a private-path profile that spans
  // hosts — loopback-only is not a production-class internal path
  // vocabulary because the production HA topology (primary + standby,
  // AVA-002) is multi-host by construction.
  const connectivityEnvironments = manifest.environments.filter(
    (environment) => environment.connectivity.internalPaths.length > 0,
  ).length;
  for (const environment of manifest.environments) {
    if (environment.connectivity.internalPaths.length === 0) {
      problems.push(
        `environments.json: environment "${environment.id}" declares no connectivity profile (every environment class declares its internal-path vocabulary)`,
      );
    }
    if (!isPrivateOnlyProfile(environment.connectivity)) {
      problems.push(
        `environments.json: environment "${environment.id}" connectivity profile carries a non-vocabulary internal path (only loopback|tunnel|private-endpoint are representable)`,
      );
    }
  }
  const production = manifest.environments.find((entry) => entry.id === "production");
  if (production !== undefined) {
    const paths = production.connectivity.internalPaths;
    if (!paths.includes("tunnel") && !paths.includes("private-endpoint")) {
      problems.push(
        "environments.json: the production class must declare tunnel or private-endpoint internal paths (its HA topology spans hosts; public internal communication is unrepresentable — SEC-003)",
      );
    }
  }

  // Rule 12 (D-08 / WORK-060, SEC-003): the region dimension is
  // first-class — every environment declares its repository-declared
  // data-at-rest region (the manifest loader validates the shape;
  // this rule proves coverage — an environment without a declared
  // region cannot satisfy ANY tenant residency constraint).
  const regionEnvironments = manifest.environments.filter(
    (environment) => environment.region.trim().length > 0,
  ).length;
  for (const environment of manifest.environments) {
    if (environment.region.trim().length === 0) {
      problems.push(
        `environments.json: environment "${environment.id}" declares no region (the data-at-rest region is a first-class deployment dimension — SEC-003)`,
      );
    }
  }

  // Rule 13 (D-08 / WORK-060, AVA-003): every durable concern declares
  // exactly one typed alternate provider with a governed-procedure
  // failover profile (the manifest loader validates the shapes and the
  // mode vocabulary; this rule proves durable-concern coverage).
  const providerRedundancyProfiles = manifest.providers.filter(
    (provider) => provider.redundancyAlternate !== null,
  ).length;
  for (const concern of DURABLE_CONCERNS) {
    const owner = manifest.providers.find((provider) => provider.concern === concern);
    if (owner === undefined) {
      problems.push(
        `providers.json: durable concern "${concern}" has no owning provider (the manifest loader reports authority/coverage gaps; this rule pins the redundancy duty)`,
      );
      continue;
    }
    if (owner.redundancyAlternate === null) {
      problems.push(
        `providers.json: durable concern "${concern}" declares no typed alternate provider (AVA-003: no durable concern depends on a single external provider)`,
      );
    }
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
    recoveryTargetEnvironments: recoveryTargetCount,
    haTopologyEnvironments: haTopologyCount,
    connectivityEnvironments,
    regionEnvironments,
    providerRedundancyProfiles,
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
