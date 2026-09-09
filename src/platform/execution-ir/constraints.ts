/**
 * Hard and soft optimization constraints (platform execution-ir plane;
 * WORK-049 / E1.1 foundation — ADR-0019, ADR-0020).
 *
 * Constraints are REPRESENTED exactly as the governing authorities
 * define them — never re-invented here. The payload vocabularies are
 * neutral mirrors of the existing authority contracts (the policy
 * module's restriction vocabulary, the planning module's capability
 * resolution capture, the budgets module's money/scope conventions);
 * boundary tests pin the mirrors against the authority vocabularies so
 * they cannot drift. Each constraint carries its AUTHORITY PROVENANCE
 * (which authority produced it, with identity anchors).
 *
 * Enforcement semantics (architecture invariant 3):
 *
 *  - HARD constraints are enforced by validation: a decision whose IR,
 *    candidates or cost claims violate a hard constraint is rejected
 *    (typed, bounded). Restrictions sourced from the policy, budget,
 *    capability and verification authorities are HARD BY CONSTRUCTION —
 *    declaring one soft is unrepresentable (weakened authority
 *    constraint, discrimination-tested).
 *  - SOFT constraints are RECORDED, never silently enforced: a soft
 *    constraint that would be violated produces no violation at all
 *    (discrimination-tested). Only planning-sourced (task-derived)
 *    constraints may be soft.
 *
 * The derivable enforcement checks mirror the planning module's own
 * sanctioned policy semantics (route eligibility, cost/latency/quality
 * bounds) plus the frozen verification binding (COMPLETED requires
 * verification evidence) and the conservative side-effect reading
 * (policy network egress `none` forbids external-effect steps —
 * fail-closed). Authority dimensions whose enforcement point is
 * dispatch/policy admission (secrets, autonomy ceiling, isolation
 * floor) are validated, carried and recorded — the IR foundation does
 * not invent step-level semantics for them.
 */

import type { CandidateRepresentation } from "./cost-model";
import { validateCostClaim } from "./cost-model";
import type { ExecutionIr } from "./ir";
import { isGenerativeStepClass } from "./ir";

// ---------------------------------------------------------------------------
// Frozen vocabularies
// ---------------------------------------------------------------------------

/**
 * The seven constraint classes of the Work Order: policy, capability,
 * budget, quality, latency, verification, side-effect.
 */
export const CONSTRAINT_KINDS = [
  "policy",
  "capability",
  "budget",
  "quality",
  "latency",
  "verification",
  "side-effect",
] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export const CONSTRAINT_ENFORCEMENTS = ["hard", "soft"] as const;
export type ConstraintEnforcement = (typeof CONSTRAINT_ENFORCEMENTS)[number];

/** The authorities that may produce optimization constraints. */
export const CONSTRAINT_AUTHORITIES = [
  "policy",
  "capability",
  "budget",
  "verification",
  "planning",
] as const;
export type ConstraintAuthority = (typeof CONSTRAINT_AUTHORITIES)[number];

// Neutral mirrors of the policy authority's restriction vocabulary
// (pinned by boundary tests — the policy module owns the semantics).
export const EGRESS_MODES = ["none", "allowlist", "open"] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];

export const SECRET_ACCESS_MODES = ["none", "allowlist", "all"] as const;
export type SecretAccessMode = (typeof SECRET_ACCESS_MODES)[number];

export const AUTONOMY_MODES = ["none", "gated", "sandboxed", "unconstrained"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const ISOLATION_LEVELS = [
  "none",
  "process",
  "container",
  "microvm",
  "vm",
  "customer-runner",
] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export const BUDGET_SCOPE_KINDS = ["per-execution", "monthly", "user-monthly"] as const;
export type BudgetScopeKind = (typeof BUDGET_SCOPE_KINDS)[number];

// ---------------------------------------------------------------------------
// Authority provenance (typed sources)
// ---------------------------------------------------------------------------

/** Policy-set identity provenance (the policy authority's anchors). */
export interface PolicyConstraintSource {
  readonly authority: "policy";
  readonly policySetId?: string;
  readonly policySetVersion?: number;
  readonly policyContentHash?: string;
  /** sha256 over the canonical effective restriction set. */
  readonly restrictionSetDigest?: string;
}

export interface CapabilityConstraintSource {
  readonly authority: "capability";
  readonly catalogRevision: string;
}

export interface BudgetConstraintSource {
  readonly authority: "budget";
  readonly budgetId: string;
  readonly scopeKind: BudgetScopeKind;
  /** End-user identity for `user-monthly` scopes; '' otherwise. */
  readonly userId?: string;
}

export interface VerificationConstraintSource {
  readonly authority: "verification";
}

export interface PlanningConstraintSource {
  readonly authority: "planning";
}

export type ConstraintSource =
  | PolicyConstraintSource
  | CapabilityConstraintSource
  | BudgetConstraintSource
  | VerificationConstraintSource
  | PlanningConstraintSource;

// ---------------------------------------------------------------------------
// Typed payloads per kind (exact authority mirrors)
// ---------------------------------------------------------------------------

/**
 * Policy eligibility restrictions (the policy authority's provider/model
 * and tool dimensions, mirrored field-for-field).
 */
export interface PolicyConstraintPayload {
  readonly providerModel?: {
    readonly allowedProviders?: readonly string[];
    readonly deniedProviders?: readonly string[];
    readonly allowedModels?: readonly string[];
    readonly deniedModels?: readonly string[];
  };
  readonly tool?: {
    readonly allowedTools?: readonly string[];
    readonly deniedTools?: readonly string[];
  };
}

/**
 * Capability satisfaction (the planning module's capability-resolution
 * capture: exactly the ids the capability authority satisfied / left
 * unmet at planning time).
 */
export interface CapabilityConstraintPayload {
  readonly satisfiedIds: readonly string[];
  readonly unmetIds: readonly string[];
}

/** Budget cost ceiling (integer micro-USD — the budgets convention). */
export interface BudgetConstraintPayload {
  readonly maxCostMicroUsd: string;
}

/** Quality/reliability floors. */
export interface QualityConstraintPayload {
  readonly minQuality?: number;
  readonly minReliability?: number;
}

/** Latency ceiling (milliseconds). */
export interface LatencyConstraintPayload {
  readonly maxLatencyMs?: number;
}

/**
 * Verification requirement. `requiresVerificationAnchor` mirrors the
 * frozen completion binding (COMPLETED requires durable verification
 * evidence): the IR must carry at least one verification anchor (a
 * `verify` step or a step-level verification strategy).
 */
export interface VerificationConstraintPayload {
  readonly requiresVerificationAnchor: boolean;
}

/**
 * Side-effect restrictions (the policy authority's network, secrets,
 * autonomy and isolation dimensions, mirrored field-for-field). The
 * derivable hard rule: network egress `none` forbids `external-effect`
 * steps (conservative fail-closed). Secrets/autonomy/isolation are
 * carried to the enforcement points that own them.
 */
export interface SideEffectConstraintPayload {
  readonly network?: {
    readonly egress?: EgressMode;
    readonly allowedHosts?: readonly string[];
    readonly deniedHosts?: readonly string[];
  };
  readonly secrets?: {
    readonly access?: SecretAccessMode;
    readonly allowedSecretRefs?: readonly string[];
    readonly deniedSecretRefs?: readonly string[];
  };
  readonly autonomy?: { readonly maxAutonomy?: AutonomyMode };
  readonly isolation?: { readonly minIsolation?: IsolationLevel };
}

export interface OptimizationConstraint {
  /** Stable constraint identifier, unique within the set. */
  readonly constraintId: string;
  readonly kind: ConstraintKind;
  readonly enforcement: ConstraintEnforcement;
  readonly source: ConstraintSource;
  readonly payload:
    | PolicyConstraintPayload
    | CapabilityConstraintPayload
    | BudgetConstraintPayload
    | QualityConstraintPayload
    | LatencyConstraintPayload
    | VerificationConstraintPayload
    | SideEffectConstraintPayload;
}

// ---------------------------------------------------------------------------
// Validation (total, deterministic)
// ---------------------------------------------------------------------------

export const CONSTRAINT_INVARIANT_CODES = [
  "constraint-shape",
  "constraint-vocabulary",
  "constraint-authority-mismatch",
  "constraint-set",
] as const;
export type ConstraintInvariantCode = (typeof CONSTRAINT_INVARIANT_CODES)[number];

/** The typed, bounded constraint validation error. */
export class ConstraintValidationError extends Error {
  readonly invariant: ConstraintInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: ConstraintInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "ConstraintValidationError";
    this.invariant = invariant;
    this.details = Object.freeze({ ...details });
  }
}

const DETAIL_LIMIT = 200;

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

function reject(
  invariant: ConstraintInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  const boundedDetails: Record<string, string | number | boolean | null> = {};
  if (details !== undefined) {
    for (const [key, value] of Object.entries(details)) {
      boundedDetails[key] = typeof value === "string" ? bounded(value) : value;
    }
  }
  throw new ConstraintValidationError(invariant, message, boundedDetails);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONSTRAINT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,17})$/;

function validateStringList(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) {
    reject("constraint-shape", `${what} must be an array of strings`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      reject("constraint-shape", `${what} entries must be non-empty strings`);
    }
  }
  return value as readonly string[];
}

function validateSource(value: unknown): ConstraintSource {
  if (!isRecord(value)) {
    reject("constraint-shape", "constraint source must be an object");
  }
  if (
    typeof value.authority !== "string" ||
    !(CONSTRAINT_AUTHORITIES as readonly string[]).includes(value.authority)
  ) {
    reject(
      "constraint-vocabulary",
      "constraint source authority is outside the closed vocabulary",
      {
        got: bounded(value.authority),
      },
    );
  }
  switch (value.authority as ConstraintAuthority) {
    case "policy": {
      if (value.policySetId !== undefined && typeof value.policySetId !== "string") {
        reject("constraint-shape", "policy source policySetId must be a string when present");
      }
      if (value.policySetVersion !== undefined && !Number.isInteger(value.policySetVersion)) {
        reject(
          "constraint-shape",
          "policy source policySetVersion must be an integer when present",
        );
      }
      if (
        value.policyContentHash !== undefined &&
        (typeof value.policyContentHash !== "string" ||
          !/^[0-9a-f]{64}$/.test(value.policyContentHash))
      ) {
        reject("constraint-shape", "policy source policyContentHash must be a sha256 hex digest");
      }
      if (
        value.restrictionSetDigest !== undefined &&
        (typeof value.restrictionSetDigest !== "string" ||
          !/^[0-9a-f]{64}$/.test(value.restrictionSetDigest))
      ) {
        reject(
          "constraint-shape",
          "policy source restrictionSetDigest must be a sha256 hex digest",
        );
      }
      return { authority: "policy" };
    }
    case "capability": {
      if (typeof value.catalogRevision !== "string" || value.catalogRevision.length === 0) {
        reject("constraint-shape", "capability source catalogRevision must be a non-empty string");
      }
      return { authority: "capability", catalogRevision: value.catalogRevision };
    }
    case "budget": {
      if (typeof value.budgetId !== "string" || value.budgetId.length === 0) {
        reject("constraint-shape", "budget source budgetId must be a non-empty string");
      }
      if (
        typeof value.scopeKind !== "string" ||
        !(BUDGET_SCOPE_KINDS as readonly string[]).includes(value.scopeKind)
      ) {
        reject(
          "constraint-vocabulary",
          "budget source scopeKind is outside the frozen vocabulary",
          {
            got: bounded(value.scopeKind),
          },
        );
      }
      if (value.userId !== undefined && typeof value.userId !== "string") {
        reject("constraint-shape", "budget source userId must be a string when present");
      }
      return {
        authority: "budget",
        budgetId: value.budgetId,
        scopeKind: value.scopeKind as BudgetScopeKind,
        ...(value.userId === undefined ? {} : { userId: value.userId }),
      };
    }
    case "verification":
      return { authority: "verification" };
    case "planning":
      return { authority: "planning" };
  }
}

function validatePayload(kind: ConstraintKind, value: unknown): OptimizationConstraint["payload"] {
  if (!isRecord(value)) {
    reject("constraint-shape", `constraint payload for kind "${kind}" must be an object`);
  }
  switch (kind) {
    case "policy": {
      let providerModel: PolicyConstraintPayload["providerModel"];
      let tool: PolicyConstraintPayload["tool"];
      if (value.providerModel !== undefined) {
        if (!isRecord(value.providerModel)) {
          reject("constraint-shape", "policy payload providerModel must be an object when present");
        }
        const pm = value.providerModel as Record<string, unknown>;
        providerModel = {
          ...(pm.allowedProviders === undefined
            ? {}
            : { allowedProviders: validateStringList(pm.allowedProviders, "allowedProviders") }),
          ...(pm.deniedProviders === undefined
            ? {}
            : { deniedProviders: validateStringList(pm.deniedProviders, "deniedProviders") }),
          ...(pm.allowedModels === undefined
            ? {}
            : { allowedModels: validateStringList(pm.allowedModels, "allowedModels") }),
          ...(pm.deniedModels === undefined
            ? {}
            : { deniedModels: validateStringList(pm.deniedModels, "deniedModels") }),
        };
      }
      if (value.tool !== undefined) {
        if (!isRecord(value.tool)) {
          reject("constraint-shape", "policy payload tool must be an object when present");
        }
        const toolRecord = value.tool as Record<string, unknown>;
        tool = {
          ...(toolRecord.allowedTools === undefined
            ? {}
            : { allowedTools: validateStringList(toolRecord.allowedTools, "allowedTools") }),
          ...(toolRecord.deniedTools === undefined
            ? {}
            : { deniedTools: validateStringList(toolRecord.deniedTools, "deniedTools") }),
        };
      }
      if (providerModel === undefined && tool === undefined) {
        reject("constraint-shape", "policy payload must carry at least one eligibility dimension");
      }
      return {
        ...(providerModel === undefined ? {} : { providerModel }),
        ...(tool === undefined ? {} : { tool }),
      };
    }
    case "capability": {
      if (!Array.isArray(value.satisfiedIds) || !Array.isArray(value.unmetIds)) {
        reject(
          "constraint-shape",
          "capability payload must carry satisfiedIds and unmetIds arrays",
        );
      }
      return {
        satisfiedIds: validateStringList(value.satisfiedIds, "satisfiedIds"),
        unmetIds: validateStringList(value.unmetIds, "unmetIds"),
      };
    }
    case "budget": {
      if (
        typeof value.maxCostMicroUsd !== "string" ||
        !MICRO_USD_PATTERN.test(value.maxCostMicroUsd)
      ) {
        reject("constraint-shape", "budget payload maxCostMicroUsd must be integer micro-USD", {
          got: bounded(value.maxCostMicroUsd),
        });
      }
      return { maxCostMicroUsd: value.maxCostMicroUsd };
    }
    case "quality": {
      if (value.minQuality !== undefined) {
        if (
          typeof value.minQuality !== "number" ||
          !Number.isFinite(value.minQuality) ||
          value.minQuality < 0 ||
          value.minQuality > 1
        ) {
          reject("constraint-shape", "quality payload minQuality must be a probability in [0, 1]");
        }
      }
      if (value.minReliability !== undefined) {
        if (
          typeof value.minReliability !== "number" ||
          !Number.isFinite(value.minReliability) ||
          value.minReliability <= 0 ||
          value.minReliability > 1
        ) {
          reject("constraint-shape", "quality payload minReliability must be in (0, 1]");
        }
      }
      if (value.minQuality === undefined && value.minReliability === undefined) {
        reject("constraint-shape", "quality payload must carry at least one floor");
      }
      return {
        ...(value.minQuality === undefined ? {} : { minQuality: value.minQuality }),
        ...(value.minReliability === undefined ? {} : { minReliability: value.minReliability }),
      };
    }
    case "latency": {
      if (value.maxLatencyMs !== undefined) {
        if (
          typeof value.maxLatencyMs !== "number" ||
          !Number.isFinite(value.maxLatencyMs) ||
          value.maxLatencyMs < 0
        ) {
          reject(
            "constraint-shape",
            "latency payload maxLatencyMs must be a finite non-negative number",
          );
        }
      } else {
        reject("constraint-shape", "latency payload must carry maxLatencyMs");
      }
      return { maxLatencyMs: value.maxLatencyMs as number };
    }
    case "verification": {
      if (typeof value.requiresVerificationAnchor !== "boolean") {
        reject(
          "constraint-shape",
          "verification payload requiresVerificationAnchor must be a boolean",
        );
      }
      return { requiresVerificationAnchor: value.requiresVerificationAnchor as boolean };
    }
    case "side-effect": {
      let network: SideEffectConstraintPayload["network"];
      let secrets: SideEffectConstraintPayload["secrets"];
      let autonomy: SideEffectConstraintPayload["autonomy"];
      let isolation: SideEffectConstraintPayload["isolation"];
      if (value.network !== undefined) {
        if (!isRecord(value.network)) {
          reject("constraint-shape", "side-effect payload network must be an object when present");
        }
        const net = value.network as Record<string, unknown>;
        if (
          net.egress !== undefined &&
          !(EGRESS_MODES as readonly string[]).includes(net.egress as string)
        ) {
          reject(
            "constraint-vocabulary",
            "network egress is outside the frozen policy vocabulary",
            {
              got: bounded(net.egress),
            },
          );
        }
        network = {
          ...(net.egress === undefined ? {} : { egress: net.egress as EgressMode }),
          ...(net.allowedHosts === undefined
            ? {}
            : { allowedHosts: validateStringList(net.allowedHosts, "allowedHosts") }),
          ...(net.deniedHosts === undefined
            ? {}
            : { deniedHosts: validateStringList(net.deniedHosts, "deniedHosts") }),
        };
      }
      if (value.secrets !== undefined) {
        if (!isRecord(value.secrets)) {
          reject("constraint-shape", "side-effect payload secrets must be an object when present");
        }
        const sec = value.secrets as Record<string, unknown>;
        if (
          sec.access !== undefined &&
          !(SECRET_ACCESS_MODES as readonly string[]).includes(sec.access as string)
        ) {
          reject(
            "constraint-vocabulary",
            "secrets access is outside the frozen policy vocabulary",
            {
              got: bounded(sec.access),
            },
          );
        }
        secrets = {
          ...(sec.access === undefined ? {} : { access: sec.access as SecretAccessMode }),
          ...(sec.allowedSecretRefs === undefined
            ? {}
            : {
                allowedSecretRefs: validateStringList(sec.allowedSecretRefs, "allowedSecretRefs"),
              }),
          ...(sec.deniedSecretRefs === undefined
            ? {}
            : { deniedSecretRefs: validateStringList(sec.deniedSecretRefs, "deniedSecretRefs") }),
        };
      }
      if (value.autonomy !== undefined) {
        if (!isRecord(value.autonomy)) {
          reject("constraint-shape", "side-effect payload autonomy must be an object when present");
        }
        const aut = value.autonomy as Record<string, unknown>;
        if (
          aut.maxAutonomy !== undefined &&
          !(AUTONOMY_MODES as readonly string[]).includes(aut.maxAutonomy as string)
        ) {
          reject("constraint-vocabulary", "autonomy maxAutonomy is outside the frozen vocabulary", {
            got: bounded(aut.maxAutonomy),
          });
        }
        autonomy = {
          ...(aut.maxAutonomy === undefined
            ? {}
            : { maxAutonomy: aut.maxAutonomy as AutonomyMode }),
        };
      }
      if (value.isolation !== undefined) {
        if (!isRecord(value.isolation)) {
          reject(
            "constraint-shape",
            "side-effect payload isolation must be an object when present",
          );
        }
        const iso = value.isolation as Record<string, unknown>;
        if (
          iso.minIsolation !== undefined &&
          !(ISOLATION_LEVELS as readonly string[]).includes(iso.minIsolation as string)
        ) {
          reject(
            "constraint-vocabulary",
            "isolation minIsolation is outside the frozen vocabulary",
            {
              got: bounded(iso.minIsolation),
            },
          );
        }
        isolation = {
          ...(iso.minIsolation === undefined
            ? {}
            : { minIsolation: iso.minIsolation as IsolationLevel }),
        };
      }
      if (
        network === undefined &&
        secrets === undefined &&
        autonomy === undefined &&
        isolation === undefined
      ) {
        reject("constraint-shape", "side-effect payload must carry at least one dimension");
      }
      return {
        ...(network === undefined ? {} : { network }),
        ...(secrets === undefined ? {} : { secrets }),
        ...(autonomy === undefined ? {} : { autonomy }),
        ...(isolation === undefined ? {} : { isolation }),
      };
    }
  }
}

/**
 * Total, deterministic validation of one optimization constraint.
 * Authority-sourced restrictions (policy / budget / capability /
 * verification) are HARD BY CONSTRUCTION — declaring one soft is a
 * weakened authority constraint and is rejected.
 */
export function validateOptimizationConstraint(value: unknown): OptimizationConstraint {
  if (!isRecord(value)) {
    reject("constraint-shape", "optimization constraint must be an object");
  }
  if (typeof value.constraintId !== "string" || !CONSTRAINT_ID.test(value.constraintId)) {
    reject("constraint-shape", "constraint constraintId must be a lowercase slug", {
      got: bounded(value.constraintId),
    });
  }
  if (
    typeof value.kind !== "string" ||
    !(CONSTRAINT_KINDS as readonly string[]).includes(value.kind)
  ) {
    reject("constraint-vocabulary", "constraint kind is outside the closed vocabulary", {
      got: bounded(value.kind),
    });
  }
  const kind = value.kind as ConstraintKind;
  if (
    typeof value.enforcement !== "string" ||
    !(CONSTRAINT_ENFORCEMENTS as readonly string[]).includes(value.enforcement)
  ) {
    reject("constraint-vocabulary", "constraint enforcement must be hard or soft", {
      got: bounded(value.enforcement),
    });
  }
  const enforcement = value.enforcement as ConstraintEnforcement;
  const source = validateSource(value.source);
  // Authority restrictions are never soft (the weakened-protection
  // boundary): only planning-sourced task-derived preferences may be.
  if (enforcement === "soft" && source.authority !== "planning") {
    reject(
      "constraint-authority-mismatch",
      `constraints sourced from the ${source.authority} authority must be hard (a soft authority restriction is a weakened protection)`,
      { constraintId: value.constraintId, authority: source.authority },
    );
  }
  // Kind/authority coherence: the payload kind must match the authority
  // that defines those semantics (policy semantics come from the policy
  // authority or its planning capture; budget ceilings from budgets or
  // policy; capability satisfaction from the capability authority's
  // resolution; verification requirements from the frozen binding;
  // task-derived floors from planning).
  const coherent: Readonly<Record<ConstraintAuthority, readonly ConstraintKind[]>> = {
    policy: ["policy", "budget", "quality", "latency", "side-effect"],
    capability: ["capability"],
    budget: ["budget"],
    verification: ["verification"],
    planning: ["quality", "latency"],
  };
  if (!coherent[source.authority].includes(kind)) {
    reject(
      "constraint-authority-mismatch",
      `constraint kind "${kind}" is not coherent with source authority "${source.authority}"`,
      { constraintId: value.constraintId, kind, authority: source.authority },
    );
  }
  const payload = validatePayload(kind, value.payload);
  return { constraintId: value.constraintId, kind, enforcement, source, payload };
}

/**
 * Validate a constraint SET: every constraint valid, ids unique. Empty
 * sets are valid here (the decision-record contract requires the
 * governing inputs — a decision with no constraints is rejected there).
 */
export function validateConstraintSet(
  value: readonly unknown[],
): readonly OptimizationConstraint[] {
  const seen = new Set<string>();
  return value.map((entry) => {
    const constraint = validateOptimizationConstraint(entry);
    if (seen.has(constraint.constraintId)) {
      reject("constraint-set", "constraint ids must be unique within the set", {
        constraintId: constraint.constraintId,
      });
    }
    seen.add(constraint.constraintId);
    return constraint;
  });
}

// ---------------------------------------------------------------------------
// Hard-constraint enforcement (fail closed; soft never enforced)
// ---------------------------------------------------------------------------

/**
 * The closed violation vocabulary. Each code names the violated hard
 * constraint semantics (mirroring the planning module's typed
 * inadmissibility codes plus the IR-level checks).
 */
export const CONSTRAINT_VIOLATION_CODES = [
  "policy-forbidden-route",
  "policy-forbidden-tool",
  "budget-ceiling",
  "quality-floor",
  "latency-ceiling",
  "capability-unsatisfied",
  "verification-anchor-missing",
  "side-effect-class-forbidden",
] as const;
export type ConstraintViolationCode = (typeof CONSTRAINT_VIOLATION_CODES)[number];

/** One hard-constraint violation (bounded evidence). */
export interface ConstraintViolation {
  readonly constraintId: string;
  readonly kind: ConstraintKind;
  readonly code: ConstraintViolationCode;
  readonly detail: string;
}

const DETAIL_MAX = 300;

function violationDetail(detail: string): string {
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
}

function compareMicroUsd(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Route eligibility — the planning module's own sanctioned semantics,
 * mirrored exactly (denylists dominate; non-empty allowlists exclude).
 */
export function routeAllowedByPolicy(
  provider: string,
  model: string,
  providerModel: PolicyConstraintPayload["providerModel"],
): boolean {
  if (providerModel === undefined) {
    return true;
  }
  const { allowedProviders, deniedProviders, allowedModels, deniedModels } = providerModel;
  if (deniedProviders?.includes(provider) === true) {
    return false;
  }
  if (allowedProviders !== undefined && allowedProviders.length > 0) {
    if (!allowedProviders.includes(provider)) {
      return false;
    }
  }
  if (deniedModels?.includes(model) === true) {
    return false;
  }
  if (allowedModels !== undefined && allowedModels.length > 0) {
    if (!allowedModels.includes(model)) {
      return false;
    }
  }
  return true;
}

function irHasVerificationAnchor(ir: ExecutionIr): boolean {
  return (
    ir.steps.some((step) => step.stepClass === "verify") ||
    ir.steps.some((step) => step.verificationStrategy !== undefined)
  );
}

/**
 * Enforce HARD constraints against the IR and its candidate
 * representations. SOFT constraints are never checked (recorded only —
 * architecture invariant 3). Returns the bounded violation evidence;
 * callers decide the fail-closed response (the decision-record builder
 * rejects any decision with violations).
 */
export function enforceHardConstraints(
  ir: ExecutionIr,
  candidates: readonly CandidateRepresentation[],
  constraints: readonly OptimizationConstraint[],
): readonly ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const add = (
    constraint: OptimizationConstraint,
    code: ConstraintViolationCode,
    detail: string,
  ): void => {
    violations.push({
      constraintId: constraint.constraintId,
      kind: constraint.kind,
      code,
      detail: violationDetail(detail),
    });
  };

  for (const constraint of constraints) {
    if (constraint.enforcement === "soft") {
      // Recorded, never enforced — by construction.
      continue;
    }
    switch (constraint.kind) {
      case "policy": {
        const payload = constraint.payload as PolicyConstraintPayload;
        if (payload.providerModel !== undefined) {
          for (const step of ir.steps) {
            if (step.routeRef === undefined) {
              continue;
            }
            if (
              !routeAllowedByPolicy(
                step.routeRef.provider,
                step.routeRef.model,
                payload.providerModel,
              )
            ) {
              add(
                constraint,
                "policy-forbidden-route",
                `IR step ${step.id} route ${step.routeRef.provider}/${step.routeRef.model} is not allowed by the effective policy restriction set`,
              );
            }
          }
        }
        if (payload.tool !== undefined) {
          const { allowedTools, deniedTools } = payload.tool;
          for (const step of ir.steps) {
            if (step.stepClass !== "call-tool" || step.capabilityId === undefined) {
              continue;
            }
            if (deniedTools?.includes(step.capabilityId) === true) {
              add(
                constraint,
                "policy-forbidden-tool",
                `IR step ${step.id} tool ${step.capabilityId} is denied by the effective policy`,
              );
              continue;
            }
            if (allowedTools !== undefined && allowedTools.length > 0) {
              if (!allowedTools.includes(step.capabilityId)) {
                add(
                  constraint,
                  "policy-forbidden-tool",
                  `IR step ${step.id} tool ${step.capabilityId} is outside the policy tool allowlist`,
                );
              }
            }
          }
        }
        break;
      }
      case "capability": {
        const payload = constraint.payload as CapabilityConstraintPayload;
        for (const step of ir.steps) {
          if (step.capabilityId === undefined) {
            continue;
          }
          if (payload.unmetIds.includes(step.capabilityId)) {
            add(
              constraint,
              "capability-unsatisfied",
              `IR step ${step.id} binds capability ${step.capabilityId} which the capability resolution left unmet`,
            );
            continue;
          }
          if (
            payload.satisfiedIds.length > 0 &&
            !payload.satisfiedIds.includes(step.capabilityId)
          ) {
            add(
              constraint,
              "capability-unsatisfied",
              `IR step ${step.id} binds capability ${step.capabilityId} outside the satisfied capability set`,
            );
          }
        }
        break;
      }
      case "budget": {
        const payload = constraint.payload as BudgetConstraintPayload;
        for (const candidate of candidates) {
          const claim = validateCostClaim(candidate.claim);
          if (compareMicroUsd(claim.expectedCostMicroUsd, payload.maxCostMicroUsd) > 0) {
            add(
              constraint,
              "budget-ceiling",
              `candidate ${candidate.candidateId} expected cost ${claim.expectedCostMicroUsd} exceeds the ceiling ${payload.maxCostMicroUsd}`,
            );
          }
        }
        break;
      }
      case "quality": {
        const payload = constraint.payload as QualityConstraintPayload;
        for (const candidate of candidates) {
          const claim = validateCostClaim(candidate.claim);
          if (payload.minQuality !== undefined && claim.expectedQuality < payload.minQuality) {
            add(
              constraint,
              "quality-floor",
              `candidate ${candidate.candidateId} expected quality ${claim.expectedQuality} is below the floor ${payload.minQuality}`,
            );
          }
          if (
            payload.minReliability !== undefined &&
            claim.expectedReliability < payload.minReliability
          ) {
            add(
              constraint,
              "quality-floor",
              `candidate ${candidate.candidateId} expected reliability ${claim.expectedReliability} is below the floor ${payload.minReliability}`,
            );
          }
        }
        break;
      }
      case "latency": {
        const payload = constraint.payload as LatencyConstraintPayload;
        const maxLatencyMs = payload.maxLatencyMs as number;
        for (const candidate of candidates) {
          const claim = validateCostClaim(candidate.claim);
          if (claim.expectedLatencyMs > maxLatencyMs) {
            add(
              constraint,
              "latency-ceiling",
              `candidate ${candidate.candidateId} expected latency ${claim.expectedLatencyMs}ms exceeds the ceiling ${maxLatencyMs}ms`,
            );
          }
        }
        break;
      }
      case "verification": {
        const payload = constraint.payload as VerificationConstraintPayload;
        if (payload.requiresVerificationAnchor && !irHasVerificationAnchor(ir)) {
          add(
            constraint,
            "verification-anchor-missing",
            "the IR carries no verification anchor (no verify step and no step-level verification strategy)",
          );
        }
        break;
      }
      case "side-effect": {
        const payload = constraint.payload as SideEffectConstraintPayload;
        // The single derivable frozen rule: network egress `none`
        // forbids external-effect steps (conservative fail-closed; the
        // policy authority owns the semantics).
        if (payload.network?.egress === "none") {
          for (const step of ir.steps) {
            if (step.sideEffectClass === "external-effect") {
              add(
                constraint,
                "side-effect-class-forbidden",
                `IR step ${step.id} carries side-effect class external-effect which policy network egress "none" forbids`,
              );
            }
          }
        }
        break;
      }
    }
  }
  return violations;
}

/**
 * Does this IR step reference a generative model route? (Helper for
 * consumers reasoning about model-required vs model-optional facts.)
 */
export function stepIsModelRequired(stepClass: string): boolean {
  return isGenerativeStepClass(stepClass as Parameters<typeof isGenerativeStepClass>[0]);
}
