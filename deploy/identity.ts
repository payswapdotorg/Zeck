/**
 * deploy/identity — emit the deterministic deployment identity document
 * (WORK-042 AC7/D1.0 §15: deployment attributable to an exact Git
 * revision).
 *
 * The identity is pure: same revision + same manifests + same
 * environment (+ same preview branch) ⇒ byte-identical document. CI
 * emits this document as the auditable deployment record for the
 * checked-out revision.
 *
 * Usage:
 *   bun run deploy:identity -- --environment local
 *   bun run deploy:identity -- --environment preview --branch work/WORK-042-x
 */

import { deploymentIdentity, namingConventionsOf } from "../src/platform/deployment/identity";
import { previewBranchSlug, requiresPreviewSlug } from "../src/platform/deployment/naming";
import { gitRevision, loadManifest, optionalBranch, requireEnvironment } from "./lib";

function main(): void {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);
  const manifest = loadManifest();
  const conventions = namingConventionsOf(manifest);
  const resources = manifest.resources[environment];
  if (environment === "preview" && branch === undefined && requiresPreviewSlug(resources)) {
    console.error("error: --environment preview requires --branch <branch-name>");
    process.exit(2);
  }
  const slug =
    branch !== undefined
      ? previewBranchSlug(branch, conventions.previewBranchSlugMaxLength)
      : undefined;
  const identity = deploymentIdentity(manifest, gitRevision(), environment, slug);
  console.log(JSON.stringify(identity, null, 2));
}

main();
