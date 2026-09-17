/**
 * Free-tier-first provider topology ledger (DEP-001 AC4).
 *
 * `deploy/manifests/provider-tiers.json` records, for EVERY provider in
 * providers.json, the tier selected under the roadmap doctrine order
 * (provider free tier → usage-based/no-minimum → low fixed-cost managed
 * → paid only where required), the CURRENT limits/terms as operational
 * constraints (external facts, recorded with an asOf date and a
 * verification status — never architecture), the exhaustion/outage
 * degradation path, and the explicit upgrade/exit note.
 *
 * Fail-closed rules enforced here (and by deploy:validate):
 *  - the tier-class vocabulary is CLOSED and ordered exactly like the
 *    roadmap doctrine;
 *  - every providers.json provider is covered EXACTLY ONCE (a provider
 *    without a tier entry, or a tier entry without a provider, is
 *    unrepresentable — silent provider drift is the failure mode);
 *  - every entry carries non-empty limits, a limits source, terms, an
 *    exhaustion behavior and an upgrade/exit note;
 *  - the exhaustion mode must EQUAL the provider's declared degradation
 *    mode in providers.json (the ledger never invents a degradation
 *    story that the provider map does not declare);
 *  - the AUTHORITATIVE concern (relational-state) on a free tier MUST
 *    carry an upgrade note naming the production path (the roadmap:
 *    disposable free-tier resources must never become operationally
 *    critical);
 *  - the ledger's verification status must be one of the closed
 *    vocabulary values; `recorded-not-live-verified` is the honest
 *    DEP-001 worker-pod state (no cloud credentials — live provider
 *    quota probes are NOT RUN and stay the Lead's credentialed re-run).
 */

import type { DeploymentManifest, ProviderRecord } from "./manifest";

export const PROVIDER_TIER_CLASSES = [
  "provider-free-tier",
  "usage-based-no-minimum",
  "low-fixed-cost-managed",
  "paid-where-required",
] as const;
export type ProviderTierClass = (typeof PROVIDER_TIER_CLASSES)[number];

export const TIER_VERIFICATION_STATUSES = ["live-verified", "recorded-not-live-verified"] as const;
export type TierVerificationStatus = (typeof TIER_VERIFICATION_STATUSES)[number];

export interface TierLimitRecord {
  readonly metric: string;
  readonly value: string;
  readonly unit: string;
}

export interface SelectedTierRecord {
  readonly tierClass: ProviderTierClass;
  readonly tierName: string;
  readonly selectionRationale: string;
}

export interface ExhaustionBehaviorRecord {
  readonly mode: string;
  readonly effect: string;
}

export interface ProviderTierRecord {
  readonly provider: string;
  readonly concern: string;
  readonly selectedTier: SelectedTierRecord;
  readonly limits: readonly TierLimitRecord[];
  readonly limitsSource: string;
  readonly terms: string;
  readonly operationallyCritical: boolean;
  readonly upgradeExit: string;
  readonly exhaustionBehavior: ExhaustionBehaviorRecord;
}

export interface ProviderTiersLedger {
  readonly asOf: string;
  readonly verificationStatus: TierVerificationStatus;
  readonly verificationDetail: string;
  readonly tiers: readonly ProviderTierRecord[];
}

export class ProviderTiersError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `invalid provider-tiers ledger (${problems.length} problem(s)):\n- ${problems.join("\n- ")}`,
    );
    this.name = "ProviderTiersError";
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

function bool(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${context}: expected a boolean`);
  }
  return value;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse and validate the free-tier-first provider topology ledger
 * against the loaded deployment manifest.
 *
 * @throws ProviderTiersError listing every validation problem (fail
 * closed; the full list surfaces drift in one pass).
 */
export function parseProviderTiers(
  source: string,
  manifest: DeploymentManifest,
): ProviderTiersLedger {
  const problems: string[] = [];
  let document: JsonRecord;
  try {
    document = asRecord(JSON.parse(source), "provider-tiers.json");
  } catch (error) {
    throw new ProviderTiersError([
      `provider-tiers.json is not valid JSON: ${(error as Error).message}`,
    ]);
  }

  if (document.schemaVersion !== 1) {
    problems.push(`schemaVersion must be 1 (got: ${JSON.stringify(document.schemaVersion)})`);
  }

  const asOf = str(document.asOf, "asOf");
  if (!ISO_DATE_PATTERN.test(asOf)) {
    problems.push(`asOf must be an ISO calendar date (YYYY-MM-DD); got: "${asOf}"`);
  }

  const verification = asRecord(document.verification, "verification");
  const verificationStatus = str(verification.status, "verification.status");
  if (!(TIER_VERIFICATION_STATUSES as readonly string[]).includes(verificationStatus)) {
    problems.push(
      `verification.status must be one of ${TIER_VERIFICATION_STATUSES.join("|")} (got: "${verificationStatus}")`,
    );
  }
  const verificationDetail = str(verification.detail, "verification.detail");

  const declaredOrder = asArray(document.doctrineOrder, "doctrineOrder").map((entry, index) =>
    str(entry, `doctrineOrder[${index}]`),
  );
  const expectedOrder = PROVIDER_TIER_CLASSES as readonly string[];
  if (
    declaredOrder.length !== expectedOrder.length ||
    declaredOrder.some((entry, index) => entry !== expectedOrder[index])
  ) {
    problems.push(
      `doctrineOrder must equal the roadmap doctrine order [${expectedOrder.join(" -> ")}] (got: [${declaredOrder.join(" -> ")}])`,
    );
  }

  const tiersRaw = asArray(document.tiers, "tiers");
  const tiers: ProviderTierRecord[] = [];
  const seenProviders = new Set<string>();
  for (let index = 0; index < tiersRaw.length; index += 1) {
    const context = `tiers[${index}]`;
    const entry = asRecord(tiersRaw[index], context);
    const provider = str(entry.provider, `${context}.provider`);
    const concern = str(entry.concern, `${context}.concern`);

    const selectedTierRaw = asRecord(entry.selectedTier, `${context}.selectedTier`);
    const tierClass = str(selectedTierRaw.tierClass, `${context}.selectedTier.tierClass`);
    if (!(PROVIDER_TIER_CLASSES as readonly string[]).includes(tierClass)) {
      problems.push(
        `${context}: selectedTier.tierClass must be one of ${PROVIDER_TIER_CLASSES.join("|")} (got: "${tierClass}")`,
      );
    }

    const limitsRaw = asArray(entry.limits, `${context}.limits`);
    if (limitsRaw.length === 0) {
      problems.push(
        `${context}: limits must be a non-empty array (exact tested limits are the AC4 record)`,
      );
    }
    const limits = limitsRaw.map((limitRaw, limitIndex) => {
      const limitContext = `${context}.limits[${limitIndex}]`;
      const limit = asRecord(limitRaw, limitContext);
      return {
        metric: str(limit.metric, `${limitContext}.metric`),
        value: str(limit.value, `${limitContext}.value`),
        unit: str(limit.unit, `${limitContext}.unit`),
      };
    });

    const exhaustionRaw = asRecord(entry.exhaustionBehavior, `${context}.exhaustionBehavior`);
    const exhaustionBehavior = {
      mode: str(exhaustionRaw.mode, `${context}.exhaustionBehavior.mode`),
      effect: str(exhaustionRaw.effect, `${context}.exhaustionBehavior.effect`),
    };

    tiers.push({
      provider,
      concern,
      selectedTier: {
        tierClass: tierClass as ProviderTierClass,
        tierName: str(selectedTierRaw.tierName, `${context}.selectedTier.tierName`),
        selectionRationale: str(
          selectedTierRaw.selectionRationale,
          `${context}.selectedTier.selectionRationale`,
        ),
      },
      limits,
      limitsSource: str(entry.limitsSource, `${context}.limitsSource`),
      terms: str(entry.terms, `${context}.terms`),
      operationallyCritical: bool(entry.operationallyCritical, `${context}.operationallyCritical`),
      upgradeExit: str(entry.upgradeExit, `${context}.upgradeExit`),
      exhaustionBehavior,
    });

    if (seenProviders.has(provider)) {
      problems.push(`${context}: provider "${provider}" appears more than once`);
    }
    seenProviders.add(provider);

    // Cross-consistency against the provider map.
    const providerRecord: ProviderRecord | undefined = manifest.providers.find(
      (candidate) => candidate.id === provider,
    );
    if (providerRecord === undefined) {
      problems.push(`${context}: provider "${provider}" is not declared in providers.json`);
    } else {
      if (providerRecord.concern !== concern) {
        problems.push(
          `${context}: concern "${concern}" disagrees with providers.json ("${providerRecord.concern}" for provider "${provider}")`,
        );
      }
      if (exhaustionBehavior.mode !== providerRecord.degradation.mode) {
        problems.push(
          `${context}: exhaustionBehavior.mode "${exhaustionBehavior.mode}" disagrees with the providers.json declared degradation mode "${providerRecord.degradation.mode}"`,
        );
      }
      // The authoritative concern on a free tier must carry the
      // production upgrade path (roadmap: disposable free-tier resources
      // must never become operationally critical).
      if (
        providerRecord.degradation.authority === "authoritative" &&
        tierClass === "provider-free-tier" &&
        entry.upgradeExit === undefined
      ) {
        problems.push(
          `${context}: the authoritative concern on a free tier must declare an upgrade/exit note`,
        );
      }
    }
  }

  // Coverage: every providers.json provider has exactly one tier entry.
  for (const provider of manifest.providers) {
    if (!seenProviders.has(provider.id)) {
      problems.push(
        `providers.json provider "${provider.id}" (concern "${provider.concern}") has no tier entry in provider-tiers.json`,
      );
    }
  }

  if (problems.length > 0) {
    throw new ProviderTiersError(problems);
  }
  return {
    asOf,
    verificationStatus: verificationStatus as TierVerificationStatus,
    verificationDetail,
    tiers,
  };
}

/** Look up the tier record of a provider (undefined when absent). */
export function tierOfProvider(
  ledger: ProviderTiersLedger,
  providerId: string,
): ProviderTierRecord | undefined {
  return ledger.tiers.find((tier) => tier.provider === providerId);
}
