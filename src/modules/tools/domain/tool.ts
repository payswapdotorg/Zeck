/**
 * Tool contract domain (tools module domain; WORK-010, TOL-001).
 *
 * The provider-neutral `ToolContract` is the governed-tool equivalent of
 * the models fabric's neutral request/response contracts: EVERY dimension
 * the frozen architecture demands a tool to declare lives here, declared
 * ONCE, validated at registration, and consumed by the runtime's
 * admission chain:
 *
 *   tool identity            → `toolId` + `version`
 *   capability identity      → `capability` (neutral id + kind + minVersion,
 *                               resolved through the capabilities authority —
 *                               never a second registry)
 *   input schema             → `inputSchema` (domain/schema.ts)
 *   output schema            → `outputSchema`
 *   execution requirements   → `execution` (determinism, timeout, idempotency)
 *   side-effect class        → `sideEffect`
 *   network requirements     → `network` (egress + declared hosts)
 *   secret requirements      → `secrets` (access + declared refs)
 *   cost/resource expectations → `cost` (integer micro-USD ceiling estimate)
 *   evidence/provenance contract → `evidence` (artifact production declared)
 *
 * Provider specifics NEVER cross this contract: a tool names WHAT it needs
 * (network hosts, secret references as opaque refs — never values) and the
 * runtime's admission chain decides whether the effective policy permits
 * it. Which concrete implementation serves the contract is a
 * composition-root choice (adapters are registered alongside the contract).
 *
 * `spec/architecture.md` §13: tools are governed capabilities; tool
 * outcomes are observations. The contract therefore carries no authority
 * surface: an adapter bound to a contract can only produce a
 * `ToolObservation` (see ports/tool-adapter.ts) — it cannot mutate
 * customer-domain workflow state or platform authority state because it is
 * never handed any such surface.
 */

import type { CapabilityKind } from "../../capabilities/public";
import type { ToolFieldSchema } from "./schema";
import { isToolFieldSchema } from "./schema";

/** Side-effect classes of the governed tool vocabulary (§13). */
export const TOOL_SIDE_EFFECT_CLASSES = ["none", "read-only", "write-external"] as const;
export type ToolSideEffectClass = (typeof TOOL_SIDE_EFFECT_CLASSES)[number];

/** Network egress modes a tool may declare. */
export const TOOL_EGRESS_MODES = ["none", "allowlist"] as const;
export type ToolEgressMode = (typeof TOOL_EGRESS_MODES)[number];

/** Secret access modes a tool may declare (references only, never values). */
export const TOOL_SECRET_ACCESS_MODES = ["none", "allowlist"] as const;
export type ToolSecretAccessMode = (typeof TOOL_SECRET_ACCESS_MODES)[number];

/**
 * The provider-neutral capability identity a tool satisfies. `id` belongs
 * to the capability vocabulary owned by the capabilities module (WORK-005);
 * `kind` is that module's frozen kind vocabulary — the tools module never
 * invents its own capability kinds (no second capability registry).
 */
export interface ToolCapabilityIdentity {
  readonly id: string;
  readonly kind: CapabilityKind;
  /** Minimum acceptable capability claim version (defaults to any). */
  readonly minVersion?: string;
}

export interface ToolExecutionRequirements {
  /** Deterministic tools are first-class (§2.6): no model is involved. */
  readonly deterministic: boolean;
  /** Adapter execution deadline in milliseconds (1..600000). */
  readonly timeoutMs: number;
  /**
   * Whether repeated execution with the SAME input is contract-safe (the
   * same observation results). Idempotent tools may be re-executed to
   * converge after a crash; non-idempotent tools fail closed instead
   * (`NON_CONVERGENT_EXTERNAL_EFFECT`).
   */
  readonly idempotent: boolean;
}

export interface ToolNetworkRequirements {
  readonly egress: ToolEgressMode;
  /** Hosts the tool would contact (required non-empty when egress != none). */
  readonly hosts: readonly string[];
}

export interface ToolSecretRequirements {
  readonly access: ToolSecretAccessMode;
  /** Secret REFERENCES (opaque ids, never values) the tool would materialize. */
  readonly refs: readonly string[];
}

export interface ToolCostExpectations {
  /** Ceiling estimate per invocation, integer micro-USD string ("0" = free). */
  readonly estimatedMicroUsd: string;
}

export interface ToolEvidenceContract {
  /** Whether successful observations may carry artifact references. */
  readonly producesArtifacts: boolean;
}

/** The provider-neutral governed tool contract. */
export interface ToolContract {
  readonly toolId: string;
  readonly version: string;
  readonly capability: ToolCapabilityIdentity;
  readonly inputSchema: ToolFieldSchema;
  readonly outputSchema: ToolFieldSchema;
  readonly execution: ToolExecutionRequirements;
  readonly sideEffect: ToolSideEffectClass;
  readonly network: ToolNetworkRequirements;
  readonly secrets: ToolSecretRequirements;
  readonly cost: ToolCostExpectations;
  readonly evidence: ToolEvidenceContract;
}

export type ToolContractCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const MICRO_USD = /^\d{1,19}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,99}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,253}$/;
const SECRET_REF = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

/**
 * Pure, fail-closed validation of a tool contract. Every dimension must be
 * present, well-formed and internally consistent; an invalid contract can
 * never be registered and therefore never invoked. Mirrors
 * `validatePublishedFact` (capabilities) / `validatePolicySet` (policies):
 * malformed declarations never become governable state.
 */
export function validateToolContract(contract: unknown): ToolContractCheck {
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    return { valid: false, reason: "tool contract must be an object" };
  }
  const c = contract as ToolContract;
  if (typeof c.toolId !== "string" || !IDENTIFIER.test(c.toolId)) {
    return {
      valid: false,
      reason: "toolId must be a lowercase hyphen-dashed identifier (max 100 chars)",
    };
  }
  if (typeof c.version !== "string" || !VERSION.test(c.version)) {
    return { valid: false, reason: "version must be major.minor.patch numerics" };
  }
  if (c.capability === null || typeof c.capability !== "object") {
    return { valid: false, reason: "capability identity is required" };
  }
  if (typeof c.capability.id !== "string" || !IDENTIFIER.test(c.capability.id)) {
    return { valid: false, reason: "capability.id must be a neutral vocabulary identifier" };
  }
  if (typeof c.capability.kind !== "string") {
    return { valid: false, reason: "capability.kind is required (frozen capability vocabulary)" };
  }
  if (c.capability.minVersion !== undefined) {
    if (typeof c.capability.minVersion !== "string" || !VERSION.test(c.capability.minVersion)) {
      return { valid: false, reason: "capability.minVersion must be major.minor.patch numerics" };
    }
  }
  if (!isToolFieldSchema(c.inputSchema) || c.inputSchema.fields.length === 0) {
    return { valid: false, reason: "inputSchema must declare at least one field" };
  }
  if (!isToolFieldSchema(c.outputSchema) || c.outputSchema.fields.length === 0) {
    return { valid: false, reason: "outputSchema must declare at least one field" };
  }
  if (c.execution === null || typeof c.execution !== "object") {
    return { valid: false, reason: "execution requirements are required" };
  }
  if (typeof c.execution.deterministic !== "boolean") {
    return { valid: false, reason: "execution.deterministic must be boolean" };
  }
  if (
    typeof c.execution.timeoutMs !== "number" ||
    !Number.isInteger(c.execution.timeoutMs) ||
    c.execution.timeoutMs < 1 ||
    c.execution.timeoutMs > 600_000
  ) {
    return { valid: false, reason: "execution.timeoutMs must be an integer within 1..600000" };
  }
  if (typeof c.execution.idempotent !== "boolean") {
    return { valid: false, reason: "execution.idempotent must be boolean" };
  }
  if (
    typeof c.sideEffect !== "string" ||
    !(TOOL_SIDE_EFFECT_CLASSES as readonly string[]).includes(c.sideEffect)
  ) {
    return { valid: false, reason: "sideEffect must be one of the frozen side-effect classes" };
  }
  if (c.execution.deterministic && c.sideEffect === "write-external") {
    return {
      valid: false,
      reason:
        "a deterministic tool cannot declare external writes (determinism and side effects are disjoint)",
    };
  }
  if (c.network === null || typeof c.network !== "object") {
    return { valid: false, reason: "network requirements are required" };
  }
  if (
    typeof c.network.egress !== "string" ||
    !(TOOL_EGRESS_MODES as readonly string[]).includes(c.network.egress)
  ) {
    return { valid: false, reason: "network.egress must be a declared egress mode" };
  }
  if (!Array.isArray(c.network.hosts)) {
    return { valid: false, reason: "network.hosts must be an array" };
  }
  if (c.network.egress === "none" && c.network.hosts.length > 0) {
    return { valid: false, reason: "network.hosts must be empty when egress is none" };
  }
  if (c.network.egress === "allowlist" && c.network.hosts.length === 0) {
    return {
      valid: false,
      reason: "network.hosts must declare at least one host when egress is allowlist",
    };
  }
  if (new Set(c.network.hosts).size !== c.network.hosts.length) {
    return { valid: false, reason: "network.hosts must not contain duplicates" };
  }
  for (const host of c.network.hosts) {
    if (typeof host !== "string" || !HOST.test(host)) {
      return { valid: false, reason: `network host "${String(host)}" is not a valid hostname` };
    }
  }
  if (c.secrets === null || typeof c.secrets !== "object") {
    return { valid: false, reason: "secret requirements are required" };
  }
  if (
    typeof c.secrets.access !== "string" ||
    !(TOOL_SECRET_ACCESS_MODES as readonly string[]).includes(c.secrets.access)
  ) {
    return { valid: false, reason: "secrets.access must be a declared secret access mode" };
  }
  if (!Array.isArray(c.secrets.refs)) {
    return { valid: false, reason: "secrets.refs must be an array" };
  }
  if (c.secrets.access === "none" && c.secrets.refs.length > 0) {
    return { valid: false, reason: "secrets.refs must be empty when access is none" };
  }
  if (c.secrets.access === "allowlist" && c.secrets.refs.length === 0) {
    return {
      valid: false,
      reason: "secrets.refs must declare at least one reference when access is allowlist",
    };
  }
  if (new Set(c.secrets.refs).size !== c.secrets.refs.length) {
    return { valid: false, reason: "secrets.refs must not contain duplicates" };
  }
  for (const ref of c.secrets.refs) {
    if (typeof ref !== "string" || !SECRET_REF.test(ref)) {
      return {
        valid: false,
        reason: `secret reference "${String(ref)}" is not a valid opaque reference`,
      };
    }
  }
  if (c.cost === null || typeof c.cost !== "object") {
    return { valid: false, reason: "cost expectations are required" };
  }
  if (typeof c.cost.estimatedMicroUsd !== "string" || !MICRO_USD.test(c.cost.estimatedMicroUsd)) {
    return {
      valid: false,
      reason:
        "cost.estimatedMicroUsd must be an integer micro-USD string (the WORK-004 convention)",
    };
  }
  if (c.evidence === null || typeof c.evidence !== "object") {
    return { valid: false, reason: "evidence contract is required" };
  }
  if (typeof c.evidence.producesArtifacts !== "boolean") {
    return { valid: false, reason: "evidence.producesArtifacts must be boolean" };
  }
  return { valid: true };
}
