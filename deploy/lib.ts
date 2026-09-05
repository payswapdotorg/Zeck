/**
 * Shared plumbing for the deployment tooling (WORK-042).
 *
 * The tools under `deploy/` are the deterministic, idempotent operators
 * over the repository-resident manifest set:
 *
 * - validate  — full manifest + naming + port-contract + secret-scan
 * - bootstrap — converge disposable local resources; emit provider plans
 * - teardown  — remove disposable resources (classification-guarded)
 * - smoke     — readiness + exact-revision deployment identity attestation
 * - identity  — emit the deterministic deployment identity document
 *
 * Repository root resolution is relative to THIS file (deploy/ → root),
 * never the process CWD, so the tools behave identically from any
 * working directory. Git revision comes from the checkout itself
 * (exact-revision identity, D1.0 §15).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DeploymentManifest,
  loadDeploymentManifest,
  MANIFEST_FILES,
  type ManifestFileReader,
} from "../src/platform/deployment/manifest";
import type { EnvironmentId } from "../src/platform/deployment/naming";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Load the manifest set from the real repository tree (fail closed). */
export function loadManifest(): DeploymentManifest {
  return loadDeploymentManifest(manifestReader());
}

/** Manifest reader over the filesystem (synchronous, fail closed). */
export function manifestReader(): ManifestFileReader {
  return (file) => readFileSync(resolve(REPOSITORY_ROOT, "deploy", "manifests", file), "utf8");
}

/** The exact Git revision of this checkout (identity input). */
export function gitRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
}

/** Parse and validate the --environment argument. */
export function requireEnvironment(argv: readonly string[]): EnvironmentId {
  const index = argv.indexOf("--environment");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value !== "local" && value !== "preview" && value !== "staging" && value !== "production") {
    console.error("error: --environment <local|preview|staging|production> is required");
    process.exit(2);
  }
  return value;
}

/** Parse --branch (preview branch identity). */
export function optionalBranch(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--branch");
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Parse a boolean flag. */
export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

/**
 * The secret-plaintext scan over raw manifest sources. Manifests are
 * repository-resident truth: credential-shaped content anywhere in
 * them is a violation of the secret-reference model (D1.0 §14) and
 * fails closed.
 */
export function scanManifestsForSecretPlaintext(
  sources: Readonly<Record<string, string>>,
): readonly string[] {
  const violations: string[] = [];
  const patterns: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    {
      name: "URL-embedded credentials (scheme://user:password@host)",
      pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s"'@/:]+:[^\s"'@]+@/i,
    },
    { name: "OpenAI-style key literal", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
    { name: "GitHub token literal", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
    { name: "AWS access key literal", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "Slack token literal", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    {
      name: "credential assignment (token/secret/password = value)",
      pattern: /["'](token|secret|password|api[_-]?key)["']\s*:\s*["'][^"']{12,}["']/i,
    },
  ];
  for (const file of MANIFEST_FILES) {
    const content = sources[file];
    if (content === undefined) {
      continue;
    }
    for (const { name, pattern } of patterns) {
      if (pattern.test(content)) {
        violations.push(`${file}: ${name}`);
      }
    }
  }
  return violations;
}

/** Established provider port contracts must exist in the repository. */
export function checkPortContracts(manifest: DeploymentManifest): readonly string[] {
  const problems: string[] = [];
  for (const provider of manifest.providers) {
    if (provider.portStatus !== "established" || provider.portContract === null) {
      continue;
    }
    if (!existsSync(resolve(REPOSITORY_ROOT, provider.portContract))) {
      problems.push(
        `providers.json: established provider "${provider.id}" port contract ${provider.portContract} does not exist in the repository`,
      );
    }
  }
  return problems;
}

/** Planned provider ports must reference real roadmap phases. */
export function checkPlannedPhases(manifest: DeploymentManifest): readonly string[] {
  const problems: string[] = [];
  const roadmap = readFileSync(resolve(REPOSITORY_ROOT, "docs", "DEPLOYMENT-ROADMAP.md"), "utf8");
  for (const provider of manifest.providers) {
    if (provider.portStatus !== "planned" || provider.plannedPhase === null) {
      continue;
    }
    if (!roadmap.includes(`### ${provider.plannedPhase} `)) {
      problems.push(
        `providers.json: planned provider "${provider.id}" references unknown roadmap phase ${provider.plannedPhase}`,
      );
    }
  }
  return problems;
}
