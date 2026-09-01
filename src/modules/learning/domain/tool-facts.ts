/**
 * Neutral tool facts (learning module domain; WORK-017 / ADR-0005).
 *
 * THE INPUT VOCABULARY of tool-composition learning — NOT a registry.
 *
 * Learning is an OBSERVATION ISLAND (the WORK-014 architecture gate:
 * this module imports NO other module). Structural facts about tools
 * (identity, version, capability bindings, input/output field
 * declarations) therefore cross INTO the analysis as CALLER-SUPPLIED
 * INPUT DATA: the composition-root or test world derives them from the
 * tools module's public registry surface and passes them to the
 * learning analysis, exactly the way execution outcomes cross into
 * telemetry as input.
 *
 * NOTHING here can:
 *  - register, mutate or resolve tools (there is no write surface —
 *    the caller's facts are the read-only basis; the tools module owns
 *    registration and resolution authority);
 *  - invoke tools (facts describe shapes, never behavior);
 *  - authorize anything (a fact's PRESENCE validates a composition's
 *    STRUCTURE only — policy admissibility is decided by the policy
 *    authority at planning time, never here — the §6 boundary
 *    "TOOL LEARNING ≠ TOOL AUTHORIZATION").
 *
 * IDENTITY IS VERSIONED (§7 of the Work Order): a fact is identified
 * by the EXACT `(toolId, version)` pair — never by the tool name alone
 * (M26: a recommendation accepted for the wrong tool version is a
 * validation failure). The analysis pins every composition step to a
 * concrete resolved version and refuses unresolved references.
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";

/** The neutral field-type vocabulary (mirrors the tools public contract). */
export const TOOL_FACT_FIELD_TYPES = ["string", "number", "boolean", "object", "array"] as const;

export type ToolFactFieldType = (typeof TOOL_FACT_FIELD_TYPES)[number];

/** One declared input/output field of a tool version (neutral shape). */
export interface ToolFactField {
  readonly name: string;
  readonly type: ToolFactFieldType;
  /** The field must be produced/consumed on every invocation. */
  readonly required: boolean;
}

/**
 * The stable identity of one tool version — the ONLY identity the
 * composition model accepts (tool names alone are insufficient, §7).
 */
export interface ToolVersionRef {
  readonly toolId: string;
  /** Exact registered version (major.minor.patch). */
  readonly version: string;
}

/**
 * Tool-fact origin vocabulary (WORK-018): platform tools and
 * synthesized tools have DIFFERENT evidence bases (a synthesized tool's
 * reliability is bounded by its runtime-test evidence and its
 * ephemeral lifetime) — the analysis can segregate populations by
 * origin instead of silently mixing incompatible bases. Absent means
 * `platform` (the pre-WORK-018 closed shape stays valid).
 */
export const TOOL_FACT_ORIGINS = ["platform", "synthesized"] as const;
export type ToolFactOrigin = (typeof TOOL_FACT_ORIGINS)[number];

/** One neutral structural fact about a concrete tool version. */
export interface ToolFact {
  readonly toolId: string;
  readonly version: string;
  /** Capability ids this tool version satisfies (policy vocabulary). */
  readonly capabilityIds: readonly string[];
  /** Declared input fields (compatibility evidence for edges). */
  readonly inputFields: readonly ToolFactField[];
  /** Declared output fields (compatibility evidence for edges). */
  readonly outputFields: readonly ToolFactField[];
  /** Where the tool version comes from (default platform; WORK-018). */
  readonly origin?: ToolFactOrigin;
}

/** A closed, deduplicated catalog of tool facts (the analysis input). */
export interface ToolFactCatalog {
  /** All facts, canonical order (toolId, version ascending). */
  readonly facts: readonly ToolFact[];
}

const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
const TOOL_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFields(
  container: Record<string, unknown>,
  key: "inputFields" | "outputFields",
  toolId: string,
): readonly ToolFactField[] {
  const value = container[key];
  if (!Array.isArray(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `tool fact ${key} must be an array of field declarations`,
      details: { toolId, field: key },
    });
  }
  return value.map((field, index) => {
    if (!isRecord(field)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `tool fact ${key}[${index}] must be an object`,
        details: { toolId, field: key },
      });
    }
    const name = field.name;
    if (typeof name !== "string" || !FIELD_NAME_PATTERN.test(name)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `tool fact ${key}[${index}].name must be a valid field name`,
        details: { toolId, field: key },
      });
    }
    const type = field.type;
    if (typeof type !== "string" || !(TOOL_FACT_FIELD_TYPES as readonly string[]).includes(type)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `tool fact ${key}[${index}].type must be the neutral field-type vocabulary`,
        details: { toolId, field: key, allowed: TOOL_FACT_FIELD_TYPES },
      });
    }
    if (typeof field.required !== "boolean") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `tool fact ${key}[${index}].required must be boolean`,
        details: { toolId, field: key },
      });
    }
    return { name, type: type as ToolFactFieldType, required: field.required };
  });
}

function parseFact(value: unknown): ToolFact {
  if (!isRecord(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "tool fact must be an object" });
  }
  const toolId = value.toolId;
  if (typeof toolId !== "string" || !TOOL_ID_PATTERN.test(toolId)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "tool fact toolId must be a lowercase hyphen-dashed identifier",
      details: { field: "toolId" },
    });
  }
  const version = value.version;
  if (typeof version !== "string" || !TOOL_VERSION_PATTERN.test(version)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "tool fact version must be major.minor.patch numerics",
      details: { toolId, field: "version" },
    });
  }
  const capabilityIds = value.capabilityIds;
  if (
    !Array.isArray(capabilityIds) ||
    capabilityIds.some((capability) => typeof capability !== "string" || capability.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "tool fact capabilityIds must be an array of non-empty strings",
      details: { toolId, field: "capabilityIds" },
    });
  }
  const origin: unknown = value.origin === undefined ? "platform" : value.origin;
  if (typeof origin !== "string" || !(TOOL_FACT_ORIGINS as readonly string[]).includes(origin)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "tool fact origin must be one of the frozen origin vocabulary when present",
      details: { toolId, field: "origin", allowed: TOOL_FACT_ORIGINS },
    });
  }
  return {
    toolId,
    version,
    capabilityIds: [...capabilityIds],
    inputFields: parseFields(value, "inputFields", toolId),
    outputFields: parseFields(value, "outputFields", toolId),
    origin: origin as ToolFactOrigin,
  };
}

/**
 * Build the validated, deduplicated tool-fact catalog (fail-closed).
 *
 * Duplicate `(toolId, version)` pairs with IDENTICAL content converge
 * (dedupe); the same pair with DIFFERENT content fails closed (an
 * ambiguous structural fact is a validation failure, never a silent
 * choice — the closed-vocabulary discipline).
 */
export function validateToolFacts(values: readonly unknown[]): ToolFactCatalog {
  if (values.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "tool-composition analysis requires a non-empty tool-fact catalog",
    });
  }
  const byIdentity = new Map<string, ToolFact>();
  for (const value of values) {
    const fact = parseFact(value);
    const identity = `${fact.toolId}@${fact.version}`;
    const existing = byIdentity.get(identity);
    if (existing !== undefined) {
      const canonical = (input: ToolFact): string =>
        JSON.stringify({
          toolId: input.toolId,
          version: input.version,
          capabilityIds: [...input.capabilityIds].sort(),
          inputFields: input.inputFields.map((field) => [field.name, field.type, field.required]),
          outputFields: input.outputFields.map((field) => [field.name, field.type, field.required]),
          origin: input.origin ?? "platform",
        });
      if (canonical(existing) !== canonical(fact)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "conflicting tool facts for the same (toolId, version)",
          details: { identity },
        });
      }
      continue;
    }
    byIdentity.set(identity, fact);
  }
  const facts = [...byIdentity.values()].sort((a, b) =>
    a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : a.version < b.version ? -1 : 1,
  );
  return { facts };
}

/** Resolve the fact for an exact (toolId, version) reference, or null. */
export function findToolFact(
  catalog: ToolFactCatalog,
  toolId: string,
  version: string,
): ToolFact | null {
  const found = catalog.facts.find((fact) => fact.toolId === toolId && fact.version === version);
  return found ?? null;
}

/** Whether any version of the tool exists in the catalog. */
export function toolExistsInCatalog(catalog: ToolFactCatalog, toolId: string): boolean {
  return catalog.facts.some((fact) => fact.toolId === toolId);
}
