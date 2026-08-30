/**
 * Policy domain model (policies module; WORK-007, POL-001/POL-002/POL-003).
 *
 * The typed, machine-readable policy vocabulary of the platform:
 *
 *   - POL-001 — five resolution scopes (`platform > application > user >
 *     task > execution`) with a DETERMINISTIC, TOTAL resolution: documents
 *     that match a request fold per scope (meet over every restriction
 *     field), scopes chain in fixed precedence order, and the result is
 *     independent of document/input ordering;
 *   - POL-002 — restrictions across ALL nine governing dimensions
 *     (`spec/architecture.md` §16 restricted to the WORK-007 vocabulary:
 *     cost, quality, latency, provider/model, tool, network, secrets,
 *     autonomy, isolation), every field carrying an explicit tightness
 *     order so policies are comparable, not just describable;
 *   - POL-003 — monotonic tightening: every restriction field has a formal
 *     "at least as tight" relation and `checkMonotonicTightening` rejects
 *     any lower-authority value that would WEAKEN a higher-authority value
 *     (a lower scope may only tighten or leave a field unconstrained).
 *
 * This file is PURE domain: no platform, no adapters, no I/O — the content
 * hash port and storage seam live in `ports/`, the authority in
 * `application/`.
 */

// ---------------------------------------------------------------------------
// Scopes (POL-001)
// ---------------------------------------------------------------------------

/**
 * The five policy scopes in DESCENDING authority (index 0 = highest).
 * `spec/requirements.md` POL-001: "Effective policy is resolved across
 * platform/application/user/task/execution scope"; POL-003: a lower level
 * cannot weaken a higher-level prohibition. The array order IS the
 * resolution order — deterministic by construction.
 */
export const POLICY_SCOPES = ["platform", "application", "user", "task", "execution"] as const;

export type PolicyScope = (typeof POLICY_SCOPES)[number];

/** Authority rank of a scope (0 = platform/highest). Lower rank = higher authority. */
export function scopeRank(scope: PolicyScope): number {
  const index = POLICY_SCOPES.indexOf(scope);
  if (index < 0) {
    throw new TypeError(`unknown policy scope: ${String(scope)}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Restriction vocabulary (POL-002) — all nine dimensions
// ---------------------------------------------------------------------------

/**
 * Compute-isolation ladder (`spec/architecture.md` §15), ordered by
 * increasing isolation. Tightness for `minIsolation` increases to the RIGHT
 * (requiring `container` is tighter than requiring `process`).
 */
export const ISOLATION_LEVELS = [
  "none",
  "process",
  "container",
  "microvm",
  "vm",
  "customer-runner",
] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

/**
 * Autonomy ladder, ordered by DECREASING tightness (index 0 = tightest).
 * `none` = no autonomous action; `gated` = autonomous steps require human/
 * user gates; `sandboxed` = autonomous inside an isolated environment;
 * `unconstrained` = fully autonomous (`spec/architecture.md` §2.9/§2.10).
 */
export const AUTONOMY_MODES = ["none", "gated", "sandboxed", "unconstrained"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** Network-egress ladder, ordered by DECREASING tightness (index 0 = tightest). */
export const EGRESS_MODES = ["none", "allowlist", "open"] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];

/** Secret-access ladder, ordered by DECREASING tightness (index 0 = tightest). */
export const SECRET_ACCESS_MODES = ["none", "allowlist", "all"] as const;
export type SecretAccessMode = (typeof SECRET_ACCESS_MODES)[number];

/** Cost ceiling: integer micro-USD string (WORK-004 money convention; floats never accepted). */
export interface CostRestriction {
  /** Maximum allowed spend for a single execution. Tighter = smaller. */
  readonly maxCostMicroUsd?: string;
}

/** Quality floor. Tighter = larger (0..1). */
export interface QualityRestriction {
  readonly minQuality?: number;
}

/** Latency ceiling (milliseconds). Tighter = smaller. */
export interface LatencyRestriction {
  readonly maxLatencyMs?: number;
}

/**
 * Provider/model eligibility (rails and model identifiers as configured on
 * connections — provider-neutral strings, never SDK types). Tightening =
 * shrinking an allowlist or growing a denylist.
 */
export interface ProviderModelRestriction {
  readonly allowedProviders?: readonly string[];
  readonly deniedProviders?: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly deniedModels?: readonly string[];
}

/** Tool permissions. Tightening = shrinking allowlist / growing denylist. */
export interface ToolRestriction {
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
}

/** Network access. `egress` is a ladder; host lists set-combine. */
export interface NetworkRestriction {
  readonly egress?: EgressMode;
  readonly allowedHosts?: readonly string[];
  readonly deniedHosts?: readonly string[];
}

/** Secret mediation (`IMPLEMENTATION.md` §9: secrets are references, never values). */
export interface SecretsRestriction {
  readonly access?: SecretAccessMode;
  readonly allowedSecretRefs?: readonly string[];
  readonly deniedSecretRefs?: readonly string[];
}

/** Autonomy ceiling: the most autonomous mode an execution may use. */
export interface AutonomyRestriction {
  readonly maxAutonomy?: AutonomyMode;
}

/** Compute-isolation floor: the weakest isolation an execution may use. */
export interface IsolationRestriction {
  readonly minIsolation?: IsolationLevel;
}

/**
 * The typed restriction set — exactly the nine WORK-007 dimensions, nothing
 * else. Absent dimension = unconstrained by that dimension (the authority
 * still fails closed when NO policy set is configured at all).
 */
export interface RestrictionSet {
  readonly cost?: CostRestriction;
  readonly quality?: QualityRestriction;
  readonly latency?: LatencyRestriction;
  readonly providerModel?: ProviderModelRestriction;
  readonly tool?: ToolRestriction;
  readonly network?: NetworkRestriction;
  readonly secrets?: SecretsRestriction;
  readonly autonomy?: AutonomyRestriction;
  readonly isolation?: IsolationRestriction;
}

/** The nine restriction dimensions, in canonical order. */
export const POLICY_DIMENSIONS = [
  "cost",
  "quality",
  "latency",
  "providerModel",
  "tool",
  "network",
  "secrets",
  "autonomy",
  "isolation",
] as const;

export type PolicyDimension = (typeof POLICY_DIMENSIONS)[number];

// ---------------------------------------------------------------------------
// Field orders — the comparable core of POL-002/POL-003
// ---------------------------------------------------------------------------

type FieldOrder =
  | { readonly kind: "ceiling-microusd" }
  | { readonly kind: "ceiling-number" }
  | { readonly kind: "floor-number" }
  | { readonly kind: "allowlist" }
  | { readonly kind: "denylist" }
  | { readonly kind: "ladder-descending"; readonly ladder: readonly string[] }
  | { readonly kind: "ladder-ascending"; readonly ladder: readonly string[] };

/** Declarative tightness semantics of every restriction field. */
export const DIMENSION_FIELD_ORDERS: Readonly<
  Record<PolicyDimension, Readonly<Record<string, FieldOrder>>>
> = {
  cost: { maxCostMicroUsd: { kind: "ceiling-microusd" } },
  quality: { minQuality: { kind: "floor-number" } },
  latency: { maxLatencyMs: { kind: "ceiling-number" } },
  providerModel: {
    allowedProviders: { kind: "allowlist" },
    deniedProviders: { kind: "denylist" },
    allowedModels: { kind: "allowlist" },
    deniedModels: { kind: "denylist" },
  },
  tool: {
    allowedTools: { kind: "allowlist" },
    deniedTools: { kind: "denylist" },
  },
  network: {
    egress: { kind: "ladder-descending", ladder: EGRESS_MODES },
    allowedHosts: { kind: "allowlist" },
    deniedHosts: { kind: "denylist" },
  },
  secrets: {
    access: { kind: "ladder-descending", ladder: SECRET_ACCESS_MODES },
    allowedSecretRefs: { kind: "allowlist" },
    deniedSecretRefs: { kind: "denylist" },
  },
  autonomy: { maxAutonomy: { kind: "ladder-descending", ladder: AUTONOMY_MODES } },
  isolation: { minIsolation: { kind: "ladder-ascending", ladder: ISOLATION_LEVELS } },
};

function ladderRank(ladder: readonly string[], value: string): number {
  const index = ladder.indexOf(value);
  if (index < 0) {
    throw new TypeError(`value ${value} is not on the ladder [${ladder.join(", ")}]`);
  }
  return index;
}

function compareMicroUsd(a: string, b: string): number {
  const bigA = BigInt(a);
  const bigB = BigInt(b);
  return bigA < bigB ? -1 : bigA > bigB ? 1 : 0;
}

/** True when `lower` is at least as tight as `higher` for one field. */
export function fieldAtLeastAsTight(order: FieldOrder, lower: unknown, higher: unknown): boolean {
  switch (order.kind) {
    case "ceiling-microusd":
      return compareMicroUsd(String(lower), String(higher)) <= 0;
    case "ceiling-number":
      return Number(lower) <= Number(higher);
    case "floor-number":
      return Number(lower) >= Number(higher);
    case "allowlist": {
      // Tighter = allows no more: `lower` must be a SUBSET of `higher`.
      const higherList = new Set((higher as readonly string[]).map(String));
      return (lower as readonly string[]).every((item) => higherList.has(String(item)));
    }
    case "denylist": {
      // Tighter = prohibits no less: `lower` must be a SUPERSET of `higher`.
      const lowerList = new Set((lower as readonly string[]).map(String));
      return (higher as readonly string[]).every((item) => lowerList.has(String(item)));
    }
    case "ladder-descending":
      // Tightest first: lower authority must not move RIGHT.
      return ladderRank(order.ladder, String(lower)) <= ladderRank(order.ladder, String(higher));
    case "ladder-ascending":
      // Tightest last: lower authority must not move LEFT.
      return ladderRank(order.ladder, String(lower)) >= ladderRank(order.ladder, String(higher));
  }
}

/** The tightest of two field values (the meet); `undefined` = unconstrained. */
export function tightenField(order: FieldOrder, a: unknown, b: unknown): unknown {
  if (a === undefined || a === null) {
    return b;
  }
  if (b === undefined || b === null) {
    return a;
  }
  switch (order.kind) {
    case "allowlist":
      // Meet over allowlists = intersection (allows only what both allow).
      return [...new Set((a as readonly string[]).map(String))]
        .filter((item) => (b as readonly string[]).map(String).includes(item))
        .sort();
    case "denylist":
      // Meet over denylists = union (prohibits what either prohibits).
      return [
        ...new Set([...(a as readonly string[]), ...(b as readonly string[])].map(String)),
      ].sort();
    default:
      return fieldAtLeastAsTight(order, a, b) ? a : b;
  }
}

// ---------------------------------------------------------------------------
// Restriction-set algebra
// ---------------------------------------------------------------------------

/** One observed weakening (POL-003 rejection detail). */
export interface Weakening {
  readonly dimension: PolicyDimension;
  readonly field: string;
  /** The higher-authority (surviving) value. */
  readonly higher: unknown;
  /** The lower-authority (attempted weakening) value. */
  readonly lower: unknown;
}

export interface TighteningCheck {
  readonly ok: boolean;
  readonly weakenings: readonly Weakening[];
}

/**
 * POL-003 core: does `lower` weaken any field tightened by `higher`?
 * Fields absent from `higher` are unconstrained above, so any `lower` value
 * for them is a tightening-or-neutral. Fields absent from `lower` cannot
 * weaken anything. Every OTHER overlapping field must satisfy
 * `fieldAtLeastAsTight(lower, higher)`.
 */
export function checkMonotonicTightening(
  lower: RestrictionSet,
  higher: RestrictionSet,
): TighteningCheck {
  const weakenings: Weakening[] = [];
  for (const dimension of POLICY_DIMENSIONS) {
    const lowerDimension = (lower as Record<string, unknown>)[dimension] as
      | Record<string, unknown>
      | undefined;
    const higherDimension = (higher as Record<string, unknown>)[dimension] as
      | Record<string, unknown>
      | undefined;
    if (lowerDimension === undefined || higherDimension === undefined) {
      continue;
    }
    const orders = DIMENSION_FIELD_ORDERS[dimension];
    for (const field of Object.keys(orders)) {
      const order = orders[field];
      if (order === undefined) {
        continue;
      }
      const lowerValue = lowerDimension[field];
      const higherValue = higherDimension[field];
      if (lowerValue === undefined || higherValue === undefined) {
        continue;
      }
      if (!fieldAtLeastAsTight(order, lowerValue, higherValue)) {
        weakenings.push({ dimension, field, higher: higherValue, lower: lowerValue });
      }
    }
  }
  return { ok: weakenings.length === 0, weakenings };
}

/**
 * Fold two restriction sets into their tightest common form (the meet over
 * every field). Associative, commutative — the resolution is deterministic
 * regardless of document order.
 */
export function tightenRestrictionSets(a: RestrictionSet, b: RestrictionSet): RestrictionSet {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const dimension of POLICY_DIMENSIONS) {
    const aDimension = (a as Record<string, unknown>)[dimension] as
      | Record<string, unknown>
      | undefined;
    const bDimension = (b as Record<string, unknown>)[dimension] as
      | Record<string, unknown>
      | undefined;
    if (aDimension === undefined && bDimension === undefined) {
      continue;
    }
    const orders = DIMENSION_FIELD_ORDERS[dimension];
    const folded: Record<string, unknown> = {};
    for (const field of Object.keys(orders)) {
      const order = orders[field];
      if (order === undefined) {
        continue;
      }
      const tightened = tightenField(order, aDimension?.[field], bDimension?.[field]);
      if (tightened !== undefined && tightened !== null) {
        folded[field] = tightened;
      }
    }
    if (Object.keys(folded).length > 0) {
      merged[dimension] = folded;
    }
  }
  return merged as RestrictionSet;
}

/** True when the set constrains nothing (no dimension present). */
export function isEmptyRestrictionSet(set: RestrictionSet): boolean {
  return POLICY_DIMENSIONS.every(
    (dimension) => (set as Record<string, unknown>)[dimension] === undefined,
  );
}

// ---------------------------------------------------------------------------
// Documents and sets
// ---------------------------------------------------------------------------

/**
 * The subject a document binds to. Non-platform scopes carry their scope
 * key; `tenantId`/`applicationId` additionally NARROW matching documents so
 * policy scoping is tenant/application-aware (tenant authority respected).
 */
export interface PolicySelector {
  readonly tenantId?: string;
  readonly applicationId?: string;
  readonly userId?: string;
  readonly taskKind?: string;
  readonly executionId?: string;
}

/** One policy document: a scope, its selector, and what it restricts. */
export interface PolicyDocument {
  readonly scope: PolicyScope;
  readonly selector: PolicySelector;
  /** Restrictions this document imposes (tightening-only against higher scopes). */
  readonly restrictions?: RestrictionSet;
  /** Outright prohibition of the selected subject (deny is absolute; no allow primitive exists). */
  readonly deny?: { readonly reason: string };
}

/** A versioned, content-addressed collection of policy documents. */
export interface PolicySet {
  /** Configuration identity, e.g. `"default"`. */
  readonly id: string;
  /** Monotonically increasing configuration version. */
  readonly version: number;
  readonly documents: readonly PolicyDocument[];
}

/** Identity of a policy set: version + content hash over the canonical form. */
export interface PolicySetIdentity {
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
}

// ---------------------------------------------------------------------------
// Validation (fail closed on malformed policy data)
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

const MICRO_USD = /^\d{1,19}$/u;
const NONEMPTY_ID = /^[\w:./-]{1,200}$/u;

function validateList(path: string, value: readonly unknown[], issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  for (const item of value) {
    const text = String(item);
    if (!NONEMPTY_ID.test(text)) {
      issues.push({ path, message: `invalid identifier "${text}"` });
    }
    if (seen.has(text)) {
      issues.push({ path, message: `duplicate identifier "${text}"` });
    }
    seen.add(text);
  }
}

function validateRestrictionSet(
  path: string,
  set: RestrictionSet,
  issues: ValidationIssue[],
): void {
  for (const dimension of POLICY_DIMENSIONS) {
    const value = (set as Record<string, unknown>)[dimension];
    if (value === undefined) {
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ path: `${path}.${dimension}`, message: "must be an object" });
      continue;
    }
    const record = value as Record<string, unknown>;
    const orders = DIMENSION_FIELD_ORDERS[dimension];
    for (const key of Object.keys(record)) {
      const order = orders[key];
      if (order === undefined) {
        issues.push({ path: `${path}.${dimension}`, message: `unknown field "${key}"` });
        continue;
      }
      const field = record[key];
      if (field === undefined || field === null) {
        continue;
      }
      switch (order.kind) {
        case "ceiling-microusd":
          if (typeof field !== "string" || !MICRO_USD.test(field)) {
            issues.push({
              path: `${path}.${dimension}.${key}`,
              message: "must be an integer micro-USD string (no floats)",
            });
          }
          break;
        case "ceiling-number":
        case "floor-number":
          if (!Number.isFinite(Number(field)) || Number(field) < 0) {
            issues.push({
              path: `${path}.${dimension}.${key}`,
              message: "must be a non-negative number",
            });
          }
          break;
        case "allowlist":
        case "denylist":
          if (!Array.isArray(field)) {
            issues.push({ path: `${path}.${dimension}.${key}`, message: "must be an array" });
          } else {
            validateList(`${path}.${dimension}.${key}`, field, issues);
          }
          break;
        case "ladder-descending":
        case "ladder-ascending":
          if (!order.ladder.includes(String(field))) {
            issues.push({
              path: `${path}.${dimension}.${key}`,
              message: `must be one of [${order.ladder.join(", ")}]`,
            });
          }
          break;
      }
    }
    // allowlist/denylist pairs must be disjoint (an identifier cannot be
    // both permitted and prohibited — ambiguous policy is invalid policy).
    for (const [allowKey, denyKey] of [
      ["allowedProviders", "deniedProviders"],
      ["allowedModels", "deniedModels"],
      ["allowedTools", "deniedTools"],
      ["allowedHosts", "deniedHosts"],
      ["allowedSecretRefs", "deniedSecretRefs"],
    ] as const) {
      const allow = record[allowKey];
      const deny = record[denyKey];
      if (Array.isArray(allow) && Array.isArray(deny)) {
        const denied = new Set(deny.map(String));
        for (const item of allow) {
          if (denied.has(String(item))) {
            issues.push({
              path: `${path}.${dimension}`,
              message: `"${String(item)}" is both allowed and denied`,
            });
          }
        }
      }
    }
    if (dimension === "quality" && record.minQuality !== undefined) {
      const quality = Number(record.minQuality);
      if (quality < 0 || quality > 1) {
        issues.push({ path: `${path}.quality.minQuality`, message: "must be within 0..1" });
      }
    }
  }
}

function validateSelector(
  document: PolicyDocument,
  index: number,
  issues: ValidationIssue[],
): void {
  const path = `documents[${index}].selector`;
  const selector = document.selector ?? {};
  for (const key of Object.keys(selector)) {
    if (!["tenantId", "applicationId", "userId", "taskKind", "executionId"].includes(key)) {
      issues.push({ path, message: `unknown selector field "${key}"` });
    }
  }
  const requireId = (field: keyof PolicySelector, required: boolean) => {
    const value = selector[field];
    if (required && (value === undefined || String(value) === "")) {
      issues.push({ path: `${path}.${field}`, message: `required for scope ${document.scope}` });
    }
    if (value !== undefined && !NONEMPTY_ID.test(String(value))) {
      issues.push({ path: `${path}.${field}`, message: "invalid identifier" });
    }
  };
  switch (document.scope) {
    case "platform":
      if (Object.keys(selector).length > 0) {
        issues.push({ path, message: "platform documents must not carry a selector" });
      }
      break;
    case "application":
      requireId("tenantId", true);
      requireId("applicationId", true);
      break;
    case "user":
      requireId("tenantId", true);
      requireId("userId", true);
      requireId("applicationId", false);
      break;
    case "task":
      requireId("taskKind", true);
      requireId("tenantId", false);
      requireId("applicationId", false);
      break;
    case "execution":
      requireId("executionId", true);
      requireId("tenantId", false);
      requireId("applicationId", false);
      break;
  }
}

/** Validate a full policy set; returns every issue (empty = valid). */
export function validatePolicySet(set: PolicySet): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!NONEMPTY_ID.test(set.id)) {
    issues.push({ path: "id", message: "invalid policy set id" });
  }
  if (!Number.isInteger(set.version) || set.version < 1) {
    issues.push({ path: "version", message: "must be a positive integer" });
  }
  if (!Array.isArray(set.documents)) {
    issues.push({ path: "documents", message: "must be an array" });
    return issues;
  }
  const selectorKeys = new Set<string>();
  set.documents.forEach((document, index) => {
    const path = `documents[${index}]`;
    if (document === null || typeof document !== "object") {
      issues.push({ path, message: "must be an object" });
      return;
    }
    if (!POLICY_SCOPES.includes(document.scope)) {
      issues.push({ path: `${path}.scope`, message: `unknown scope ${String(document.scope)}` });
      return;
    }
    validateSelector(document, index, issues);
    if (
      document.restrictions === undefined &&
      (document.deny === undefined || document.deny === null)
    ) {
      issues.push({ path, message: "must carry restrictions and/or a deny" });
    }
    if (document.deny !== undefined && (document.deny.reason ?? "") === "") {
      issues.push({ path: `${path}.deny.reason`, message: "must be a non-empty string" });
    }
    if (document.restrictions !== undefined) {
      validateRestrictionSet(`${path}.restrictions`, document.restrictions, issues);
    }
    // Determinism/totality: at most ONE document per (scope, selector) —
    // two documents for the same subject make resolution ambiguous.
    const selector = document.selector ?? {};
    const key = `${document.scope}|${selector.tenantId ?? ""}|${selector.applicationId ?? ""}|${
      selector.userId ?? ""
    }|${selector.taskKind ?? ""}|${selector.executionId ?? ""}`;
    if (selectorKeys.has(key)) {
      issues.push({ path, message: `duplicate document for subject ${key}` });
    }
    selectorKeys.add(key);
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Canonical form + content identity
// ---------------------------------------------------------------------------

/**
 * Canonical JSON for policy data: object keys sorted at every depth; arrays
 * of plain strings sorted + deduplicated (restriction lists are SETS —
 * logically identical sets canonicalize identically, so the content hash is
 * stable under input ordering). Closed universe: only JSON values.
 */
export function canonicalPolicyJson(value: unknown): string {
  return JSON.stringify(canonicalizePolicy(value));
}

function canonicalizePolicy(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return [...new Set(value.map(String))].sort();
    }
    return value.map(canonicalizePolicy).sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => [key, canonicalizePolicy(record[key])]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Resolution (POL-001) — deterministic and total
// ---------------------------------------------------------------------------

/** The request context a policy chain is resolved against. */
export interface PolicyRequestContext {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly userId?: string;
  readonly taskKind?: string;
  readonly executionId?: string;
}

/** Does one document's selector match the request context for its scope? */
export function documentApplies(document: PolicyDocument, ctx: PolicyRequestContext): boolean {
  const selector = document.selector ?? {};
  const tenantOk = selector.tenantId === undefined || selector.tenantId === ctx.tenantId;
  const applicationOk =
    selector.applicationId === undefined || selector.applicationId === ctx.applicationId;
  switch (document.scope) {
    case "platform":
      return true;
    case "application":
      return tenantOk && applicationOk && selector.applicationId === ctx.applicationId;
    case "user":
      return (
        tenantOk && applicationOk && selector.userId !== undefined && selector.userId === ctx.userId
      );
    case "task":
      return (
        tenantOk &&
        applicationOk &&
        selector.taskKind !== undefined &&
        selector.taskKind === ctx.taskKind
      );
    case "execution":
      return (
        tenantOk &&
        applicationOk &&
        selector.executionId !== undefined &&
        selector.executionId === ctx.executionId
      );
  }
}

/** Why a resolution denied (machine-readable; canonical taxonomy mapping upstream). */
export type PolicyDenial =
  | { readonly kind: "prohibited"; readonly scope: PolicyScope; readonly reason: string }
  | {
      readonly kind: "weakening";
      readonly message: string;
      readonly weakenings: readonly Weakening[];
    };

/** One scope's contribution to the chain, in precedence order. */
export interface AppliedScopePolicy {
  readonly scope: PolicyScope;
  readonly documents: readonly PolicyDocument[];
  readonly folded: RestrictionSet;
}

export type PolicyResolution =
  | {
      readonly outcome: "allow";
      readonly effective: RestrictionSet;
      readonly applied: readonly AppliedScopePolicy[];
    }
  | { readonly outcome: "deny"; readonly denial: PolicyDenial };

/**
 * Resolve the effective policy for a request (POL-001):
 *
 *  1. applicable documents fold PER SCOPE (meet over all fields);
 *  2. any applicable `deny` document denies absolutely;
 *  3. consecutive present scopes must satisfy monotonic tightening
 *     (POL-003) — a weakening attempt fails closed as a `weakening` denial;
 *  4. the effective set is the fold over every present scope.
 *
 * Total + deterministic: independent of document order, with at most one
 * document per subject enforced by `validatePolicySet`.
 */
export function resolvePolicy(
  set: PolicySet,
  ctx: PolicyRequestContext,
  options: {
    /**
     * Monotonic-tightening check override. Exists so discrimination proofs
     * can remove the protection and observe the violation (WORK-005
     * validation-hook precedent); production always uses the domain check.
     */
    readonly monotonic?: (lower: RestrictionSet, higher: RestrictionSet) => TighteningCheck;
  } = {},
): PolicyResolution {
  const monotonic = options.monotonic ?? checkMonotonicTightening;

  const byScope = new Map<PolicyScope, PolicyDocument[]>();
  for (const scope of POLICY_SCOPES) {
    byScope.set(scope, []);
  }
  for (const document of set.documents) {
    if (documentApplies(document, ctx)) {
      byScope.get(document.scope)?.push(document);
    }
  }

  // Absolute prohibitions first: deny is the strongest statement any scope
  // can make, and no lower scope carries an allow primitive to undo it.
  for (const scope of POLICY_SCOPES) {
    for (const document of byScope.get(scope) ?? []) {
      if (document.deny !== undefined) {
        return {
          outcome: "deny",
          denial: { kind: "prohibited", scope, reason: document.deny.reason },
        };
      }
    }
  }

  const applied: AppliedScopePolicy[] = [];
  for (const scope of POLICY_SCOPES) {
    const documents = byScope.get(scope) ?? [];
    if (documents.length === 0) {
      continue;
    }
    const folded = documents.reduce<RestrictionSet>(
      (acc, document) => tightenRestrictionSets(acc, document.restrictions ?? {}),
      {},
    );
    if (applied.length > 0) {
      const higher = applied[applied.length - 1]?.folded;
      if (higher !== undefined) {
        const check = monotonic(folded, higher);
        if (!check.ok) {
          return {
            outcome: "deny",
            denial: {
              kind: "weakening",
              message: `a ${scope}-scope policy attempts to weaken a higher-authority prohibition`,
              weakenings: check.weakenings,
            },
          };
        }
      }
    }
    applied.push({ scope, documents, folded });
  }

  const effective = applied.reduce<RestrictionSet>(
    (acc, entry) => tightenRestrictionSets(acc, entry.folded),
    {},
  );
  return { outcome: "allow", effective, applied };
}
