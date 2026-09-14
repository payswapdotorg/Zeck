/**
 * The competing-stack configuration declaration (VAL-043, acceptance
 * criteria 1, 2 and 4).
 *
 * The COMPETING GATEWAY/ROUTER STACK's EXPLICIT, EXHAUSTIVE,
 * CONTENT-ADDRESSED configuration — the real market alternative a
 * customer could use instead of Zeck, configured per ITS OWN
 * documented best practices. In this environment the competitor is
 * instantiated as OPENROUTER ITSELF in its documented gateway/router
 * posture: the same pinned models, routed through OpenRouter's own
 * gateway semantics with its documented defaults (the natural
 * competing instantiation of the VAL-005 competing-stack arm).
 *
 * The configuration is the exhaustiveness contract — the
 * conformance oracle FAILs any run where the competitor applies a
 * setting the declaration does not name (an UNDOCUMENTED
 * configuration toggle — the masquerade catch), and every declared
 * entry carries the toggle's DOCUMENTED reference (the competitor's
 * own documentation of the behavior — a toggle without a documented
 * source fails the structural validation: the declaration is
 * exhaustive BY CONSTRUCTION, never asserted).
 *
 *   * MODEL SELECTION BY TASK CLASS — the customer's declared
 *     per-class model slugs through the competitor's catalog, every
 *     route priced through the pinned VAL-040 manifest (public list
 *     prices only — negotiated rates are FORBIDDEN);
 *   * PROVIDER POOL ROUTING — the competitor's own pool ordering
 *     (its documented default): the gateway may route equivalent
 *     requests to different pool endpoints — the nondeterministic
 *     routing is DECLARED honest variance (the reproducibility
 *     oracle's declared path: variance either reproduces or carries
 *     the declaration with the Wilson confidence on the comparison);
 *   * AUTOMATIC PROVIDER FALLBACK — the competitor's documented
 *     retry-across-providers behavior, bounded by the declared
 *     internal-retry maximum (the retry amortization happens INSIDE
 *     the competitor's boundary: one request reports the aggregate
 *     usage its gateway saw, internal attempts included);
 *   * GENERATION USAGE ACCOUNTING — the competitor's generation-data
 *     usage and cost fields: the reported usage is the measured fact;
 *     the rail's OWN charge is a CROSS-CHECK OBSERVATION ONLY — the
 *     canonical comparison basis prices measured tokens through the
 *     pinned manifest so every arm compares at the SAME public list
 *     prices (never the rail's negotiated/actual charge);
 *   * REQUEST DEFAULTS — the competitor's documented defaults
 *     (temperature unset → the model's own default; provider sort
 *     unset → the pool's own ordering);
 *   * COMPLETION BUDGET PINNED — max_tokens pinned explicitly on
 *     every request (the OpenRouter unaffordable-budget 402 lesson:
 *     completion budgets are pinned, never omitted).
 *
 * The declaration is CONTENT-ADDRESSED alongside the VAL-040 price
 * manifests (the same discipline): each revision's digest is the
 * SHA-256 over the canonical JSON of its entries + model-selection
 * table + fallback route, the registry is APPEND-ONLY (a correction
 * is a NEW revision — `supersedes` the old one, which stays frozen
 * and readable), and an in-place mutation breaks digest agreement
 * mechanically (the configuration-integrity catch).
 *
 * Everything here is PURE (node:crypto digest over canonical JSON —
 * mirroring the price manifest's pinning discipline).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// The configuration vocabulary
// ---------------------------------------------------------------------------

/** The configuration-toggle kinds the declaration may carry. */
export type CompetitorConfigKind =
  | "model-selection"
  | "provider-routing"
  | "retry-policy"
  | "usage-accounting"
  | "request-defaults"
  | "completion-budget";

/**
 * One named, bounded configuration toggle the competing stack may
 * apply — every entry carries its DOCUMENTED reference (the
 * competitor's own documentation of the toggle: the declaration is
 * exhaustive by construction, and an undocumented toggle cannot
 * appear in it).
 */
export interface CompetitorConfigEntry {
  /** The toggle's NAME (the conformance oracle's key). */
  readonly name: string;
  readonly kind: CompetitorConfigKind;
  /** The bounded parameters (the toggle's declared configuration). */
  readonly bound: Readonly<Record<string, unknown>>;
  readonly description: string;
  /**
   * The toggle's DOCUMENTED source — the competitor's own public
   * documentation of the behavior (a toggle without a documented
   * reference fails the structural validation: "configured per its
   * own documented best practices" is a mechanical property here).
   */
  readonly documentedRef: string;
}

/** One declared route of the competitor's model-selection table. */
export interface CompetitorModelSelection {
  /** The task class this selection serves (or "fallback"). */
  readonly taskClass: string;
  /** The provider rail the class rides (priced in the pinned manifest). */
  readonly provider: string;
  /** The competitor's model slug for the class. */
  readonly model: string;
}

/** One immutable, content-addressed configuration revision. */
export interface CompetitorConfigRevision {
  readonly revision: string;
  readonly entries: readonly CompetitorConfigEntry[];
  /** The model-selection table (the model-selection toggle's bound). */
  readonly routes: readonly CompetitorModelSelection[];
  /** The selection for classes the table does not name (the conservative default). */
  readonly fallbackRoute: CompetitorModelSelection;
  /** The content digest: sha256 over the canonical entries + routes + fallback. */
  readonly digest: string;
  /** The revision this one corrects (absent on the first revision). */
  readonly supersedes?: string;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Compute the content digest over entries + routes + fallbackRoute. */
export function computeCompetitorConfigDigest(input: {
  readonly entries: readonly CompetitorConfigEntry[];
  readonly routes: readonly CompetitorModelSelection[];
  readonly fallbackRoute: CompetitorModelSelection;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        entries: input.entries,
        fallbackRoute: input.fallbackRoute,
        routes: input.routes,
      }),
    )
    .digest("hex")}`;
}

// ---------------------------------------------------------------------------
// The toggle names (the conformance oracle's key vocabulary)
// ---------------------------------------------------------------------------

/** The model-selection toggle's name. */
export const MODEL_SELECTION_NAME = "model-selection-by-task-class";

/** The provider-pool-routing toggle's name. */
export const PROVIDER_ROUTING_NAME = "provider-pool-routing";

/** The automatic-provider-fallback toggle's name. */
export const RETRY_POLICY_NAME = "automatic-provider-fallback";

/** The generation-usage-accounting toggle's name. */
export const USAGE_ACCOUNTING_NAME = "generation-usage-accounting";

/** The request-defaults toggle's name. */
export const REQUEST_DEFAULTS_NAME = "request-defaults-documented";

/** The completion-budget toggle's name. */
export const COMPLETION_BUDGET_NAME = "completion-budget-pinned";

// ---------------------------------------------------------------------------
// The pinned entries (the declared configuration set)
// ---------------------------------------------------------------------------

/** The model-selection entry (the model-selection table rides the revision). */
const MODEL_SELECTION_ENTRY: CompetitorConfigEntry = {
  name: MODEL_SELECTION_NAME,
  kind: "model-selection",
  bound: {
    keying: "task-class",
    classes: ["summarize", "extract", "translate", "transform-batch"],
    fallback: "the fallback selection serves every class the table does not name",
  },
  description:
    "the customer's declared per-class model slugs through the competitor's catalog (every route priced through the pinned VAL-040 manifest revisions — public list prices only); the model-selection table is part of the content-addressed configuration revision",
  documentedRef:
    "https://openrouter.ai/docs/use-cases/usage-data-and-metering plus the gateway's task-class routing guidance (pinned snapshot — the competitor's own documentation of model selection by slug)",
};

/**
 * The provider-pool-routing entry: the competitor's OWN pool ordering
 * (its documented default). The nondeterministic routing across the
 * pool is DECLARED HONEST VARIANCE — the reproducibility oracle's
 * declared path (a competitor behavior change between runs FAILs
 * UNLESS declared, with the Wilson 95% confidence carried on the
 * comparison — the confidence discipline is enforced by the frozen
 * VAL-040 protocol battery, never waived).
 */
const PROVIDER_ROUTING_ENTRY: CompetitorConfigEntry = {
  name: PROVIDER_ROUTING_NAME,
  kind: "provider-routing",
  bound: {
    ordering: "pool-default",
    providerSort: "unset (the pool's own ordering)",
    variance:
      "declared (the gateway may route equivalent requests to different pool endpoints across rounds and runs — nondeterministic routing is honest variance, carried with the Wilson 95% interval on every comparison)",
  },
  description:
    "the competitor's documented default pool routing: the gateway selects the pool endpoint per its own ordering; the nondeterminism is DECLARED honest variance (the comparison never waives its confidence interval)",
  documentedRef:
    "https://openrouter.ai/docs/features/provider-routing (pinned snapshot — the competitor's own documentation of provider routing and ordering)",
};

/** The automatic-provider-fallback entry (the competitor's retry posture). */
function retryPolicyEntry(bound: {
  readonly maxInternalRetries: number;
  readonly description: string;
}): CompetitorConfigEntry {
  return {
    name: RETRY_POLICY_NAME,
    kind: "retry-policy",
    bound: {
      maxInternalRetries: bound.maxInternalRetries,
      retriedCategories: ["rate-limit", "provider-unavailable"],
      accounting:
        "the internal retries happen INSIDE the competitor's boundary: one request reports the aggregate usage its gateway saw (internal attempts included) — the amortization is visible as the request's own measured usage, never a second request",
    },
    description: bound.description,
    documentedRef:
      "https://openrouter.ai/docs/features/automatic-fallbacks (pinned snapshot — the competitor's own documentation of automatic retry across providers)",
  };
}

/** The cmp-rev-001 retry posture: up to 2 internal retries (3 total attempts). */
const RETRY_ENTRY_CMP_001 = retryPolicyEntry({
  maxInternalRetries: 2,
  description:
    "the competitor's documented automatic fallback retries a failed pool attempt against other providers — up to 2 internal retries per request (3 total attempts), bounded by this declaration",
});

/** The cmp-rev-002 retry posture: tightened to 1 internal retry (2 total attempts). */
const RETRY_ENTRY_CMP_002 = retryPolicyEntry({
  maxInternalRetries: 1,
  description:
    "the CORRECTED retry posture: the automatic fallback is tightened to at most 1 internal retry per request (2 total attempts) — the correction is a NEW revision (cmp-rev-002 supersedes cmp-rev-001)",
});

/** The generation-usage-accounting entry. */
const USAGE_ACCOUNTING_ENTRY: CompetitorConfigEntry = {
  name: USAGE_ACCOUNTING_NAME,
  kind: "usage-accounting",
  bound: {
    reportedUsage:
      "the generation data's usage field is the request's measured usage (the aggregate the gateway saw)",
    reportedCost:
      "the generation data's cost field is a CROSS-CHECK OBSERVATION ONLY — never the comparison basis (the canonical basis prices measured tokens through the pinned manifest's public list prices so every arm compares identically)",
  },
  description:
    "the competitor's generation-data accounting: measured usage rides the comparison; the rail's own charge is recorded as an observation (digest-referenced) and never conflated into the cost-per-resolved basis",
  documentedRef:
    "https://openrouter.ai/docs/use-cases/usage-data-and-metering (pinned snapshot — the competitor's own documentation of the generation data's usage and cost fields)",
};

/** The request-defaults entry (the competitor's documented defaults). */
const REQUEST_DEFAULTS_ENTRY: CompetitorConfigEntry = {
  name: REQUEST_DEFAULTS_NAME,
  kind: "request-defaults",
  bound: {
    temperature: "unset (the model's own default — the competitor's documented default)",
    providerSort: "unset (the pool's own ordering)",
    stream: false,
  },
  description:
    "the competitor's documented request defaults: temperature and provider sort are left unset so the gateway applies its own defaults — the defaults are part of the declared configuration (an undeclared default would be an undocumented toggle)",
  documentedRef:
    "https://openrouter.ai/docs/api-reference/chat-completion (pinned snapshot — the competitor's own documented defaults of the chat completion endpoint)",
};

/** The completion-budget entry. */
const COMPLETION_BUDGET_ENTRY: CompetitorConfigEntry = {
  name: COMPLETION_BUDGET_NAME,
  kind: "completion-budget",
  bound: {
    maxTokens:
      "pinned explicitly per request by the arm's declared completion budget (never omitted)",
    posture:
      "the unaffordable-budget 402 lesson: completion budgets are pinned, so a request the budget cannot cover never dispatches",
  },
  description:
    "the completion budget (max_tokens) is pinned explicitly on every request through the competitor's interface — the fixed-cost arm's budget gate prices the pinned per-round bound BEFORE dispatch and never sends an uncovered request",
  documentedRef:
    "https://openrouter.ai/docs/api-reference/chat-completion (pinned snapshot — the competitor's own documentation of the max_tokens parameter)",
};

// ---------------------------------------------------------------------------
// The pinned model-selection table (every rail priced in the VAL-040 manifest)
// ---------------------------------------------------------------------------

/**
 * The pinned model-selection table (cmp-rev-001 and cmp-rev-002 share
 * it): the customer's per-class catalog selection through the
 * competitor's interface — extract rides the REAL live rail's pinned
 * model; the persona rails carry the competitor's other catalog
 * selections (each priced through the pinned manifest's own entries).
 */
const ROUTES: readonly CompetitorModelSelection[] = [
  { taskClass: "summarize", provider: "retry-relay", model: "retry-small-v1" },
  { taskClass: "extract", provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" },
  { taskClass: "translate", provider: "euro-relay", model: "euro-small-v1" },
  { taskClass: "transform-batch", provider: "batch-relay", model: "batch-medium-v1" },
];

/** The fallback selection (the arm grammar's declared rail). */
const FALLBACK_ROUTE: CompetitorModelSelection = {
  taskClass: "fallback",
  provider: "openrouter",
  model: "meta-llama/llama-3.3-70b-instruct",
};

// ---------------------------------------------------------------------------
// The configuration registry (append-only revisions)
// ---------------------------------------------------------------------------

/** The cmp-rev-001 entries: the initial declared configuration set. */
const ENTRIES_CMP_001: readonly CompetitorConfigEntry[] = [
  MODEL_SELECTION_ENTRY,
  PROVIDER_ROUTING_ENTRY,
  RETRY_ENTRY_CMP_001,
  USAGE_ACCOUNTING_ENTRY,
  REQUEST_DEFAULTS_ENTRY,
  COMPLETION_BUDGET_ENTRY,
];

/**
 * The cmp-rev-002 entries: a RETRY-POSTURE CORRECTION (the automatic
 * fallback tightened from 2 internal retries to 1 — a stricter
 * posture bound). A correction is a NEW revision — cmp-rev-001 stays
 * frozen and readable (append-only).
 */
const ENTRIES_CMP_002: readonly CompetitorConfigEntry[] = ENTRIES_CMP_001.map((entry) =>
  entry.name === RETRY_POLICY_NAME ? RETRY_ENTRY_CMP_002 : entry,
);

/** The pinned configuration registry (append-only, in revision order). */
export const COMPETITOR_CONFIG: readonly CompetitorConfigRevision[] = [
  {
    revision: "cmp-rev-001",
    entries: ENTRIES_CMP_001,
    routes: ROUTES,
    fallbackRoute: FALLBACK_ROUTE,
    digest: computeCompetitorConfigDigest({
      entries: ENTRIES_CMP_001,
      routes: ROUTES,
      fallbackRoute: FALLBACK_ROUTE,
    }),
  },
  {
    revision: "cmp-rev-002",
    entries: ENTRIES_CMP_002,
    routes: ROUTES,
    fallbackRoute: FALLBACK_ROUTE,
    digest: computeCompetitorConfigDigest({
      entries: ENTRIES_CMP_002,
      routes: ROUTES,
      fallbackRoute: FALLBACK_ROUTE,
    }),
    supersedes: "cmp-rev-001",
  },
];

/** Look up one pinned configuration revision by identity. */
export function competitorConfigRevisionOf(revision: string): CompetitorConfigRevision | null {
  return COMPETITOR_CONFIG.find((candidate) => candidate.revision === revision) ?? null;
}

/**
 * The configuration for a declared revision (throws when the revision
 * is unknown — a run against an unpinned configuration revision has
 * no declared configuration set at all).
 */
export function competitorConfigFor(revision: string): CompetitorConfigRevision {
  const config = competitorConfigRevisionOf(revision);
  if (config === null) {
    throw new Error(`the declared competitor configuration revision ${revision} is not pinned`);
  }
  return config;
}

// ---------------------------------------------------------------------------
// Configuration validation (structural) + integrity (digest agreement)
// ---------------------------------------------------------------------------

/** One configuration-validation violation. */
export interface CompetitorConfigViolation {
  readonly path: string;
  readonly reason: string;
}

/**
 * Validate one configuration revision's structure (PURE — the
 * "exhaustive by construction" property): non-empty distinct names,
 * EVERY entry carrying a documented reference (an undocumented toggle
 * cannot live in the declaration), a well-formed model-selection
 * table (distinct task classes, every route carrying a
 * provider/model), the provider-routing entry carrying an explicit
 * variance declaration ("declared" or "none" — the reproducibility
 * oracle's vocabulary), the retry-policy entry carrying a
 * non-negative integer internal-retry bound, the usage-accounting
 * entry carrying the charge-observation-only rule, and the fallback
 * route distinct from the table's classes.
 */
export function validateCompetitorConfig(
  config: CompetitorConfigRevision,
): readonly CompetitorConfigViolation[] {
  const violations: CompetitorConfigViolation[] = [];
  const fail = (path: string, reason: string): void => {
    violations.push({ path, reason });
  };
  if (config.entries.length === 0) {
    fail("entries", "the configuration must declare at least one toggle (the set is explicit)");
  }
  const names = new Set(config.entries.map((entry) => entry.name));
  if (names.size !== config.entries.length) {
    fail(
      "entries.names",
      "configuration toggle names must be distinct (the conformance oracle keys on them)",
    );
  }
  for (const entry of config.entries) {
    if (typeof entry.documentedRef !== "string" || entry.documentedRef.length === 0) {
      fail(
        `entries.${entry.name}.documentedRef`,
        "every declared toggle must carry its documented reference (an undocumented toggle cannot appear in an exhaustive declaration)",
      );
    }
    if (entry.kind === "provider-routing") {
      const variance = String(entry.bound.variance ?? "");
      if (!variance.startsWith("declared") && !variance.startsWith("none")) {
        fail(
          `entries.${entry.name}.variance`,
          'the provider-routing entry must carry an explicit variance declaration ("declared …" or "none" — the reproducibility oracle\'s vocabulary)',
        );
      }
    }
    if (entry.kind === "retry-policy") {
      const maxRetries = entry.bound.maxInternalRetries;
      if (!Number.isInteger(maxRetries) || (maxRetries as number) < 0) {
        fail(
          `entries.${entry.name}.maxInternalRetries`,
          "the retry-policy entry must declare a non-negative integer internal-retry bound",
        );
      }
    }
    if (entry.kind === "usage-accounting") {
      const cost = String(entry.bound.reportedCost ?? "");
      if (!cost.includes("CROSS-CHECK OBSERVATION ONLY")) {
        fail(
          `entries.${entry.name}.reportedCost`,
          "the usage-accounting entry must carry the charge-observation-only rule (the rail's own charge is never the comparison basis)",
        );
      }
    }
  }
  const classes = new Set<string>();
  for (const route of config.routes) {
    if (route.taskClass.length === 0 || route.provider.length === 0 || route.model.length === 0) {
      fail(
        `routes.${route.taskClass}`,
        "every model-selection route must carry a task class, provider and model",
      );
    }
    if (classes.has(route.taskClass)) {
      fail(`routes.${route.taskClass}`, "duplicate task class in the model-selection table");
    }
    classes.add(route.taskClass);
  }
  if (classes.has(config.fallbackRoute.taskClass)) {
    fail(
      "fallbackRoute",
      "the fallback selection's class must not collide with the table's classes",
    );
  }
  if (config.fallbackRoute.provider.length === 0 || config.fallbackRoute.model.length === 0) {
    fail("fallbackRoute", "the fallback selection must carry a provider and model");
  }
  return violations;
}

/** The configuration-integrity verdict (the digest-agreement catch). */
export interface CompetitorConfigIntegrityVerdict {
  readonly declaredRevisionKnown: boolean;
  readonly digestAgrees: boolean;
  readonly structurallyValid: boolean;
  readonly agreed: boolean;
  readonly evidence: readonly string[];
}

/**
 * Derive the configuration integrity of one declared revision (PURE —
 * the AC4 configuration-integrity oracle): the declared revision must
 * exist in the pinned registry, the recomputed content digest over
 * its entries + routes + fallback must AGREE with the registry's
 * recorded digest (an in-place bound edit breaks agreement
 * mechanically), and the structure must validate (the exhaustive-by-
 * construction property). The optional `registry` probes
 * ADVERSARIALLY (the discrimination battery's mutated copy); the
 * optional `declaredDigest` (a pinned experiment's recorded digest of
 * the revision) must ALSO agree.
 */
export function deriveCompetitorConfigIntegrity(declared: {
  readonly revision: string;
  readonly registry?: readonly CompetitorConfigRevision[];
  readonly declaredDigest?: string;
}): CompetitorConfigIntegrityVerdict {
  const registry = declared.registry ?? COMPETITOR_CONFIG;
  const revision = registry.find((candidate) => candidate.revision === declared.revision) ?? null;
  if (revision === null) {
    return {
      declaredRevisionKnown: false,
      digestAgrees: false,
      structurallyValid: false,
      agreed: false,
      evidence: [
        `revision:${declared.revision}`,
        "known:NO (the declared competitor configuration revision is not pinned in the registry)",
      ],
    };
  }
  const recomputed = computeCompetitorConfigDigest(revision);
  const digestAgrees =
    recomputed === revision.digest &&
    (declared.declaredDigest === undefined || declared.declaredDigest === revision.digest);
  const structural = validateCompetitorConfig(revision);
  return {
    declaredRevisionKnown: true,
    digestAgrees,
    structurallyValid: structural.length === 0,
    agreed: digestAgrees && structural.length === 0,
    evidence: [
      `revision:${revision.revision}`,
      `digest:${revision.digest}`,
      `recomputed:${recomputed}`,
      ...(declared.declaredDigest === undefined
        ? []
        : [`declaredDigest:${declared.declaredDigest}`]),
      digestAgrees
        ? "digest:AGREED (the declared configuration is exactly the pinned revision's)"
        : "digest:DISAGREED (a configuration bound was mutated in place — a correction must be a NEW revision)",
      `entries:${revision.entries.map((entry) => entry.name).join("+")}`,
      `routes:${revision.routes.map((route) => route.taskClass).join("+")}`,
      `structuralViolations:${structural.length}`,
      `supersedes:${revision.supersedes ?? "none"}`,
    ],
  };
}

/**
 * Derive the configuration registry's append-only discipline (PURE):
 * every revision identity is unique and no revision's recorded
 * digest disagrees with its own content.
 */
export function deriveCompetitorConfigAppendOnly(): {
  readonly appendOnly: boolean;
  readonly revisions: readonly string[];
  readonly evidence: readonly string[];
} {
  const revisions = COMPETITOR_CONFIG.map((revision) => revision.revision);
  const unique = new Set(revisions).size === revisions.length;
  const everyDigestAgrees = COMPETITOR_CONFIG.every(
    (revision) =>
      computeCompetitorConfigDigest(revision) === revision.digest &&
      validateCompetitorConfig(revision).length === 0,
  );
  return {
    appendOnly: unique && everyDigestAgrees,
    revisions,
    evidence: [
      `revisions:${revisions.join(" -> ")}`,
      `uniqueIdentities:${String(unique)}`,
      `everyDigestAgrees:${String(everyDigestAgrees)}`,
      "correctionsAreNewRevisions (cmp-rev-002 supersedes cmp-rev-001; cmp-rev-001 stays frozen and readable)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The routing + posture + variance derivations (the configuration semantics)
// ---------------------------------------------------------------------------

/**
 * Resolve the model selection for one task class (PURE): the
 * model-selection table's exact match, or the fallback selection for
 * a class the table does not name.
 */
export function routeForClass(
  config: CompetitorConfigRevision,
  taskClass: string,
): CompetitorModelSelection {
  return config.routes.find((route) => route.taskClass === taskClass) ?? config.fallbackRoute;
}

/**
 * The declared retry posture of one configuration revision (PURE):
 * the automatic-provider-fallback entry's internal-retry bound (null
 * when the revision declares no retry policy — a posture-less
 * competitor).
 */
export function retryBoundOf(config: CompetitorConfigRevision): number | null {
  const entry = config.entries.find((candidate) => candidate.name === RETRY_POLICY_NAME);
  if (entry === undefined) {
    return null;
  }
  const bound = entry.bound.maxInternalRetries;
  return Number.isInteger(bound) ? (bound as number) : null;
}

/**
 * The declared variance posture of one configuration revision (PURE):
 * "declared" when the provider-routing entry declares the
 * nondeterministic pool routing as honest variance, "none" when the
 * routing is pinned, null when the revision declares no
 * provider-routing entry at all (an undeclared routing posture —
 * differing observations under it FAIL the reproducibility oracle).
 */
export function varianceDeclarationOf(
  config: CompetitorConfigRevision,
): "declared" | "none" | null {
  const entry = config.entries.find((candidate) => candidate.name === PROVIDER_ROUTING_NAME);
  if (entry === undefined) {
    return null;
  }
  const variance = String(entry.bound.variance ?? "");
  if (variance.startsWith("declared")) {
    return "declared";
  }
  if (variance.startsWith("none")) {
    return "none";
  }
  return null;
}

/**
 * Derive the configuration conformance of the settings one run
 * APPLIED (PURE — the exhaustiveness oracle, the verification core):
 * every applied toggle name must be declared in the configuration
 * revision the row pinned. An applied setting the declaration does
 * not name is an UNDOCUMENTED CONFIGURATION TOGGLE — something the
 * competitor does that its declared configuration does not name —
 * and FAILs mechanically.
 */
export function deriveCompetitorConfigConformance(input: {
  readonly config: CompetitorConfigRevision;
  readonly appliedSettings: readonly string[];
}): {
  readonly conformant: boolean;
  readonly undeclared: readonly string[];
  readonly evidence: readonly string[];
} {
  const declared = new Set(input.config.entries.map((entry) => entry.name));
  const undeclared = [...new Set(input.appliedSettings)].filter((name) => !declared.has(name));
  return {
    conformant: undeclared.length === 0,
    undeclared,
    evidence: [
      `declared:${[...declared].join("+")}`,
      `applied:${[...new Set(input.appliedSettings)].join("+") || "none"}`,
      `undeclared:${undeclared.join("+") || "none"}`,
      undeclared.length === 0
        ? "conformant (every applied setting is declared in the pinned configuration revision — the declaration is exhaustive)"
        : "NON-CONFORMANT (an UNDOCUMENTED CONFIGURATION TOGGLE was applied — something the competitor does that its declared configuration does not name)",
    ],
  };
}

/**
 * Derive the BEHAVIOR VARIANCE verdict of one run's rail observations
 * (PURE — the reproducibility oracle): the competitor's routing
 * either REPRODUCES (equivalent requests of the same class all rode
 * the same pool endpoint) or the variance is OBSERVED — and observed
 * variance FAILs UNLESS the configuration declares it as honest
 * variance (a competitor behavior change between runs without the
 * declaration is a SILENT ROUTING CHANGE). The confidence half of
 * the oracle rides the comparison itself: the frozen VAL-040
 * protocol battery fails any confidence-less comparison (the Wilson
 * 95% interval is REQUIRED on every comparison, never waived for the
 * competitor).
 */
export function deriveBehaviorVariance(input: {
  readonly config: CompetitorConfigRevision;
  /** The per-round observations (equivalent requests keyed by class). */
  readonly observations: readonly {
    readonly taskClass: string;
    readonly routedEndpoint: string;
  }[];
}): {
  readonly conformant: boolean;
  readonly varianceObserved: boolean;
  readonly declared: boolean;
  readonly evidence: readonly string[];
} {
  const declaration = varianceDeclarationOf(input.config);
  const byClass = new Map<string, Set<string>>();
  for (const observation of input.observations) {
    const endpoints = byClass.get(observation.taskClass) ?? new Set<string>();
    endpoints.add(observation.routedEndpoint);
    byClass.set(observation.taskClass, endpoints);
  }
  const varyingClasses = [...byClass.entries()]
    .filter(([, endpoints]) => endpoints.size > 1)
    .map(([taskClass]) => taskClass);
  const varianceObserved = varyingClasses.length > 0;
  const declared = declaration === "declared";
  // Observed variance without the declaration FAILs (the silent
  // routing change); a pinned (variance "none") or missing
  // declaration under observed variance is the catch. Reproduced
  // observations pass regardless (the declaration is then just the
  // honest posture).
  const conformant = !varianceObserved || declared;
  return {
    conformant,
    varianceObserved,
    declared,
    evidence: [
      `declaration:${declaration ?? "absent (no provider-routing entry — undeclared routing posture)"}`,
      `observedClasses:${[...byClass.keys()].join("+") || "none"}`,
      `varyingClasses:${varyingClasses.join("+") || "none"}`,
      `distinctEndpoints:${[...byClass.values()]
        .map((endpoints) => endpoints.size)
        .reduce((sum, size) => sum + size, 0)}`,
      conformant
        ? varianceObserved
          ? "honest variance: the pool routed equivalent requests to different endpoints AND the configuration declares the nondeterminism (the Wilson 95% interval carries the comparison's confidence — never waived)"
          : "reproduced (equivalent requests of every class rode the same pool endpoint — no variance to declare)"
        : "SILENT ROUTING CHANGE (the pool routed equivalent requests to different endpoints WITHOUT the declaration — a competitor behavior change between runs must be declared as honest variance)",
    ],
  };
}

/**
 * Derive the retry-posture conformance of one run's requests (PURE —
 * the competitor's bounded automatic fallback): every request's
 * internal attempts must stay within the declared bound (attempts ≤
 * maxInternalRetries + 1 — the one primary attempt plus the bounded
 * retries). A request exceeding the declared posture FAILs
 * mechanically (an undeclared retry escalation).
 */
export function deriveRetryPostureConformance(input: {
  readonly config: CompetitorConfigRevision;
  readonly observations: readonly {
    readonly taskId: string;
    readonly internalAttempts: number;
  }[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const bound = retryBoundOf(input.config);
  if (bound === null) {
    return {
      conformant: false,
      evidence: [
        "posture:absent (the configuration declares no retry policy — any internal attempt FAILs the posture oracle)",
      ],
    };
  }
  const limit = bound + 1;
  const violations = input.observations.filter(
    (observation) => observation.internalAttempts > limit,
  );
  return {
    conformant: violations.length === 0,
    evidence: [
      `declaredMaxInternalRetries:${bound}`,
      `attemptLimit:${limit} (one primary + the bounded retries)`,
      `requests:${input.observations.length}`,
      `violations:${violations.length}`,
      ...violations.map(
        (violation) =>
          `exceeded:${violation.taskId} saw ${violation.internalAttempts} internal attempts`,
      ),
      violations.length === 0
        ? "conformant (every request's internal attempts stayed within the declared automatic-fallback bound — the amortization is inside the competitor's boundary and visible as the request's aggregate usage)"
        : "NON-CONFORMANT (a request exceeded the declared automatic-fallback bound — an undeclared retry escalation)",
    ],
  };
}
