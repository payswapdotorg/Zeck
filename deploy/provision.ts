/**
 * deploy/provision — environment, secret and sandbox-account
 * provisioning automation (DEP-002).
 *
 * ONE reproducible operator path that converges an environment class
 * from repository truth — the manifests under deploy/manifests/ are
 * the ONLY source (the tool projects, never invents topology, and
 * never keeps a tool-local account registry):
 *
 *   1. manifest validation — the full deploy:validate gate (15 rule
 *      families incl. the sandbox-accounts manifest) runs FIRST;
 *      malformed rows abort before any provider call or write;
 *   2. resource plan — the deterministic resource set computed by the
 *      DEP-001 bootstrap seam (local convergence is bootstrap's lane;
 *      provider resources are plan rows with executable gating);
 *   3. secret-reference scaffold — per-environment reference
 *      templates and CI variable skeletons mapping every
 *      secret-references.json entry to where its value gets injected.
 *      EXTERNAL-ONLY by construction: the tool never accepts, stores,
 *      logs or renders secret plaintext (a reference variable holding
 *      non-reference material aborts fail-closed — the hostile probe
 *      path);
 *   4. sandbox-account records — the disposable identity set the
 *      environment class permits, rendered as PURE manifest
 *      projection (synthetic-data policy, quota envelope wired to
 *      quota-guards.json, DEP-014 expiry semantics);
 *   5. post-convergence validation — the on-disk artifact set is
 *      re-derived and byte-compared against the manifest projection.
 *
 * Idempotence: a second run reports already-converged (the artifact
 * content is a deterministic projection — no timestamps inside
 * records); a drifted state (missing, corrupted or orphaned
 * artifacts) re-converges. teardown.ts removes exactly the
 * classification-permitted provisioned records.
 *
 * Live-provider steps (Neon/R2/Cloudflare/Upstash/Vercel resource
 * creation) are account-plane work gated on credential PRESENCE
 * (never values): without credentials they record honest NOT RUN with
 * the owner "Lead credentialed re-run" — exactly the DEP-001
 * bootstrap plan/provider-plan seam and evidence discipline. With
 * credentials present the plan is marked executable for the
 * credentialed operator application path; this tool performs no
 * provider control-plane calls (provider-neutrality doctrine —
 * deploy/PUBLIC-DEPLOYMENT.md §3.2).
 *
 * Usage:
 *   bun run deploy:provision -- --environment local --plan   # dry-run, zero credentials
 *   bun run deploy:provision -- --environment local          # converge (scaffold + records)
 *   bun run deploy:provision -- --environment preview --branch work/DEP-002-x --json
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import type { DeploymentManifest, EnvironmentRecord } from "../src/platform/deployment/manifest";
import {
  computeResourceNames,
  type EnvironmentId,
  previewBranchSlug,
} from "../src/platform/deployment/naming";
import { loadQuotaGuardsPolicy } from "../src/platform/observability/alerts";
import {
  gitRevision,
  hasFlag,
  loadManifest,
  optionalBranch,
  REPOSITORY_ROOT,
  requireEnvironment,
} from "./lib";
import {
  parseSandboxAccounts,
  renderSandboxAccountDocument,
  SANDBOX_ACCOUNTS_MANIFEST_FILE,
  type SandboxAccountsManifest,
  sandboxAccountsOf,
} from "./sandbox-accounts";
import { validateDeploymentConfiguration } from "./validate";

const DEFAULT_DATA_ROOT = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"),
  "zeck",
);

/**
 * The account-plane credential variables gating live-provider steps
 * (PRESENCE ONLY — values are never read, copied or rendered). These
 * are operator account credentials for the credentialed application
 * path (deploy/PUBLIC-DEPLOYMENT.md), not runtime configuration: the
 * runtime secrets stay zeck-secret:// references materialized
 * externally. Exported for deploy/preflight.ts (PPR-002 step 1:
 * account/credential preflight) so the preflight and the provision
 * plan share ONE mapping — never two lists that can drift.
 */
export const RESOURCE_KIND_CREDENTIAL_VARIABLES: Readonly<Record<string, string>> = {
  "neon-project": "NEON_API_KEY",
  "neon-branch": "NEON_API_KEY",
  "r2-bucket": "CLOUDFLARE_API_TOKEN",
  "cf-queue": "CLOUDFLARE_API_TOKEN",
  "cf-workflow": "CLOUDFLARE_API_TOKEN",
  "upstash-redis": "UPSTASH_API_KEY",
  "vercel-project": "VERCEL_TOKEN",
};

const NOT_RUN_OWNER = "Lead credentialed re-run (deploy/PUBLIC-DEPLOYMENT.md DEP-002 section)";

export class ProvisionError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`provisioning refused (${problems.length} problem(s)):\n- ${problems.join("\n- ")}`);
    this.name = "ProvisionError";
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface ResourcePlanRow {
  readonly resource: string;
  readonly concern: string;
  readonly kind: string;
  readonly name: string;
  readonly action: string;
}

export interface LiveProviderStep {
  readonly concern: string;
  readonly provider?: string;
  readonly kind: string;
  readonly name: string;
  readonly step: string;
  readonly credentialVariable: string;
  readonly credentialsPresent: boolean;
  readonly status: "not-run" | "executable-plan";
  readonly reason: string;
  readonly owner: string | null;
}

export interface PlannedArtifact {
  readonly path: string;
  readonly state: "absent" | "matches" | "drifts";
}

export interface ProvisionReport {
  readonly tool: "deploy/provision";
  readonly environment: EnvironmentId;
  readonly environmentClass: string;
  readonly mode: "plan" | "converge";
  readonly gitRevision: string;
  readonly previewBranch?: string;
  readonly previewSlug?: string;
  readonly steps: {
    readonly manifestValidation: {
      readonly passed: boolean;
      readonly ruleFamilies: number;
      readonly sandboxAccountEnvironments: number;
      readonly sandboxAccounts: number;
    };
    readonly resourcePlan: {
      readonly resources: readonly ResourcePlanRow[];
      readonly executable: boolean;
    };
    readonly secretReferenceScaffold: {
      readonly files: readonly string[];
      readonly references: number;
      readonly externalOnly: true;
    };
    readonly sandboxAccountRecords: {
      readonly records: readonly { readonly accountId: string; readonly file: string }[];
      readonly projectedFrom: string;
    };
    readonly postConvergenceValidation: {
      readonly passed: boolean;
      readonly artifactsChecked: number;
      readonly problems: readonly string[];
      readonly note?: string;
    };
  };
  readonly environmentContract: {
    readonly satisfied: boolean;
    readonly problems: readonly string[];
    readonly expectedReferences: number;
    readonly materializedReferences: number;
  };
  readonly liveProviderSteps: readonly LiveProviderStep[];
  readonly convergence: {
    readonly converged: boolean;
    readonly alreadyConverged: boolean;
    readonly created: readonly string[];
    readonly repaired: readonly string[];
    readonly unchanged: number;
    readonly pruned: readonly string[];
    readonly wouldWrite?: readonly PlannedArtifact[];
  };
  readonly outputRoot: string;
}

// ---------------------------------------------------------------------------
// Core input
// ---------------------------------------------------------------------------

export interface ProvisionEnvironmentInput {
  readonly environment: EnvironmentId;
  readonly branch?: string;
  readonly plan: boolean;
  readonly manifest: DeploymentManifest;
  /** Pre-parsed (validated) sandbox-accounts manifest — projection input. */
  readonly sandboxAccounts: SandboxAccountsManifest;
  /** The concrete process environment (read-only; values never rendered). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dataRoot: string;
  readonly gitRevision: string;
  readonly now: () => string;
}

/** The provisioned-artifacts directory of one environment (computed, never stored). */
export function provisionedArtifactsDirectory(
  dataRoot: string,
  environment: EnvironmentId,
  previewSlug?: string,
): string {
  return join(
    dataRoot,
    "provisioned",
    environment,
    ...(environment === "preview" && previewSlug !== undefined ? [previewSlug] : []),
  );
}

// ---------------------------------------------------------------------------
// Secret-reference scaffold (external-only projection)
// ---------------------------------------------------------------------------

function secretScaffoldEnvFile(manifest: DeploymentManifest, environment: EnvironmentId): string {
  const lines: string[] = [
    `# Zeck secret-reference scaffold for environment "${environment}"`,
    "# Generated by deploy/provision from deploy/manifests/secret-references.json.",
    "# EXTERNAL-ONLY (D1.0 §14): every variable below holds a zeck-secret://",
    "# REFERENCE URI — never a value. Materialize the value in your secret",
    "# manager or CI environment; this tool never accepts, stores, logs or",
    "# renders secret plaintext.",
    "",
  ];
  for (const reference of manifest.secretReferences[environment]) {
    lines.push(`# ${reference.description}`);
    lines.push(`${reference.variable}=zeck-secret://${environment}/${reference.name}`);
    lines.push("");
  }
  return lines.join("\n");
}

function secretScaffoldCiFile(manifest: DeploymentManifest, environment: EnvironmentId): string {
  const document = {
    tool: "deploy/provision",
    artifact: "zeck-secret-reference-ci-skeleton",
    environment,
    doctrine:
      "External-only secret materialization: each entry names the variable, its zeck-secret:// reference URI and where the VALUE gets injected. Values live in your secret manager / CI environment and never transit this tool.",
    secretReferenceVariables: manifest.secretReferences[environment].map((reference) => ({
      variable: reference.variable,
      reference: `zeck-secret://${environment}/${reference.name}`,
      classification: reference.classification,
      injectionPoint:
        "external secret manager / CI environment (resolved immediately before the authorized adapter call)",
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Artifact derivation (the deterministic manifest projection)
// ---------------------------------------------------------------------------

function deriveArtifacts(
  input: ProvisionEnvironmentInput,
  environmentRecord: EnvironmentRecord,
): Map<string, string> {
  const artifacts = new Map<string, string>();
  artifacts.set(
    "secrets/secrets.reference.env",
    secretScaffoldEnvFile(input.manifest, input.environment),
  );
  artifacts.set(
    "secrets/ci-variables.json",
    secretScaffoldCiFile(input.manifest, input.environment),
  );
  for (const account of sandboxAccountsOf(input.sandboxAccounts, input.environment)) {
    const document = renderSandboxAccountDocument(environmentRecord, account, "provisioned");
    artifacts.set(
      `sandbox-accounts/${account.id}.sandbox-account.json`,
      `${JSON.stringify(document, null, 2)}\n`,
    );
  }
  return artifacts;
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8");
}

function collectFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Live-provider steps (presence-gated, never values)
// ---------------------------------------------------------------------------

/** Credential PRESENCE (never the value) of one account-plane variable. */
export function credentialPresent(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
): boolean {
  const value = env[variable];
  return value !== undefined && value.length > 0;
}

// ---------------------------------------------------------------------------
// The convergence core
// ---------------------------------------------------------------------------

export function provisionEnvironment(input: ProvisionEnvironmentInput): ProvisionReport {
  const { manifest, environment, plan } = input;
  const environmentRecord = manifest.environments.find((entry) => entry.id === environment);
  if (environmentRecord === undefined) {
    throw new ProvisionError([`unknown environment: ${environment}`]);
  }

  // The environment contract: reference-variable integrity is a hard
  // precondition in BOTH modes (plaintext or cross-environment
  // material in a reference variable is never accepted, never
  // rendered — the evaluator reports variable names and reasons
  // only). Other contract problems (e.g. a missing environment
  // identity) abort convergence but are tolerated in plan mode
  // (plan requires no credentials at all).
  const contract = evaluateEnvironmentContract(manifest, environment, input.env);
  const referenceVariables = manifest.secretReferences[environment].map((r) => r.variable);
  const referenceIntegrityProblems = contract.problems.filter((problem) =>
    referenceVariables.some((variable) => problem.startsWith(`${variable} `)),
  );
  const otherProblems = contract.problems.filter(
    (problem) => !referenceIntegrityProblems.includes(problem),
  );
  const hardProblems: string[] = [...referenceIntegrityProblems];
  if (!plan) {
    hardProblems.push(...otherProblems);
  }
  if (hardProblems.length > 0) {
    throw new ProvisionError(hardProblems);
  }

  const conventions = namingConventionsOf(manifest);
  const slug =
    environment === "preview" && input.branch !== undefined
      ? previewBranchSlug(input.branch, conventions.previewBranchSlugMaxLength)
      : undefined;
  const names = computeResourceNames(
    conventions,
    environment,
    manifest.resources[environment],
    slug,
  );
  const expectedReferences = manifest.secretReferences[environment];
  const materializedVariables = new Set(contract.materializedReferences.map((m) => m.variable));
  const executable =
    contract.satisfied && expectedReferences.every((r) => materializedVariables.has(r.variable));

  // Step 2: the resource plan (the DEP-001 bootstrap seam).
  const resourceRows: ResourcePlanRow[] = names.map((name, index) => {
    const concern = manifest.resources[environment][index]?.concern ?? "-";
    const local = RESOURCE_KIND_CREDENTIAL_VARIABLES[name.kind] === undefined;
    return {
      resource: name.id ?? "-",
      concern,
      kind: name.kind,
      name: name.name,
      action: local
        ? "delegated: deploy:bootstrap converges this local/self-hosted resource (idempotent; see deploy/README.md)"
        : "plan-only (account-plane work; apply the deterministic name via the credentialed operator path — DEP-001 §3.2)",
    };
  });

  // Live-provider steps: one per provider-facing resource row,
  // gated on credential PRESENCE (never values).
  const liveStepsWithNames: LiveProviderStep[] = [];
  for (const row of resourceRows) {
    const credentialVariable = RESOURCE_KIND_CREDENTIAL_VARIABLES[row.kind];
    if (credentialVariable === undefined) {
      continue; // local/self-hosted kinds: no account-plane provider credential.
    }
    const provider = manifest.providers.find((entry) => entry.concern === row.concern);
    const present = credentialPresent(input.env, credentialVariable);
    liveStepsWithNames.push({
      concern: row.concern,
      ...(provider === undefined ? {} : { provider: provider.id }),
      kind: row.kind,
      name: row.name,
      step: `create/converge the ${row.kind} resource (deterministic name; apply via the credentialed operator path)`,
      credentialVariable,
      credentialsPresent: present,
      status: present ? "executable-plan" : "not-run",
      reason: present
        ? `${credentialVariable} is present; the deterministic plan is executable for the credentialed operator application path (this tool performs no provider control-plane calls — provider-neutrality doctrine, DEP-001 §3.2)`
        : `${credentialVariable} is absent in this environment`,
      owner: present ? null : NOT_RUN_OWNER,
    });
  }

  // Steps 3 + 4: the deterministic artifact projection.
  const artifacts = deriveArtifacts(input, environmentRecord);
  const outputRoot = provisionedArtifactsDirectory(input.dataRoot, environment, slug);

  // Step 5: convergence + post-convergence validation.
  const created: string[] = [];
  const repaired: string[] = [];
  let unchanged = 0;
  const pruned: string[] = [];
  const wouldWrite: PlannedArtifact[] = [];

  const expectedRelPaths = new Set<string>(artifacts.keys());

  if (plan) {
    for (const rel of expectedRelPaths) {
      const current = readIfExists(join(outputRoot, rel));
      const expected = artifacts.get(rel) ?? "";
      wouldWrite.push({
        path: rel,
        state: current === null ? "absent" : current === expected ? "matches" : "drifts",
      });
    }
  } else {
    for (const [rel, content] of artifacts) {
      const current = readIfExists(join(outputRoot, rel));
      if (current === content) {
        unchanged += 1;
        continue;
      }
      const target = join(outputRoot, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      (current === null ? created : repaired).push(rel);
    }
    // Drift re-convergence: orphaned artifacts (present on disk, no
    // longer declared by the manifests) are pruned — the converged
    // state is EXACTLY the manifest projection. Scope: only this
    // environment's provisioned directory, never anything else.
    const protectedFiles = new Set<string>(
      [...expectedRelPaths].map((rel) => join(outputRoot, rel)),
    );
    const statePath = join(outputRoot, "provision-state.json");
    if (existsSync(outputRoot)) {
      for (const file of collectFilesUnder(outputRoot)) {
        if (protectedFiles.has(file) || file === statePath) {
          continue;
        }
        rmSync(file, { force: true });
        pruned.push(file.slice(outputRoot.length + 1));
      }
      // Prune directories left empty by the convergence (never the root).
      const pruneEmpty = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            pruneEmpty(full);
            if (readdirSync(full).length === 0) {
              rmSync(full, { recursive: true, force: true });
            }
          }
        }
      };
      pruneEmpty(outputRoot);
    }
    // The convergence state record (metadata only — the artifact
    // content itself stays a pure, timestamp-free projection).
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          tool: "deploy/provision",
          environment,
          ...(slug === undefined ? {} : { previewSlug: slug }),
          gitRevision: input.gitRevision,
          convergedAt: input.now(),
          artifacts: [...expectedRelPaths],
          projection:
            "deploy/manifests/** (repository truth; the converged state is exactly the manifest projection)",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  // Post-convergence validation: re-derive and byte-compare.
  const problems: string[] = [];
  if (!plan) {
    for (const [rel, content] of artifacts) {
      if (readIfExists(join(outputRoot, rel)) !== content) {
        problems.push(`artifact ${rel} does not match the manifest projection after convergence`);
      }
    }
    for (const file of collectFilesUnder(outputRoot)) {
      const rel = file.slice(outputRoot.length + 1);
      if (!expectedRelPaths.has(rel) && rel !== "provision-state.json") {
        problems.push(`unexpected artifact ${rel} survived convergence (pruning failed)`);
      }
    }
  }

  const allEnvironments = ["local", "preview", "staging", "production"] as const;
  const sandboxAccountRows = sandboxAccountsOf(input.sandboxAccounts, environment);
  const environmentsWithAccounts = allEnvironments.filter(
    (env) => sandboxAccountsOf(input.sandboxAccounts, env).length > 0,
  );

  return {
    tool: "deploy/provision",
    environment,
    environmentClass: environmentRecord.environmentClass,
    mode: plan ? "plan" : "converge",
    gitRevision: input.gitRevision,
    ...(input.branch === undefined ? {} : { previewBranch: input.branch }),
    ...(slug === undefined ? {} : { previewSlug: slug }),
    steps: {
      manifestValidation: {
        passed: true,
        ruleFamilies: 15,
        sandboxAccountEnvironments: environmentsWithAccounts.length,
        sandboxAccounts: allEnvironments.reduce(
          (total, env) => total + sandboxAccountsOf(input.sandboxAccounts, env).length,
          0,
        ),
      },
      resourcePlan: { resources: resourceRows, executable },
      secretReferenceScaffold: {
        files: ["secrets/secrets.reference.env", "secrets/ci-variables.json"],
        references: expectedReferences.length,
        externalOnly: true,
      },
      sandboxAccountRecords: {
        records: sandboxAccountRows.map((account) => ({
          accountId: account.id,
          file: `sandbox-accounts/${account.id}.sandbox-account.json`,
        })),
        projectedFrom: `deploy/manifests/${SANDBOX_ACCOUNTS_MANIFEST_FILE}`,
      },
      postConvergenceValidation: {
        passed: problems.length === 0,
        artifactsChecked: artifacts.size,
        problems,
        ...(plan
          ? {
              note: "plan mode — nothing written; the artifact set above is the manifest projection",
            }
          : {}),
      },
    },
    environmentContract: {
      satisfied: contract.satisfied,
      problems: contract.problems,
      expectedReferences: expectedReferences.length,
      materializedReferences: contract.materializedReferences.length,
    },
    liveProviderSteps: liveStepsWithNames,
    convergence: {
      converged: !plan && problems.length === 0,
      alreadyConverged:
        !plan && created.length === 0 && repaired.length === 0 && pruned.length === 0,
      created,
      repaired,
      unchanged,
      pruned,
      ...(plan ? { wouldWrite } : {}),
    },
    outputRoot,
  };
}

// ---------------------------------------------------------------------------
// Teardown helpers (classification-guarded; consumed by deploy/teardown)
// ---------------------------------------------------------------------------

export interface TeardownProvisionedRecordsInput {
  readonly dataRoot: string;
  readonly environment: EnvironmentId;
  readonly previewSlug?: string;
  readonly environmentRecord: EnvironmentRecord;
}

export interface TeardownProvisionedRecordsResult {
  readonly directory: string;
  readonly removed: boolean;
  readonly alreadyAbsent: boolean;
}

/**
 * Remove the provisioned artifact set of a DISPOSABLE environment —
 * exactly the computed directory under the local data root, nothing
 * else. The classification guard is re-checked HERE (defense in
 * depth): a persistent environment's provisioned records are refused
 * even if a caller bypasses deploy/teardown's own guard.
 */
export function teardownProvisionedRecords(
  input: TeardownProvisionedRecordsInput,
): TeardownProvisionedRecordsResult {
  if (input.environmentRecord.teardownAllowed === false) {
    throw new Error(
      `refusing to remove provisioned records of environment "${input.environment}" (class "${input.environmentRecord.environmentClass}" is persistent; classification, not operator intent, governs removal)`,
    );
  }
  const directory = provisionedArtifactsDirectory(
    input.dataRoot,
    input.environment,
    input.previewSlug,
  );
  if (!existsSync(directory)) {
    return { directory, removed: false, alreadyAbsent: true };
  }
  rmSync(directory, { recursive: true, force: true });
  return { directory, removed: true, alreadyAbsent: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHuman(report: ProvisionReport): void {
  const out = (line: string): void => console.log(line);
  out(
    `deploy/provision — environment "${report.environment}" (${report.environmentClass}), mode ${report.mode}`,
  );
  out(
    `1. manifest validation ......... ${report.steps.manifestValidation.passed ? "PASS" : "FAIL"} (${report.steps.manifestValidation.ruleFamilies} rule families; sandbox accounts: ${report.steps.manifestValidation.sandboxAccounts} across ${report.steps.manifestValidation.sandboxAccountEnvironments} environments)`,
  );
  out(
    `2. resource plan .............. ${report.steps.resourcePlan.resources.length} resources (${report.steps.resourcePlan.resources.map((r) => `${r.kind}:${r.name}`).join(", ")})`,
  );
  out(
    `3. secret-reference scaffold .. ${report.steps.secretReferenceScaffold.references} references -> ${report.steps.secretReferenceScaffold.files.length} files (external-only; values never transit this tool)`,
  );
  out(
    `4. sandbox-account records .... ${report.steps.sandboxAccountRecords.records.length} account(s) projected from ${report.steps.sandboxAccountRecords.projectedFrom}`,
  );
  out(
    `5. post-convergence validation  ${report.steps.postConvergenceValidation.passed ? "PASS" : "FAIL"} (${report.steps.postConvergenceValidation.artifactsChecked} artifacts byte-identical to the manifest projection${report.steps.postConvergenceValidation.note === undefined ? "" : `; ${report.steps.postConvergenceValidation.note}`})`,
  );
  out(
    `environment contract ......... ${report.environmentContract.satisfied ? "satisfied" : `${report.environmentContract.problems.length} problem(s)`} (${report.environmentContract.materializedReferences}/${report.environmentContract.expectedReferences} references materialized)`,
  );
  if (report.liveProviderSteps.length === 0) {
    out(
      "live provider steps ......... none for this environment class (local/self-hosted resources)",
    );
  } else {
    out("live provider steps .........");
    for (const step of report.liveProviderSteps) {
      out(
        `  - ${step.kind} "${step.name}" (${step.concern}): ${step.status === "not-run" ? `NOT RUN — ${step.reason}; owner: ${step.owner}` : step.reason}`,
      );
    }
  }
  if (report.mode === "plan") {
    const planned = report.convergence.wouldWrite ?? [];
    out(
      `convergence (dry run) ....... ${planned.length} artifacts projected (${planned.filter((a) => a.state === "matches").length} already converged, ${planned.filter((a) => a.state === "drifts").length} drifted, ${planned.filter((a) => a.state === "absent").length} absent)`,
    );
  } else {
    out(
      `convergence ................. ${report.convergence.alreadyConverged ? "already-converged (no changes)" : `converged (${report.convergence.created.length} created, ${report.convergence.repaired.length} repaired, ${report.convergence.unchanged} unchanged, ${report.convergence.pruned.length} pruned)`}`,
    );
  }
  out(`output root .................. ${report.outputRoot}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);
  const plan = hasFlag(argv, "--plan");
  const json = hasFlag(argv, "--json");

  // Step 1 of the documented convergence: the full deployment
  // configuration gate (fail closed BEFORE anything else runs).
  const validation = validateDeploymentConfiguration();
  if (!validation.valid) {
    console.error(
      `error: deployment configuration validation failed (run bun run deploy:validate for the full report):\n- ${validation.problems.join("\n- ")}`,
    );
    process.exit(1);
  }

  // Repository truth: the manifest set + the provisioning manifests.
  const manifest = loadManifest();
  const quotaGuards = loadQuotaGuardsPolicy(
    readFileSync(join(REPOSITORY_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8"),
  );
  const sandboxAccounts = parseSandboxAccounts(
    readFileSync(
      join(REPOSITORY_ROOT, "deploy", "manifests", SANDBOX_ACCOUNTS_MANIFEST_FILE),
      "utf8",
    ),
    manifest,
    quotaGuards,
  );

  const dataRoot =
    process.env.ZECK_LOCAL_DATA_ROOT !== undefined && process.env.ZECK_LOCAL_DATA_ROOT.length > 0
      ? process.env.ZECK_LOCAL_DATA_ROOT
      : DEFAULT_DATA_ROOT;

  let report: ProvisionReport;
  try {
    report = provisionEnvironment({
      environment,
      branch,
      plan,
      manifest,
      sandboxAccounts,
      env: process.env,
      dataRoot,
      gitRevision: gitRevision(),
      now: () => new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof ProvisionError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  process.exit(0);
}

const IS_ENTRY =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  main();
}
