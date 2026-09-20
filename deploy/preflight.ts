/**
 * deploy/preflight — the account/credential preflight + provider-tier
 * fact reconciliation (PPR-002 — Live Free-Tier-First Public Preview
 * Deployment, provisioning-order steps 1-2).
 *
 * The FIRST command of the PPR-002 credentialed operator sequence
 * (deploy/PUBLIC-DEPLOYMENT.md §3.2): before any provider resource is
 * touched, one tool reports — fail-closed — everything the sequence
 * needs to start clean:
 *
 *   1. CONFIGURATION GATE — the full deploy:validate rule families
 *      run FIRST (malformed manifests abort before anything else);
 *   2. URL HYGIENE — every URL-typed variable of the variable
 *      contract that is present in this environment is checked for
 *      URL-embedded credentials (scheme://user:password@host — the
 *      same pattern class the architecture secret-scan pins over
 *      deploy/**; a violation REFUSES, the value is never rendered);
 *   3. ACCOUNT/CREDENTIAL PREFLIGHT — the environment's provider
 *      resource set with the account-plane credential variable each
 *      kind requires (PRESENCE ONLY, never values): present ⇒ the
 *      deterministic plan is executable for the credentialed operator
 *      application path; absent ⇒ an honest not-run row with its
 *      owner (this tool performs no provider control-plane calls —
 *      provider-neutrality doctrine);
 *   4. PROVIDER-TIER FACT RECONCILIATION — the refreshed ledger
 *      (deploy/manifests/provider-tiers.json) re-loaded fail-closed,
 *      every entry carrying its per-entry asOf, source (the
 *      provider's public documentation URL, or the repository
 *      contract path for repository-defined entries) and verification
 *      status; the ledger age is reported informationally and the
 *      live re-verification is recorded NOT RUN with its owner;
 *   5. COMMERCIAL BOUNDARY — the Vercel Hobby non-commercial preview
 *      rail, quoted from the provider map and the tier ledger.
 *
 * The tool adds NO authority and redesigns nothing: it reads the same
 * manifests as deploy:validate/deploy:provision (sharing the exact
 * credential-variable mapping with deploy/provision), performs no
 * writes, and no network calls. Exit 0 = the preflight passed (the
 * honest not-run rows are facts, not failures); exit 1 = fail-closed
 * problems (configuration invalid, URL-hygiene violation, or a ledger
 * entry missing its PPR-002 reconciliation fields); exit 2 = usage.
 *
 * Usage:
 *   bun deploy/preflight.ts --environment preview [--branch work/PPR-002-x]
 *   bun deploy/preflight.ts --environment local
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { namingConventionsOf } from "../src/platform/deployment/identity";
import type { DeploymentManifest } from "../src/platform/deployment/manifest";
import { computeResourceNames, previewBranchSlug } from "../src/platform/deployment/naming";
import { parseProviderTiers } from "../src/platform/deployment/provider-tiers";
import {
  gitRevision,
  loadManifest,
  optionalBranch,
  REPOSITORY_ROOT,
  requireEnvironment,
} from "./lib";
import { credentialPresent, RESOURCE_KIND_CREDENTIAL_VARIABLES } from "./provision";
import { validateDeploymentConfiguration } from "./validate";

const NOT_RUN_OWNER =
  "Lead credentialed re-run (deploy/PUBLIC-DEPLOYMENT.md §3.2 PPR-002 sequence)";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const URL_EMBEDDED_CREDENTIAL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'@/:]+:[^\s"'@]+@/i;
const HTTPS_URL_PATTERN = /^https?:\/\//;

/** The variable-contract types whose values are URLs (hygiene scope). */
export const URL_TYPED_VARIABLE_TYPES: readonly string[] = [
  "postgres-url",
  "http-url",
  "redis-url",
];

/** The closed per-entry verification vocabulary (the ledger's own). */
export const TIER_ENTRY_VERIFICATION_STATUSES: readonly string[] = [
  "live-verified",
  "recorded-not-live-verified",
];

// ---------------------------------------------------------------------------
// The PPR-002 provisioning order as data (the unit test pins it) — every
// step of the order has a script path; this tool owns steps 1-2.
// ---------------------------------------------------------------------------

export interface ProvisioningOrderStep {
  readonly step: string;
  readonly script: string;
  readonly ownedByThisTool: boolean;
}

export const PROVISIONING_ORDER: readonly ProvisioningOrderStep[] = Object.freeze([
  {
    step: "account/credential preflight",
    script: "deploy/preflight.ts",
    ownedByThisTool: true,
  },
  {
    step: "provider-tier fact reconciliation",
    script: "deploy/preflight.ts",
    ownedByThisTool: true,
  },
  {
    step: "Neon + migrations",
    script: "deploy/bootstrap.ts (local rails) / deploy:migrate (deterministic migrations)",
    ownedByThisTool: false,
  },
  {
    step: "R2",
    script: "deploy/provision.ts (resource plan) + deploy/smoke.ts (artifact-store probe)",
    ownedByThisTool: false,
  },
  {
    step: "Queues / Workflows",
    script: "deploy/queue.ts + deploy/workflow.ts",
    ownedByThisTool: false,
  },
  {
    step: "Upstash",
    script: "deploy/provision.ts (resource plan) + deploy/smoke.ts (coordination probe)",
    ownedByThisTool: false,
  },
  {
    step: "governed runner",
    script: "deploy/worker.ts + the container-runner REST contract (deploy/README.md)",
    ownedByThisTool: false,
  },
  {
    step: "Vercel delivery",
    script: "deploy/api.ts (the independently-runnable host; Vercel Hobby where terms permit)",
    ownedByThisTool: false,
  },
  {
    step: "identity",
    script: "deploy/identity.ts",
    ownedByThisTool: false,
  },
  {
    step: "health",
    script: "deploy/public-smoke.ts (/health) + deploy/smoke.ts",
    ownedByThisTool: false,
  },
  {
    step: "public smoke",
    script: "deploy/public-smoke.ts (exact-revision full-route smoke)",
    ownedByThisTool: false,
  },
  {
    step: "sandbox first-run",
    script:
      "deploy/provision.ts (sandbox-account records) — the live first execution is the deployed plane's boundary (Lead credentialed re-run)",
    ownedByThisTool: false,
  },
  {
    step: "validation rerun",
    script: "bun run test (the full suite at the deployed revision)",
    ownedByThisTool: false,
  },
  {
    step: "browser acceptance",
    script: "PPR-003 public user-journey acceptance harness (separate work order)",
    ownedByThisTool: false,
  },
] as const);

// ---------------------------------------------------------------------------
// URL hygiene (the B5 pattern class, over the variable contract)
// ---------------------------------------------------------------------------

export interface UrlHygieneResult {
  /** The URL-typed contract variables present in this environment. */
  readonly checkedVariables: readonly string[];
  /** Fail-closed violations (variable NAMES only — never values). */
  readonly violations: readonly string[];
}

/**
 * Check every present URL-typed variable of the contract for
 * URL-embedded credentials. A violation is fail-closed: the operator
 * must move the credential out of the URL (local rails are configured
 * credential-less; runtime credentials ride zeck-secret:// references).
 */
export function checkUrlHygiene(
  manifest: DeploymentManifest,
  env: Readonly<Record<string, string | undefined>>,
): UrlHygieneResult {
  const urlTyped = manifest.variables.filter((variable) =>
    (URL_TYPED_VARIABLE_TYPES as readonly string[]).includes(variable.type),
  );
  const present = urlTyped.filter((variable) => env[variable.name] !== undefined);
  const violations: string[] = [];
  for (const variable of present) {
    const value = env[variable.name] ?? "";
    if (URL_EMBEDDED_CREDENTIAL_PATTERN.test(value)) {
      violations.push(
        `${variable.name} carries URL-embedded credentials (scheme://user:password@host) — refusing: ${variable.type} variables are configured credential-less (the same pattern the repository secret-scan pins over deploy/**; move the credential into the environment's secret materialization)`,
      );
    }
  }
  return { checkedVariables: present.map((variable) => variable.name), violations };
}

// ---------------------------------------------------------------------------
// Account/credential preflight (presence-gated, never values)
// ---------------------------------------------------------------------------

export interface CredentialPreflightRow {
  readonly concern: string;
  readonly provider: string | null;
  readonly kind: string;
  readonly name: string;
  readonly credentialVariable: string | null;
  readonly credentialsPresent: boolean | null;
  readonly status: "executable-plan" | "not-run" | "local-self-hosted";
  readonly owner: string | null;
}

export interface CredentialPreflight {
  readonly rows: readonly CredentialPreflightRow[];
  readonly executable: number;
  readonly notRun: number;
  readonly localSelfHosted: number;
}

/**
 * The environment's provider resource set with the account-plane
 * credential each kind requires (PRESENCE ONLY). The credential
 * mapping is SHARED with deploy/provision (one list, never two).
 */
export function credentialPreflightOf(
  manifest: DeploymentManifest,
  environment: "local" | "preview" | "staging" | "production",
  env: Readonly<Record<string, string | undefined>>,
  branch?: string,
): CredentialPreflight {
  const conventions = namingConventionsOf(manifest);
  const slug =
    environment === "preview" && branch !== undefined
      ? previewBranchSlug(branch, conventions.previewBranchSlugMaxLength)
      : undefined;
  const names = computeResourceNames(
    conventions,
    environment,
    manifest.resources[environment],
    slug,
  );
  const resources = manifest.resources[environment];
  const rows: CredentialPreflightRow[] = [];
  for (const [index, name] of names.entries()) {
    const concern = resources[index]?.concern ?? "-";
    const provider = manifest.providers.find((entry) => entry.concern === concern) ?? null;
    const credentialVariable = RESOURCE_KIND_CREDENTIAL_VARIABLES[name.kind] ?? null;
    if (credentialVariable === null) {
      rows.push({
        concern,
        provider: provider?.id ?? null,
        kind: name.kind,
        name: name.name,
        credentialVariable: null,
        credentialsPresent: null,
        status: "local-self-hosted",
        owner: null,
      });
      continue;
    }
    const present = credentialPresent(env, credentialVariable);
    rows.push({
      concern,
      provider: provider?.id ?? null,
      kind: name.kind,
      name: name.name,
      credentialVariable,
      credentialsPresent: present,
      status: present ? "executable-plan" : "not-run",
      owner: present ? null : NOT_RUN_OWNER,
    });
  }
  return {
    rows,
    executable: rows.filter((row) => row.status === "executable-plan").length,
    notRun: rows.filter((row) => row.status === "not-run").length,
    localSelfHosted: rows.filter((row) => row.status === "local-self-hosted").length,
  };
}

// ---------------------------------------------------------------------------
// Provider-tier fact reconciliation (PPR-002 required fact reconciliation)
// ---------------------------------------------------------------------------

export interface TierReconciliationEntry {
  readonly provider: string;
  readonly concern: string;
  readonly tierClass: string;
  readonly tierName: string;
  readonly asOf: string;
  readonly source: string;
  readonly sourceKind: "provider-documentation" | "repository-contract";
  readonly verification: string;
  readonly daysSinceAsOf: number;
}

export interface TierReconciliation {
  readonly ledgerAsOf: string;
  readonly verificationStatus: string;
  readonly entries: readonly TierReconciliationEntry[];
  readonly recordedNotLiveVerified: number;
  readonly liveVerified: number;
  readonly liveReverification: {
    readonly status: "not-run";
    readonly owner: string;
    readonly note: string;
  };
  readonly problems: readonly string[];
}

function daysBetween(fromIsoDate: string, toDate: Date): number {
  const from = Date.parse(`${fromIsoDate}T00:00:00Z`);
  if (Number.isNaN(from)) {
    return Number.NaN;
  }
  const to = Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate());
  return Math.floor((to - from) / 86_400_000);
}

/**
 * Reconcile the refreshed tier ledger: the parser's structural gate
 * (coverage, vocabularies, degradation equality) PLUS the PPR-002
 * per-entry contract — every entry carries its own asOf (ISO calendar
 * date, not in the future), source (an http(s) documentation URL for
 * external providers, or an existing repository contract path for
 * repository-defined entries) and a verification status from the
 * closed vocabulary. The ledger age is reported informationally (no
 * invented staleness threshold); the LIVE re-verification is recorded
 * NOT RUN with its owner.
 */
export function reconcileProviderTiers(
  ledgerSource: string,
  manifest: DeploymentManifest,
  runDate: Date,
  repositoryRoot: string,
): TierReconciliation {
  const problems: string[] = [];
  // The structural gate first (coverage exactly-once, closed
  // vocabularies, degradation-mode equality) — a structural failure
  // throws with the full problem list.
  const ledger = parseProviderTiers(ledgerSource, manifest);
  const raw = JSON.parse(ledgerSource) as { tiers?: Record<string, unknown>[] };
  const rawByProvider = new Map<string, Record<string, unknown>>();
  for (const entry of raw.tiers ?? []) {
    const provider = entry.provider;
    if (typeof provider === "string") {
      rawByProvider.set(provider, entry);
    }
  }

  const entries: TierReconciliationEntry[] = [];
  for (const tier of ledger.tiers) {
    const rawEntry = rawByProvider.get(tier.provider) ?? {};
    const context = `provider "${tier.provider}"`;
    const asOf = typeof rawEntry.asOf === "string" ? rawEntry.asOf : "";
    if (asOf === "") {
      problems.push(
        `${context}: the per-entry asOf is required (the PPR-002 refresh records when each fact was taken)`,
      );
    } else if (!ISO_DATE_PATTERN.test(asOf)) {
      problems.push(
        `${context}: the per-entry asOf must be an ISO calendar date (YYYY-MM-DD); got: "${asOf}"`,
      );
    }
    const days = asOf === "" ? Number.NaN : daysBetween(asOf, runDate);
    if (!Number.isNaN(days) && days < 0) {
      problems.push(
        `${context}: the per-entry asOf "${asOf}" is in the future relative to the run date — a fact cannot be recorded before it is taken`,
      );
    }

    const source = typeof rawEntry.source === "string" ? rawEntry.source.trim() : "";
    let sourceKind: TierReconciliationEntry["sourceKind"] = "provider-documentation";
    if (source === "") {
      problems.push(
        `${context}: the per-entry source is required (the provider's public documentation URL, or the repository contract path for repository-defined entries)`,
      );
    } else if (HTTPS_URL_PATTERN.test(source)) {
      sourceKind = "provider-documentation";
    } else if (existsSync(resolve(repositoryRoot, source))) {
      sourceKind = "repository-contract";
    } else {
      problems.push(
        `${context}: the per-entry source "${source}" is neither an http(s) documentation URL nor an existing repository contract path`,
      );
    }

    const verification = typeof rawEntry.verification === "string" ? rawEntry.verification : "";
    if (!(TIER_ENTRY_VERIFICATION_STATUSES as readonly string[]).includes(verification)) {
      problems.push(
        `${context}: the per-entry verification status must be one of ${TIER_ENTRY_VERIFICATION_STATUSES.join("|")} (got: "${verification}")`,
      );
    }

    entries.push({
      provider: tier.provider,
      concern: tier.concern,
      tierClass: tier.selectedTier.tierClass,
      tierName: tier.selectedTier.tierName,
      asOf,
      source,
      sourceKind,
      verification,
      daysSinceAsOf: Number.isNaN(days) ? -1 : days,
    });
  }

  const liveVerified = entries.filter((entry) => entry.verification === "live-verified").length;
  return {
    ledgerAsOf: ledger.asOf,
    verificationStatus: ledger.verificationStatus,
    entries,
    recordedNotLiveVerified: entries.length - liveVerified,
    liveVerified,
    liveReverification: {
      status: "not-run",
      owner: NOT_RUN_OWNER,
      note: "the recorded free-tier facts were NOT verified against the live provider consoles/quota APIs from this environment (no credentials); the credentialed operator re-verifies each entry against its recorded source before provisioning and upgrades the per-entry verification status to live-verified (drift is an operational update to the ledger, never a silent assumption)",
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// The composed report
// ---------------------------------------------------------------------------

export interface PreflightReport {
  readonly tool: "deploy/preflight";
  readonly environment: "local" | "preview" | "staging" | "production";
  readonly environmentClass: string;
  readonly gitRevision: string;
  readonly configurationGate: {
    readonly passed: boolean;
    readonly problems: readonly string[];
  };
  readonly urlHygiene: UrlHygieneResult;
  readonly credentialPreflight: CredentialPreflight;
  readonly tierReconciliation: TierReconciliation;
  readonly commercialBoundary: {
    readonly deliveryProvider: string;
    readonly ledgerTerms: string;
    readonly providerMapCommercialUse: string | null;
    readonly rule: string;
  };
  readonly provisioningOrder: readonly ProvisioningOrderStep[];
  readonly notRun: readonly {
    readonly check: string;
    readonly reason: string;
    readonly owner: string;
  }[];
  readonly problems: readonly string[];
  readonly passed: boolean;
}

export interface PreflightInput {
  readonly environment: "local" | "preview" | "staging" | "production";
  readonly manifest: DeploymentManifest;
  readonly ledgerSource: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runDate: Date;
  readonly gitRevision: string;
  readonly repositoryRoot: string;
  readonly branch?: string;
  /** The configuration-gate result (deploy:validate core). */
  readonly configurationGate: { readonly passed: boolean; readonly problems: readonly string[] };
}

/** Compose the full preflight report (pure; the CLI wires the inputs). */
export function runPreflight(input: PreflightInput): PreflightReport {
  const { manifest } = input;
  const environmentRecord = manifest.environments.find((entry) => entry.id === input.environment);
  if (environmentRecord === undefined) {
    throw new Error(`unknown environment: ${input.environment}`);
  }

  const urlHygiene = checkUrlHygiene(manifest, input.env);
  const credentialPreflight = credentialPreflightOf(
    manifest,
    input.environment,
    input.env,
    input.branch,
  );
  const tierReconciliation = reconcileProviderTiers(
    input.ledgerSource,
    manifest,
    input.runDate,
    input.repositoryRoot,
  );

  const vercel = tierReconciliation.entries.find((entry) => entry.provider === "vercel");
  const vercelProvider = manifest.providers.find((entry) => entry.id === "vercel");
  const commercialBoundary = {
    deliveryProvider: "vercel",
    ledgerTerms: vercel?.tierName === undefined ? "" : String(vercel.tierName),
    providerMapCommercialUse: vercelProvider?.commercialUse ?? null,
    rule: "Vercel Hobby preview is the non-commercial preview rail; commercial production requires a commercially permitted plan (e.g. Vercel Pro) or an alternate host, and the authoritative relational concern must not remain on a free tier for commercial production (upgrade paths recorded in the tier ledger).",
  };

  const problems: string[] = [];
  if (!input.configurationGate.passed) {
    problems.push(
      `the deployment configuration gate failed (${input.configurationGate.problems.length} problem(s); run bun run deploy:validate for the full report)`,
    );
  }
  problems.push(...urlHygiene.violations);
  problems.push(...tierReconciliation.problems);

  const notRun = [
    {
      check:
        "live verification of the recorded provider free-tier facts against the provider consoles/quota APIs",
      reason:
        "No cloud credentials exist in this environment; the ledger's per-entry sources are the recorded pointers. The credentialed operator re-verifies each limit against its source before provisioning and upgrades the per-entry verification status (drift is an operational ledger update).",
      owner: NOT_RUN_OWNER,
    },
    {
      check:
        "live-provider resource creation (Neon project/branch, R2 bucket, Cloudflare Queues/Workflows, Upstash, Vercel)",
      reason:
        "Account-plane work gated on credential PRESENCE (never values): every absent credential is an honest not-run row in credentialPreflight with its owner; this tool performs no provider control-plane calls (provider-neutrality doctrine).",
      owner: NOT_RUN_OWNER,
    },
  ];

  return {
    tool: "deploy/preflight",
    environment: input.environment,
    environmentClass: environmentRecord.environmentClass,
    gitRevision: input.gitRevision,
    configurationGate: input.configurationGate,
    urlHygiene,
    credentialPreflight,
    tierReconciliation,
    commercialBoundary,
    provisioningOrder: PROVISIONING_ORDER,
    notRun,
    problems,
    passed: problems.length === 0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const environment = requireEnvironment(argv);
  const branch = optionalBranch(argv);

  const validation = validateDeploymentConfiguration();
  const manifest = loadManifest();
  const ledgerSource = readFileSync(
    resolve(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"),
    "utf8",
  );
  const report = runPreflight({
    environment,
    manifest,
    ledgerSource,
    env: process.env,
    runDate: new Date(),
    gitRevision: gitRevision(),
    repositoryRoot: REPOSITORY_ROOT,
    ...(branch === undefined ? {} : { branch }),
    configurationGate: {
      passed: validation.valid,
      problems: validation.problems,
    },
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

const IS_ENTRY =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  main();
}
