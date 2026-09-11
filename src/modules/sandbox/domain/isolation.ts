/**
 * Compute-isolation profile domain (sandbox module; WORK-058 / D-08,
 * SEC-002 — compute isolation classes and dedicated runners).
 *
 * THE typed isolation-profile family layered ON the existing sandbox
 * authority — never a new authority, never an ambient runtime
 * assignment:
 *
 *   - `standard`          — the baseline default-deny posture every
 *                           environment has had since WORK-012 (the
 *                           legacy durable class: an environment
 *                           registered without an isolation declaration
 *                           IS standard by durable record, not by
 *                           runtime default);
 *   - `strict`            — the hardened class for untrusted /
 *                           consequential work: NO ambient host access
 *                           beyond the baseline and a TIGHTENED
 *                           capability surface — no network egress at
 *                           all (an allowlist is not representable),
 *                           no writable workspace, no secret
 *                           mediation, and only isolation-substrate
 *                           kinds (the process class is explicitly NOT
 *                           a security boundary — the sandbox
 *                           architecture makes containers the initial
 *                           untrusted-code path);
 *   - `dedicated-customer`— the dedicated customer runner profile:
 *                           the environment executes ONLY on the
 *                           tenant's dedicated runner POOL (a typed
 *                           pool identity) whose claim/artifact/secret
 *                           state is never shared with other tenants
 *                           or other pools.
 *
 * GOVERNED SELECTION (SEC-002): the profile is DECLARED on the
 * environment specification, validated at registration (fail closed on
 * every unmet precondition), admitted through the EXISTING policy seam
 * (the dedicated-customer class maps onto the frozen policies
 * isolation-ladder anchor `customer-runner`, so a policy floor of
 * `customer-runner` REQUIRES the class — policy declares the required
 * class; the sandbox authority admits/constructs it), recorded in the
 * immutable admitted runtime metadata and replayed at dispatch from
 * that snapshot. A profile is never assigned at runtime: an
 * environment that did not declare `strict`/`dedicated-customer`
 * cannot acquire it at admission, claim or dispatch time (the
 * discrimination battery proves each rejection).
 *
 * Determinism (invariant 6): profile derivation is PURE — the same
 * specification admits the same profile and the same environment
 * shape under the same policy context.
 */

import type { SandboxEnvironmentKind } from "./environment";

// ---------------------------------------------------------------------------
// The isolation-profile class vocabulary (typed data, provider-neutral)
// ---------------------------------------------------------------------------

export const ISOLATION_PROFILE_CLASSES = ["standard", "strict", "dedicated-customer"] as const;

export type IsolationProfileClass = (typeof ISOLATION_PROFILE_CLASSES)[number];

export function isIsolationProfileClass(value: string): value is IsolationProfileClass {
  return (ISOLATION_PROFILE_CLASSES as readonly string[]).includes(value);
}

/**
 * The environment kinds a `strict` profile may run. The process class
 * is excluded by the sandbox security model itself (process controls
 * are not a security boundary against arbitrary untrusted code —
 * `spec/architecture.md` §2.10, the platform process-runtime header);
 * `no-execution` carries no work to harden.
 */
export const STRICT_ELIGIBLE_KINDS: readonly SandboxEnvironmentKind[] = [
  "container",
  "microvm",
  "vm",
  "customer-runner",
];

/** The kinds a `dedicated-customer` profile may run (work must execute). */
export const DEDICATED_ELIGIBLE_KINDS: readonly SandboxEnvironmentKind[] = [
  "process",
  "container",
  "microvm",
  "vm",
  "customer-runner",
];

// ---------------------------------------------------------------------------
// The typed pool identity (dedicated-customer only)
// ---------------------------------------------------------------------------

/**
 * The dedicated runner pool identity shape: a bounded opaque kebab-case
 * identifier (never a UUID requirement, never a host path, never a
 * credential shape). The pool is namespaced BY CONSTRUCTION: every
 * pool comparison happens under tenant+application equality enforced
 * by the compute-plane gates, so two tenants using the same pool
 * string still share nothing (the physical gates require tenant
 * agreement first).
 */
export const POOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidPoolId(value: string): boolean {
  return POOL_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// The declaration (carried on the environment specification)
// ---------------------------------------------------------------------------

/**
 * The isolation-profile declaration on a `ComputeEnvironmentSpec`.
 * ABSENT means the legacy `standard` class (a durable-record reading of
 * pre-WORK-058 environments — not a runtime default; the class is
 * pinned in the durable columns and cross-checked against the spec by
 * the schema, so an ambient assignment is physically
 * unrepresentable).
 */
export interface IsolationProfileDeclaration {
  readonly class: IsolationProfileClass;
  /**
   * The dedicated runner pool identity. REQUIRED iff the class is
   * `dedicated-customer`; unrepresentable otherwise.
   */
  readonly poolId?: string;
}

// ---------------------------------------------------------------------------
// Validation (pure, total, fail-closed)
// ---------------------------------------------------------------------------

export interface IsolationProfileValidation {
  readonly valid: boolean;
  readonly issues: readonly { readonly field: string; readonly reason: string }[];
}

/**
 * Validate an isolation-profile declaration against the environment
 * specification it rides on. The class-level shape rules are
 * CONSTRUCTIONAL: a `strict` environment that would need ambient
 * network egress, a writable workspace, secret mediation or a
 * non-isolation substrate is invalid AT REGISTRATION (fail closed),
 * never silently tightened or weakened at dispatch.
 */
export function validateIsolationProfileDeclaration(input: {
  readonly kind: SandboxEnvironmentKind;
  readonly isolation?: IsolationProfileDeclaration;
  readonly egress: string;
  readonly workspace: string;
  readonly secretRefs: readonly string[];
}): IsolationProfileValidation {
  const issues: { field: string; reason: string }[] = [];
  const declaration = input.isolation;

  if (declaration === undefined) {
    return { valid: true, issues };
  }
  if (declaration === null || typeof declaration !== "object") {
    return {
      valid: false,
      issues: [
        { field: "isolation", reason: "isolation must be an isolation-profile declaration" },
      ],
    };
  }
  if (!isIsolationProfileClass(declaration.class)) {
    return {
      valid: false,
      issues: [
        {
          field: "isolation.class",
          reason: `isolation class must be one of ${ISOLATION_PROFILE_CLASSES.join("|")}`,
        },
      ],
    };
  }

  if (declaration.class === "standard" && declaration.poolId !== undefined) {
    issues.push({
      field: "isolation.poolId",
      reason: "the standard class carries no dedicated pool (poolId is unrepresentable)",
    });
  }

  if (declaration.class === "strict") {
    if (!STRICT_ELIGIBLE_KINDS.includes(input.kind)) {
      issues.push({
        field: "isolation.class",
        reason: `the strict class requires an isolation-substrate kind (${STRICT_ELIGIBLE_KINDS.join("|")}); "${input.kind}" is not a security boundary for untrusted work`,
      });
    }
    if (input.egress !== "none") {
      issues.push({
        field: "isolation.class",
        reason: "the strict class admits no network egress (an allowlist is not representable)",
      });
    }
    if (input.workspace !== "none" && input.workspace !== "ephemeral-read-only") {
      issues.push({
        field: "isolation.class",
        reason: "the strict class admits no writable workspace (read-only ephemeral only)",
      });
    }
    if (input.secretRefs.length > 0) {
      issues.push({
        field: "isolation.class",
        reason:
          "the strict class admits no secret mediation (secret references are unrepresentable)",
      });
    }
    if (declaration.poolId !== undefined) {
      issues.push({
        field: "isolation.poolId",
        reason: "the strict class carries no dedicated pool (poolId is unrepresentable)",
      });
    }
  }

  if (declaration.class === "dedicated-customer") {
    if (!DEDICATED_ELIGIBLE_KINDS.includes(input.kind)) {
      issues.push({
        field: "isolation.class",
        reason: `the dedicated-customer class requires an executing kind (${DEDICATED_ELIGIBLE_KINDS.join("|")})`,
      });
    }
    if (typeof declaration.poolId !== "string" || !isValidPoolId(declaration.poolId)) {
      issues.push({
        field: "isolation.poolId",
        reason:
          "the dedicated-customer class requires a pool identity (lowercase kebab-case, max 64 chars)",
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// The profile derivation (pure; the durable record's class)
// ---------------------------------------------------------------------------

/** The resolved profile of one environment (typed data; no behavior). */
export interface IsolationProfile {
  readonly class: IsolationProfileClass;
  /** The dedicated pool identity (dedicated-customer only; else null). */
  readonly poolId: string | null;
}

/**
 * Derive the effective isolation profile of an environment
 * specification. PURE and TOTAL: an absent declaration is the legacy
 * `standard` class (the durable record reading); a present declaration
 * is its validated class. The same specification always derives the
 * same profile — the determinism invariant.
 */
export function deriveIsolationProfile(spec: {
  readonly isolation?: IsolationProfileDeclaration;
}): IsolationProfile {
  const declaration = spec.isolation;
  if (declaration === undefined || declaration === null) {
    return { class: "standard", poolId: null };
  }
  if (declaration.class === "dedicated-customer") {
    return { class: "dedicated-customer", poolId: declaration.poolId ?? null };
  }
  return { class: declaration.class, poolId: null };
}

/**
 * The policy isolation-ladder anchor of a profile — the frozen
 * `IsolationLevel` vocabulary the policy authority already evaluates
 * (`ISOLATION_LEVELS`, WORK-007). The mapping is the governed
 * selection's seam:
 *
 *   - `standard`/`strict` anchor at the environment KIND's ladder
 *     level (the strict shape is the tightest posture on every other
 *     dimension — egress none, no secrets — so no policy dimension can
 *     be violated by it);
 *   - `dedicated-customer` anchors at `customer-runner` — the ladder's
 *     dedicated-runner class. A policy floor of `customer-runner`
 *     therefore REQUIRES the dedicated class (a standard environment
 *     is denied: its kind anchor ranks below the floor), and a
 *     dedicated environment passes every floor its class satisfies.
 *
 * The anchor is submitted to the authority as the isolation FACT; the
 * authority decides (this function holds no decision logic — it is a
 * pure vocabulary mapping).
 */
export function isolationLadderAnchor(input: {
  readonly kind: SandboxEnvironmentKind;
  readonly profileClass: IsolationProfileClass;
}): "none" | "process" | "container" | "microvm" | "vm" | "customer-runner" {
  if (input.profileClass === "dedicated-customer") {
    return "customer-runner";
  }
  // The kind ladder (1:1 with the sandbox kind vocabulary).
  switch (input.kind) {
    case "no-execution":
      return "none";
    case "process":
      return "process";
    case "container":
      return "container";
    case "microvm":
      return "microvm";
    case "vm":
      return "vm";
    case "customer-runner":
      return "customer-runner";
  }
}
