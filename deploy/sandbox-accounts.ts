/**
 * Sandbox-account provisioning manifest (DEP-002) — the fail-closed
 * parser and projector over `deploy/manifests/sandbox-accounts.json`.
 *
 * The manifest declares, per environment class, the DISPOSABLE
 * sandbox-account set the class permits: synthetic-data policy,
 * quota envelope and expiry semantics. It is PROJECTION INPUT, never
 * a second authority:
 *
 *  - the synthetic-data classes must EQUAL the frozen platform
 *    artifact (src/modules/sandbox — the DEP-014 surface; a drifted
 *    class list is unrepresentable);
 *  - the quota dimensions/windows must come from the budgets module's
 *    closed QUOTA_DIMENSIONS/QUOTA_WINDOWS vocabularies (the budgets
 *    module stays the ONE quota authority);
 *  - the guard wiring must reference guards that exist in
 *    deploy/manifests/quota-guards.json (unknown guard ids abort);
 *  - the TTL must respect the platform's disposable-identity
 *    discipline ("platform-default" TTLs must equal
 *    SANDBOX_IDENTITY_DEFAULT_TTL_MS);
 *  - environments whose environments.json dataPolicy is
 *    "authoritative" (production) declare NO accounts — a disposable
 *    synthetic identity in the authoritative environment is
 *    unrepresentable;
 *  - every DISPOSABLE environment class declares at least one
 *    account (the preview/sandbox environments need their disposable
 *    identity set — the DEP-002 work order).
 *
 * Malformed rows abort BEFORE any provider call or artifact write
 * (the same fail-closed discipline as the core manifest loader and
 * the provider-tiers ledger).
 */

import { QUOTA_DIMENSIONS, QUOTA_WINDOWS } from "../src/modules/budgets/public";
import {
  SANDBOX_IDENTITY_DEFAULT_TTL_MS,
  SYNTHETIC_DATA_POLICY,
} from "../src/modules/sandbox/public";
import type { DeploymentManifest, EnvironmentRecord } from "../src/platform/deployment/manifest";
import type { EnvironmentId } from "../src/platform/deployment/naming";
import type { QuotaGuardsPolicy } from "../src/platform/observability/alerts";

export const SANDBOX_ACCOUNTS_MANIFEST_FILE = "sandbox-accounts.json";

/** The DEP-014 reset discipline (reset NEVER carries state forward). */
export const SANDBOX_ACCOUNT_RESET_SEMANTICS = ["state-non-carrying"] as const;
/** The DEP-014 post-expiry read discipline (records never disappear). */
export const SANDBOX_ACCOUNT_POST_EXPIRY_READ_MODES = ["honest-expired-state"] as const;
/** Where an account's TTL comes from. */
export const SANDBOX_ACCOUNT_TTL_SOURCES = ["platform-default", "declared"] as const;

export type SandboxAccountResetSemantics = (typeof SANDBOX_ACCOUNT_RESET_SEMANTICS)[number];
export type SandboxAccountPostExpiryReadMode =
  (typeof SANDBOX_ACCOUNT_POST_EXPIRY_READ_MODES)[number];
export type SandboxAccountTtlSource = (typeof SANDBOX_ACCOUNT_TTL_SOURCES)[number];

export interface SandboxQuotaDimensionRecord {
  readonly dimension: string;
  readonly limit: string;
  readonly window: string;
}

/** A guard wiring RESOLVED from quota-guards.json (the projection seam). */
export interface SandboxQuotaGuardWiring {
  readonly guard: string;
  readonly warnAtPct: number;
  readonly criticalAtPct: number;
}

export interface SandboxAccountExpiryRecord {
  readonly ttlSource: SandboxAccountTtlSource;
  readonly ttlMs: number;
  readonly reset: SandboxAccountResetSemantics;
  readonly postExpiryReads: SandboxAccountPostExpiryReadMode;
}

export interface SandboxAccountRecord {
  readonly environment: EnvironmentId;
  readonly id: string;
  readonly description: string;
  readonly syntheticDataPolicy: {
    readonly artifact: string;
    readonly version: string;
    readonly permittedClasses: readonly string[];
    readonly prohibitedClasses: readonly string[];
  };
  readonly quotaEnvelope: {
    readonly dimensions: readonly SandboxQuotaDimensionRecord[];
    readonly guards: readonly SandboxQuotaGuardWiring[];
  };
  readonly expiry: SandboxAccountExpiryRecord;
}

export interface SandboxAccountsManifest {
  readonly accounts: Readonly<Record<EnvironmentId, readonly SandboxAccountRecord[]>>;
}

export class SandboxAccountsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `invalid sandbox-accounts manifest (${problems.length} problem(s)):\n- ${problems.join("\n- ")}`,
    );
    this.name = "SandboxAccountsError";
    this.problems = problems;
  }
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown, context: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON object`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON array`);
  }
  return value;
}

function str(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: expected a non-empty string`);
  }
  return value;
}

const ACCOUNT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const POSITIVE_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const ENVIRONMENT_IDS: readonly EnvironmentId[] = ["local", "preview", "staging", "production"];

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

/**
 * Parse and validate the sandbox-accounts manifest against the loaded
 * deployment manifest set and the quota-guards policy.
 *
 * @throws SandboxAccountsError listing every validation problem (fail
 * closed; the full list surfaces drift in one pass — BEFORE any
 * provider call or artifact write).
 */
export function parseSandboxAccounts(
  source: string,
  manifest: DeploymentManifest,
  quotaGuards: QuotaGuardsPolicy,
): SandboxAccountsManifest {
  const problems: string[] = [];
  let document: JsonRecord;
  try {
    document = asRecord(JSON.parse(source), `${SANDBOX_ACCOUNTS_MANIFEST_FILE} (root)`);
  } catch (error) {
    throw new SandboxAccountsError([
      `${SANDBOX_ACCOUNTS_MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`,
    ]);
  }

  if (document.schemaVersion !== 1) {
    problems.push(
      `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: unsupported schemaVersion (expected 1, got ${JSON.stringify(document.schemaVersion)})`,
    );
  }

  const accountsSource = asRecord(document.accounts, "accounts");
  const declaredEnvironments = Object.keys(accountsSource);

  // Unknown environment keys are unrepresentable (the four D1.0
  // classes are the closed matrix).
  for (const key of declaredEnvironments) {
    if (!(ENVIRONMENT_IDS as readonly string[]).includes(key)) {
      problems.push(
        `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: accounts key "${key}" is not a known environment class (local|preview|staging|production)`,
      );
    }
    if (manifest.environments.find((entry) => entry.id === key) === undefined) {
      problems.push(
        `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: accounts key "${key}" has no environments.json record`,
      );
    }
  }
  // Coverage: every environment class of the matrix declares its
  // (possibly empty) account set — an environment missing from the
  // provisioning manifest is drift, not a silent default.
  for (const environment of manifest.environments) {
    if (!declaredEnvironments.includes(environment.id)) {
      problems.push(
        `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: no accounts entry for environment "${environment.id}" (every environment class declares its disposable identity set — empty for authoritative-data classes)`,
      );
    }
  }

  const guardIndex = new Map(quotaGuards.guards.map((rule) => [rule.guard, rule]));
  const accounts: Partial<Record<EnvironmentId, SandboxAccountRecord[]>> = {};

  for (const key of declaredEnvironments) {
    if (!(ENVIRONMENT_IDS as readonly string[]).includes(key)) {
      continue; // already reported above; skip parsing the malformed bucket
    }
    const environment = key as EnvironmentId;
    const context = `accounts.${environment}`;
    const environmentRecord = manifest.environments.find((entry) => entry.id === environment);
    const rows = asArray(accountsSource[key], context);
    const parsed: SandboxAccountRecord[] = [];
    const seenIds = new Set<string>();

    // The authoritative-data rule: production declares NO sandbox
    // accounts (a disposable synthetic identity in the authoritative
    // environment is unrepresentable).
    if (environmentRecord?.dataPolicy === "authoritative" && rows.length > 0) {
      problems.push(
        `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${context} declares ${rows.length} sandbox account(s) but environment "${environment}" has dataPolicy "authoritative" (disposable synthetic identities are unrepresentable in the authoritative environment)`,
      );
    }
    // The disposable-class rule: the preview/sandbox environments
    // need their disposable identity set.
    if (environmentRecord?.environmentClass === "disposable" && rows.length === 0) {
      problems.push(
        `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${context} declares no sandbox account (every disposable environment class needs its disposable identity set — DEP-002)`,
      );
    }

    for (let index = 0; index < rows.length; index += 1) {
      const rowContext = `${context}[${index}]`;
      const row = asRecord(rows[index], rowContext);
      const id = str(row.id, `${rowContext}.id`);
      if (!ACCOUNT_ID_PATTERN.test(id)) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.id must be kebab-case (${ACCOUNT_ID_PATTERN.toString()}; got "${id}")`,
        );
      }
      if (seenIds.has(id)) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}: account id "${id}" appears more than once in environment "${environment}"`,
        );
      }
      seenIds.add(id);

      // Synthetic-data policy: must EQUAL the frozen platform artifact.
      const policySource = asRecord(row.syntheticDataPolicy, `${rowContext}.syntheticDataPolicy`);
      const artifact = str(policySource.artifact, `${rowContext}.syntheticDataPolicy.artifact`);
      const version = str(policySource.version, `${rowContext}.syntheticDataPolicy.version`);
      if (artifact !== SYNTHETIC_DATA_POLICY.artifact) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.syntheticDataPolicy.artifact must be "${SYNTHETIC_DATA_POLICY.artifact}" (the frozen platform policy artifact; got "${artifact}")`,
        );
      }
      if (version !== SYNTHETIC_DATA_POLICY.version) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.syntheticDataPolicy.version must be "${SYNTHETIC_DATA_POLICY.version}" (the platform policy artifact version; got "${version}")`,
        );
      }
      const permittedClasses = asArray(
        policySource.permittedClasses,
        `${rowContext}.syntheticDataPolicy.permittedClasses`,
      ).map((value, i) => str(value, `${rowContext}.syntheticDataPolicy.permittedClasses[${i}]`));
      if (!sameSet(permittedClasses, [...SYNTHETIC_DATA_POLICY.permittedClasses])) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.syntheticDataPolicy.permittedClasses must equal the platform artifact's permitted set (src/modules/sandbox — the ONE policy authority; a drifted class list is unrepresentable)`,
        );
      }
      const prohibitedClasses = asArray(
        policySource.prohibitedClasses,
        `${rowContext}.syntheticDataPolicy.prohibitedClasses`,
      ).map((value, i) => str(value, `${rowContext}.syntheticDataPolicy.prohibitedClasses[${i}]`));
      if (!sameSet(prohibitedClasses, [...SYNTHETIC_DATA_POLICY.prohibitedClasses])) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.syntheticDataPolicy.prohibitedClasses must equal the platform artifact's prohibited set (src/modules/sandbox — the ONE policy authority)`,
        );
      }

      // Quota envelope: closed dimension/window vocabularies +
      // resolved guard wiring.
      const envelopeSource = asRecord(row.quotaEnvelope, `${rowContext}.quotaEnvelope`);
      const dimensionsSource = asArray(
        envelopeSource.dimensions,
        `${rowContext}.quotaEnvelope.dimensions`,
      );
      if (dimensionsSource.length === 0) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.quotaEnvelope.dimensions must be a non-empty array (a sandbox account without a quota envelope is unrepresentable)`,
        );
      }
      const dimensions: SandboxQuotaDimensionRecord[] = [];
      const seenDimensions = new Set<string>();
      for (let d = 0; d < dimensionsSource.length; d += 1) {
        const dimContext = `${rowContext}.quotaEnvelope.dimensions[${d}]`;
        const dimRecord = asRecord(dimensionsSource[d], dimContext);
        const dimension = str(dimRecord.dimension, `${dimContext}.dimension`);
        if (!(QUOTA_DIMENSIONS as readonly string[]).includes(dimension)) {
          problems.push(
            `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${dimContext}.dimension must be one of ${QUOTA_DIMENSIONS.join("|")} (the budgets module quota vocabulary; got "${dimension}")`,
          );
        }
        if (seenDimensions.has(dimension)) {
          problems.push(
            `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${dimContext}: dimension "${dimension}" appears more than once`,
          );
        }
        seenDimensions.add(dimension);
        const limit = str(dimRecord.limit, `${dimContext}.limit`);
        if (!POSITIVE_DECIMAL_PATTERN.test(limit) || BigInt(limit) <= 0n) {
          problems.push(
            `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${dimContext}.limit must be a positive integer decimal string (got "${limit}")`,
          );
        }
        const window = str(dimRecord.window, `${dimContext}.window`);
        if (!(QUOTA_WINDOWS as readonly string[]).includes(window)) {
          problems.push(
            `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${dimContext}.window must be one of ${QUOTA_WINDOWS.join("|")} (got "${window}")`,
          );
        }
        dimensions.push({ dimension, limit, window });
      }

      const guardsSource = asArray(envelopeSource.guards, `${rowContext}.quotaEnvelope.guards`);
      if (guardsSource.length === 0) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.quotaEnvelope.guards must be a non-empty array (the envelope wires into the environment-level quota guards)`,
        );
      }
      const guards: SandboxQuotaGuardWiring[] = [];
      const seenGuards = new Set<string>();
      for (let g = 0; g < guardsSource.length; g += 1) {
        const guard = str(guardsSource[g], `${rowContext}.quotaEnvelope.guards[${g}]`);
        const rule = guardIndex.get(guard);
        if (rule === undefined) {
          problems.push(
            `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.quotaEnvelope.guards[${g}]: guard "${guard}" is not declared in quota-guards.json (unknown environment guard wiring is unrepresentable)`,
          );
          continue;
        }
        if (seenGuards.has(guard)) {
          problems.push(
            `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.quotaEnvelope.guards[${g}]: guard "${guard}" appears more than once`,
          );
          continue;
        }
        seenGuards.add(guard);
        guards.push({
          guard,
          warnAtPct: rule.thresholds.warnAtPct,
          criticalAtPct: rule.thresholds.criticalAtPct,
        });
      }

      // Expiry: the DEP-014 disposable-identity discipline.
      const expirySource = asRecord(row.expiry, `${rowContext}.expiry`);
      const ttlSource = str(expirySource.ttlSource, `${rowContext}.expiry.ttlSource`);
      if (!(SANDBOX_ACCOUNT_TTL_SOURCES as readonly string[]).includes(ttlSource)) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.expiry.ttlSource must be one of ${SANDBOX_ACCOUNT_TTL_SOURCES.join("|")} (got "${ttlSource}")`,
        );
      }
      const ttlMs = expirySource.ttlMs;
      if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.expiry.ttlMs must be a positive integer (milliseconds; got ${JSON.stringify(ttlMs)})`,
        );
      }
      if (
        ttlSource === "platform-default" &&
        (typeof ttlMs !== "number" || ttlMs !== SANDBOX_IDENTITY_DEFAULT_TTL_MS)
      ) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.expiry: ttlSource "platform-default" requires ttlMs to equal the platform default (${SANDBOX_IDENTITY_DEFAULT_TTL_MS} ms — src/modules/sandbox SANDBOX_IDENTITY_DEFAULT_TTL_MS; got ${JSON.stringify(ttlMs)})`,
        );
      }
      const reset = str(expirySource.reset, `${rowContext}.expiry.reset`);
      if (!(SANDBOX_ACCOUNT_RESET_SEMANTICS as readonly string[]).includes(reset)) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.expiry.reset must be "${SANDBOX_ACCOUNT_RESET_SEMANTICS[0]}" (the DEP-014 discipline: reset NEVER carries state forward; got "${reset}")`,
        );
      }
      const postExpiryReads = str(
        expirySource.postExpiryReads,
        `${rowContext}.expiry.postExpiryReads`,
      );
      if (
        !(SANDBOX_ACCOUNT_POST_EXPIRY_READ_MODES as readonly string[]).includes(postExpiryReads)
      ) {
        problems.push(
          `${SANDBOX_ACCOUNTS_MANIFEST_FILE}: ${rowContext}.expiry.postExpiryReads must be "${SANDBOX_ACCOUNT_POST_EXPIRY_READ_MODES[0]}" (the DEP-014 discipline: expired records never silently disappear; got "${postExpiryReads}")`,
        );
      }

      parsed.push({
        environment,
        id,
        description: str(row.description, `${rowContext}.description`),
        syntheticDataPolicy: { artifact, version, permittedClasses, prohibitedClasses },
        quotaEnvelope: { dimensions, guards },
        expiry: {
          ttlSource: ttlSource as SandboxAccountTtlSource,
          ttlMs: typeof ttlMs === "number" ? ttlMs : -1,
          reset: reset as SandboxAccountResetSemantics,
          postExpiryReads: postExpiryReads as SandboxAccountPostExpiryReadMode,
        },
      });
    }
    accounts[environment] = parsed;
  }

  if (problems.length > 0) {
    throw new SandboxAccountsError(problems);
  }

  const empty: Record<EnvironmentId, readonly SandboxAccountRecord[]> = {
    local: [],
    preview: [],
    staging: [],
    production: [],
  };
  for (const environment of ENVIRONMENT_IDS) {
    empty[environment] = accounts[environment] ?? [];
  }
  return { accounts: empty };
}

/** The accounts of one environment class (never undefined). */
export function sandboxAccountsOf(
  ledger: SandboxAccountsManifest,
  environment: EnvironmentId,
): readonly SandboxAccountRecord[] {
  return ledger.accounts[environment];
}

/**
 * Render ONE sandbox-account record document — a PURE projection of
 * the environment record + the manifest account row. No timestamps,
 * no tool-local state: two runs at the same manifest compute
 * byte-identical records (the idempotence contract), and every policy
 * fact traces to its manifest row.
 */
export function renderSandboxAccountDocument(
  environmentRecord: EnvironmentRecord,
  account: SandboxAccountRecord,
  status: "provisioned" | "planned",
): Readonly<Record<string, unknown>> {
  return {
    recordType: "zeck-sandbox-account",
    environment: environmentRecord.id,
    environmentClass: environmentRecord.environmentClass,
    dataPolicy: environmentRecord.dataPolicy,
    credentialScope: environmentRecord.credentialScope,
    accountId: account.id,
    description: account.description,
    syntheticDataPolicy: account.syntheticDataPolicy,
    quotaEnvelope: account.quotaEnvelope,
    expiry: account.expiry,
    status,
    projectedFrom: `deploy/manifests/${SANDBOX_ACCOUNTS_MANIFEST_FILE} (policy facts; never tool-local state)`,
  };
}
