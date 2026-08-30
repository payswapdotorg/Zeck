/**
 * Agent version domain (agents module domain; WORK-011, AGT-004/ACP-002).
 *
 * The immutable EXECUTABLE artifact of an agent, strictly separated from
 * its durable identity (`agent.ts`):
 *
 *   Agent               → stable identity/catalog record
 *   AgentVersion        → immutable executable definition (this file)
 *   AgentSelection      → which version currently runs (promotion/rollback)
 *
 * A version row is WRITE-ONCE: it is inserted with its validation state
 * and is NEVER updated or deleted (physically enforced by migration 0006;
 * there is no update path in the store port either). Promotion and
 * rollback NEVER mutate a version — they append NEW selection records
 * (see `AgentSelectionRecord`), so "mutable current-version data
 * masquerading as artifact mutation" is unrepresentable.
 *
 * The `AgentDefinition` is a CLOSED, provider-neutral shape: agent code
 * names WHAT it needs (requested tool capabilities, secret REFERENCES —
 * never values, approval-required action classes, the isolation level,
 * its directive) and the authorities decide whether it gets it. Raw
 * long-lived secrets are structurally unrepresentable: the shape has no
 * secret-valued field, unknown keys are rejected, and secret-SHAPED
 * strings in any free-text field are rejected by validation (AGT-005/
 * ACP-003 boundary, enforced before any durable write).
 */

import type { AutonomyMode, IsolationLevel } from "../../policies/public";

/** Validation states of an immutable version artifact. */
export const VERSION_VALIDATION_STATES = ["pending", "valid", "invalid"] as const;
export type VersionValidationState = (typeof VERSION_VALIDATION_STATES)[number];

export function isVersionValidationState(value: string): value is VersionValidationState {
  return (VERSION_VALIDATION_STATES as readonly string[]).includes(value);
}

/** Kinds of selection records (promotion/rollback metadata). */
export const AGENT_SELECTION_KINDS = ["initial", "promotion", "rollback"] as const;
export type AgentSelectionKind = (typeof AGENT_SELECTION_KINDS)[number];

/** Scope kinds a scoped credential grant may carry (references, never values). */
export const CREDENTIAL_SCOPE_KINDS = ["model", "tool", "endpoint", "secret"] as const;
export type CredentialScopeKind = (typeof CREDENTIAL_SCOPE_KINDS)[number];

/** The CLOSED permission-request shape of an agent definition. */
export interface RequestedPermissions {
  /** Tool capability identifiers the agent asks to use (neutral ids). */
  readonly tools: readonly string[];
  /** Secret REFERENCES (opaque ids, never values) the agent asks to materialize. */
  readonly secretRefs: readonly string[];
  /** Provider-neutral model capability identifiers (optional). */
  readonly models?: readonly string[];
}

/** The agent's own immutable directive + governance declarations. */
export interface AgentDefinition {
  /** The agent's standing instruction (what it is for). Never a secret. */
  readonly instructions: string;
  /** Permissions the agent REQUESTS (policy decides the effective set). */
  readonly requestedPermissions: RequestedPermissions;
  /** Action classes configured high-risk: dispatch requires human approval. */
  readonly approvalRequiredActions: readonly string[];
  /** Compute isolation the agent's runtime requires (policies vocabulary). */
  readonly isolation: IsolationLevel;
  /** The maximum autonomy the agent may request for a session. */
  readonly maxAutonomy: AutonomyMode;
  /** Per-session wall-clock ceiling in milliseconds (1..86400000). */
  readonly maxSessionDurationMs: number;
}

/** The immutable versioned executable artifact. */
export interface AgentVersionRecord {
  /** Durable version identity (UUIDv7). */
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** FK to the owning agent identity. */
  readonly agentId: string;
  /** Semantic version string (unique per agent within an application). */
  readonly version: string;
  readonly definition: Readonly<AgentDefinition>;
  /** Content digest over the canonical definition (content-addressed). */
  readonly definitionDigest: string;
  readonly validationState: VersionValidationState;
  readonly validationNotes: string | null;
  readonly createdAt: string;
}

/**
 * A promotion/rollback decision: WHICH immutable version is selected.
 * Append-only; the current selection of an agent is the latest record.
 * Rollback selects a PREVIOUSLY VALID version — it never edits one.
 */
export interface AgentSelectionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly selectedVersionId: string;
  readonly kind: AgentSelectionKind;
  /** The selection this one rolls back (rollback records only). */
  readonly rollbackOf: string | null;
  readonly selectedBy: string;
  readonly reason: string | null;
  readonly selectedAt: string;
}

export type DefinitionCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,99}$/;
const ACTION_CLASS = /^[a-z0-9][a-z0-9:-]{0,99}$/;
const SECRET_REF = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

/**
 * Strings that look like raw long-lived secret material. Embedding any of
 * these in an agent definition is rejected BEFORE any durable write
 * (AGT-005/ACP-003: agent code/configuration must never carry raw
 * long-lived secrets — only opaque references). Patterns cover the common
 * vendor key/token shapes and generic `secret:`/`token:` assignments.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[a-zA-Z0-9]{20,}\b/, // generic `sk-` vendor API key
  /\bsk-ant-[a-zA-Z0-9-]{20,}\b/, // `sk-ant-` vendor API key
  /\bghp_[a-zA-Z0-9]{30,}\b/, // GitHub PAT
  /\bgho_[a-zA-Z0-9]{30,}\b/,
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/, // Slack token
  /\bAIza[0-9A-Za-z_-]{30,}\b/, // Google API key
  /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/i, // bearer header
  /\b(?:api[-_]?key|secret|password|token)\s*[:=]\s*['"]?[a-zA-Z0-9._-]{16,}/i, // key: value
  /\bBEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY\b/, // PEM key material
];

/** Does a free-text value carry raw secret material? (fail-closed check) */
export function containsRawSecretValue(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Pure, fail-closed validation of an agent definition. Every dimension
 * must be present, well-formed, and secret-free; a malformed definition
 * can never be published and therefore never run. Mirrors
 * `validateToolContract` (tools) / `validatePolicySet` (policies).
 */
export function validateAgentDefinition(definition: unknown): DefinitionCheck {
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
    return { valid: false, reason: "agent definition must be an object" };
  }
  const d = definition as AgentDefinition;
  const allowed = new Set([
    "instructions",
    "requestedPermissions",
    "approvalRequiredActions",
    "isolation",
    "maxAutonomy",
    "maxSessionDurationMs",
  ]);
  for (const key of Object.keys(d)) {
    if (!allowed.has(key)) {
      return {
        valid: false,
        reason: `unknown agent-definition field "${key}" (closed shape; raw secrets are unrepresentable)`,
      };
    }
  }
  if (
    typeof d.instructions !== "string" ||
    d.instructions.length === 0 ||
    d.instructions.length > 20000
  ) {
    return { valid: false, reason: "instructions must be a non-empty string (max 20000 chars)" };
  }
  if (containsRawSecretValue(d.instructions)) {
    return {
      valid: false,
      reason: "instructions must not embed raw secret material (references only, never values)",
    };
  }
  if (d.requestedPermissions === null || typeof d.requestedPermissions !== "object") {
    return { valid: false, reason: "requestedPermissions is required" };
  }
  const perms = d.requestedPermissions;
  const permKeys = new Set(Object.keys(perms));
  if (permKeys.has("models") === false && permKeys.size !== 2) {
    return { valid: false, reason: "requestedPermissions carries unknown fields" };
  }
  if (!Array.isArray(perms.tools)) {
    return { valid: false, reason: "requestedPermissions.tools must be an array" };
  }
  if (new Set(perms.tools).size !== perms.tools.length) {
    return { valid: false, reason: "requestedPermissions.tools must not contain duplicates" };
  }
  for (const tool of perms.tools) {
    if (typeof tool !== "string" || !IDENTIFIER.test(tool)) {
      return {
        valid: false,
        reason: `requested tool "${String(tool)}" is not a neutral identifier`,
      };
    }
  }
  if (!Array.isArray(perms.secretRefs)) {
    return { valid: false, reason: "requestedPermissions.secretRefs must be an array" };
  }
  if (new Set(perms.secretRefs).size !== perms.secretRefs.length) {
    return { valid: false, reason: "requestedPermissions.secretRefs must not contain duplicates" };
  }
  for (const ref of perms.secretRefs) {
    if (typeof ref !== "string" || !SECRET_REF.test(ref)) {
      return {
        valid: false,
        reason: `secret reference "${String(ref)}" is not a valid opaque reference`,
      };
    }
  }
  if (perms.models !== undefined) {
    if (!Array.isArray(perms.models)) {
      return { valid: false, reason: "requestedPermissions.models must be an array when present" };
    }
    if (new Set(perms.models).size !== perms.models.length) {
      return { valid: false, reason: "requestedPermissions.models must not contain duplicates" };
    }
    for (const model of perms.models) {
      if (typeof model !== "string" || !IDENTIFIER.test(model)) {
        return {
          valid: false,
          reason: `requested model "${String(model)}" is not a neutral identifier`,
        };
      }
    }
  }
  if (!Array.isArray(d.approvalRequiredActions)) {
    return { valid: false, reason: "approvalRequiredActions must be an array" };
  }
  if (new Set(d.approvalRequiredActions).size !== d.approvalRequiredActions.length) {
    return { valid: false, reason: "approvalRequiredActions must not contain duplicates" };
  }
  for (const action of d.approvalRequiredActions) {
    if (typeof action !== "string" || !ACTION_CLASS.test(action)) {
      return {
        valid: false,
        reason: `approval-required action "${String(action)}" is not a valid action class`,
      };
    }
  }
  if (typeof d.isolation !== "string") {
    return { valid: false, reason: "isolation must be declared (policies vocabulary)" };
  }
  if (typeof d.maxAutonomy !== "string") {
    return { valid: false, reason: "maxAutonomy must be declared (policies vocabulary)" };
  }
  if (
    typeof d.maxSessionDurationMs !== "number" ||
    !Number.isInteger(d.maxSessionDurationMs) ||
    d.maxSessionDurationMs < 1 ||
    d.maxSessionDurationMs > 86_400_000
  ) {
    return { valid: false, reason: "maxSessionDurationMs must be an integer within 1..86400000" };
  }
  return { valid: true };
}

/**
 * Canonical definition JSON for content addressing (sorted keys — the
 * WORK-009 canonical-serializer discipline): the same definition always
 * digests identically, so version identity is content-derived.
 */
export function canonicalDefinitionJson(definition: Readonly<AgentDefinition>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonical(record[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(definition));
}
