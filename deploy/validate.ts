/**
 * deploy/validate — the deployment configuration validation gate
 * (WORK-042 Required Verification: "deployment configuration
 * validation").
 *
 * Pure repository check, no network, no mutation:
 *  1. the five manifests load and pass every cross-consistency rule
 *     (fail closed, full problem list);
 *  2. deterministic naming computes for EVERY environment's resource
 *     set within provider constraints;
 *  3. established provider port contracts exist in the repository;
 *  4. planned provider ports reference real roadmap phases;
 *  5. the secret-plaintext scan over raw manifest sources is clean
 *     (credential-shaped content is unrepresentable in manifests).
 *
 * Exit 0 = the configuration is valid; exit 1 = violations listed.
 */

import { namingConventionsOf } from "../src/platform/deployment/identity";
import { computeResourceNames, previewBranchSlug } from "../src/platform/deployment/naming";
import {
  checkPlannedPhases,
  checkPortContracts,
  loadManifest,
  scanManifestsForSecretPlaintext,
} from "./lib";

function main(): void {
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

  const report = {
    tool: "deploy/validate",
    valid: problems.length === 0,
    problems,
    environments: manifest.environments.length,
    providers: manifest.providers.length,
    resourceKinds: Object.keys(conventions.kinds).length,
    variables: manifest.variables.length,
    secretReferenceInventories: Object.keys(manifest.secretReferences).length,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
}

main();
