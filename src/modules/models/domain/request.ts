/**
 * Provider-neutral model request contracts (models module domain).
 *
 * `spec/architecture.md` §12 / `IMPLEMENTATION.md` §10: the request/response
 * contracts carry NO provider-specific types. Adapters translate this shape
 * into their wire formats; routing and dispatch decisions reference
 * capabilities and connections, never provider SDK types.
 */

import type { TaskCapabilityProfile } from "../../capabilities/public";

export type ModelMessageRole = "system" | "user" | "assistant";

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
}

/**
 * Structured output request: the caller declares a JSON schema and the
 * adapter obtains a schema-conforming JSON object from the provider through
 * whatever native mechanism the provider offers (native JSON-schema
 * response formats, forced tool schemas, or equivalent).
 */
export interface StructuredOutputSpec {
  /** A stable, provider-neutral name for the schema (adapter-sanctioned identifier). */
  readonly name: string;
  /** JSON Schema (draft 2020-12 subset commonly supported across providers). */
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  /** Provider-resolved model identifier as configured on the connection's rail. */
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly structuredOutput?: StructuredOutputSpec;
  readonly stream?: boolean;
  /**
   * Task capability profile (WORK-005 / INT-002): the capability
   * requirements derived from the task. The gateway resolves this profile
   * through the capability authority BEFORE any rail/provider selection;
   * an unsatisfied profile fails canonical `CAPABILITY_UNAVAILABLE`. When
   * absent, the empty profile resolves trivially (profile derivation is
   * `/planning`'s authority, INT-001 — a future Work Order).
   */
  readonly taskProfile?: TaskCapabilityProfile;
}

/** Provider-neutral stop reasons (normalized from provider finish reasons). */
export const STOP_REASONS = ["stop", "length", "content-filter", "tool-use", "other"] as const;
export type StopReason = (typeof STOP_REASONS)[number];
