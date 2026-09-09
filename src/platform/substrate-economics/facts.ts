/**
 * Neutral substrate facts (platform substrate-economics plane; WORK-054
 * / E1.1 charter wave member 4 — ADR-0019, ADR-0020).
 *
 * THE DECLARED DESCRIPTOR SET of the substrate-economics plane: the
 * closed, typed, explicit-basis facts one compute substrate publishes
 * so Zeck can compare substrates by expected quality, readiness,
 * latency, reliability and cost (the Work Order's objective). Every
 * dimension the research baseline demands is declared ONCE and
 * validated fail-closed:
 *
 *   identity       → `substrateId` + `version` (write-once semantics
 *                    per version, the capabilities-substrate
 *                    discipline);
 *   adapter binding→ `adapterRef`, an OPAQUE neutral reference to the
 *                    replaceable adapter (never a vendor name —
 *                    CSX-004 discipline; the binding is a
 *                    composition-root choice);
 *   isolation      → the substrate's isolation class, from the FROZEN
 *                    `ISOLATION_LEVELS` ladder the WORK-049
 *                    constraint vocabulary already carries (imported
 *                    from the foundation — never re-declared, never
 *                    widened);
 *   execution      → the steady-state `CostClaim` of one unit of work
 *                    (bounded micro-USD cost, finite latency,
 *                    [0,1] quality, (0,1] reliability) with its
 *                    REQUIRED explicit estimation basis — the
 *                    WORK-049 `CostClaim` contract, imported not
 *                    forked;
 *   startup        → per availability mode (cold/warm/snapshot — the
 *                    closed mode vocabulary) the bounded readiness
 *                    latency and startup cost, each with its own
 *                    REQUIRED explicit basis.
 *
 * Invented or unattributed descriptors are REJECTED: an unknown mode,
 * a missing basis, an unbounded number or an out-of-vocabulary
 * isolation class never becomes selection input (architecture
 * invariant 4; discrimination-tested). Provider-marketing truth is
 * structurally absent: nothing in this shape can express "fast" or
 * "cheap" without a bounded number and a named attribution source.
 *
 * The descriptor is content-addressable: `canonicalSubstrateJson`
 * produces the canonical serialization (sorted keys, closed JSON
 * universe — the WORK-049 canonicalization) the facts digest and the
 * selection provenance cover.
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import { ISOLATION_LEVELS, type IsolationLevel } from "../execution-ir/constraints";
import type { CostBasisAttribution, CostClaim } from "../execution-ir/cost-model";
import { validateCostClaim } from "../execution-ir/cost-model";
import {
  MAX_SUBSTRATE_CANDIDATES,
  MAX_SUBSTRATE_LATENCY_MS,
  SUBSTRATE_ADAPTER_REF_PATTERN,
  SUBSTRATE_DESCRIPTION_MAX,
  SUBSTRATE_ID_PATTERN,
  SUBSTRATE_VERSION_PATTERN,
  boundedDetail,
  isSubstrateAvailabilityMode,
  rejectSubstrate,
  type SubstrateAvailabilityMode,
} from "./catalog";

// ---------------------------------------------------------------------------
// The startup fact (per availability mode)
// ---------------------------------------------------------------------------

/**
 * The bounded, attributed startup expectation of one availability
 * mode: the expected latency from "nothing exists" to "environment
 * READY" (`readinessMs` — the FULL created → ready path, never the
 * boot time alone) and the expected one-time cost of getting there
 * (`startupCostMicroUsd`, integer micro-USD). Both carry REQUIRED
 * explicit bases.
 */
export interface SubstrateStartupFact {
  /** Expected milliseconds from request to READY (finite, [0, 2^53-1]). */
  readonly readinessMs: number;
  /** Expected one-time startup cost (integer micro-USD string, [0, 10^18)). */
  readonly startupCostMicroUsd: string;
  /** REQUIRED explicit estimation basis (unattributed facts are rejected). */
  readonly basis: CostBasisAttribution;
}

const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,17})$/;
const MAX_COST_BIGINT = 999999999999999999n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Total, deterministic validation of one startup fact. Rejects
 * unbounded numbers and unattributed claims with typed codes.
 */
export function validateSubstrateStartupFact(value: unknown): SubstrateStartupFact {
  if (!isRecord(value)) {
    rejectSubstrate("substrate-descriptor-shape", "startup fact must be an object");
  }
  if (
    typeof value.readinessMs !== "number" ||
    !Number.isFinite(value.readinessMs) ||
    value.readinessMs < 0 ||
    value.readinessMs > MAX_SUBSTRATE_LATENCY_MS
  ) {
    rejectSubstrate("substrate-fact-unbounded", "startup readinessMs must be finite in [0, 2^53-1]", {
      got: boundedDetail(value.readinessMs),
    });
  }
  if (
    typeof value.startupCostMicroUsd !== "string" ||
    !MICRO_USD_PATTERN.test(value.startupCostMicroUsd)
  ) {
    rejectSubstrate("substrate-fact-unbounded", "startup cost must be an integer micro-USD string", {
      got: boundedDetail(value.startupCostMicroUsd),
    });
  }
  if (BigInt(value.startupCostMicroUsd) > MAX_COST_BIGINT) {
    rejectSubstrate("substrate-fact-unbounded", "startup cost exceeds the bounded money universe", {
      got: boundedDetail(value.startupCostMicroUsd),
    });
  }
  const basis = value.basis;
  if (!isRecord(basis)) {
    rejectSubstrate("substrate-fact-unattributed", "startup fact must carry an estimation basis");
  }
  if (typeof basis.basis !== "string" || !["observed", "estimated", "defaulted"].includes(basis.basis)) {
    rejectSubstrate("substrate-fact-unattributed", "startup fact basis is outside the closed vocabulary", {
      got: boundedDetail(basis.basis),
    });
  }
  if (typeof basis.source !== "string" || basis.source.length === 0 || basis.source.length > 200) {
    rejectSubstrate("substrate-fact-unattributed", "startup fact basis source must be bounded non-empty text", {
      got: boundedDetail(basis.source),
    });
  }
  if (
    basis.evidenceDigest !== undefined &&
    (typeof basis.evidenceDigest !== "string" || !/^[0-9a-f]{64}$/.test(basis.evidenceDigest))
  ) {
    rejectSubstrate("substrate-descriptor-shape", "startup fact evidenceDigest must be sha256 hex");
  }
  return {
    readinessMs: value.readinessMs,
    startupCostMicroUsd: value.startupCostMicroUsd,
    basis: {
      basis: basis.basis as CostBasisAttribution["basis"],
      source: basis.source as string,
      ...(basis.evidenceDigest === undefined ? {} : { evidenceDigest: basis.evidenceDigest as string }),
    },
  };
}

// ---------------------------------------------------------------------------
// The descriptor (the closed declared shape)
// ---------------------------------------------------------------------------

/** The startup facts by offered availability mode (cold REQUIRED). */
export interface SubstrateStartupFacts {
  /** Full cold provisioning — the always-required baseline mode. */
  readonly cold: SubstrateStartupFact;
  /** Optional warm-pool mode (absent = the substrate offers no warm pool). */
  readonly warm?: SubstrateStartupFact;
  /** Optional snapshot-restore mode (absent = no snapshot reuse). */
  readonly snapshot?: SubstrateStartupFact;
}

/**
 * The neutral substrate descriptor — one declared candidate of the
 * substrate-economics comparison. The shape is CLOSED: every field is
 * typed and bounded; vocabularies (modes, isolation) are frozen;
 * nothing vendor-shaped can be expressed.
 */
export interface SubstrateDescriptor {
  readonly substrateId: string;
  readonly version: string;
  /** OPAQUE neutral adapter reference (never a vendor name — CSX-004). */
  readonly adapterRef: string;
  /** The substrate's isolation class (the frozen ladder — imported). */
  readonly isolation: IsolationLevel;
  /** The steady-state execution claim of one unit of work (WORK-049 CostClaim). */
  readonly execution: CostClaim;
  /** The per-mode startup facts (cold required; warm/snapshot optional). */
  readonly startup: SubstrateStartupFacts;
  readonly description: string | null;
}

const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

function substrateContainsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Pure, fail-closed validation of a substrate descriptor. Vocabularies
 * are frozen, the execution claim rides the WORK-049 cost-claim
 * validation, every startup fact is bounded and attributed, free text
 * is secret-scanned — a malformed declaration never becomes selection
 * input.
 */
export function validateSubstrateDescriptor(value: unknown): SubstrateDescriptor {
  if (!isRecord(value)) {
    rejectSubstrate("substrate-descriptor-shape", "substrate descriptor must be an object");
  }
  if (typeof value.substrateId !== "string" || !SUBSTRATE_ID_PATTERN.test(value.substrateId)) {
    rejectSubstrate("substrate-descriptor-shape", "substrateId must be a lowercase hyphen-dashed identifier", {
      got: boundedDetail(value.substrateId),
    });
  }
  if (typeof value.version !== "string" || !SUBSTRATE_VERSION_PATTERN.test(value.version)) {
    rejectSubstrate("substrate-descriptor-shape", "version must be major.minor.patch numerics", {
      got: boundedDetail(value.version),
    });
  }
  if (typeof value.adapterRef !== "string" || !SUBSTRATE_ADAPTER_REF_PATTERN.test(value.adapterRef)) {
    rejectSubstrate("substrate-descriptor-shape", "adapterRef must be an opaque neutral adapter reference", {
      got: boundedDetail(value.adapterRef),
    });
  }
  if (typeof value.isolation !== "string" || !(ISOLATION_LEVELS as readonly string[]).includes(value.isolation)) {
    rejectSubstrate("substrate-descriptor-vocabulary", "isolation must be on the frozen ladder", {
      got: boundedDetail(value.isolation),
    });
  }
  // The execution claim rides the WORK-049 validation WHOLESALE (build
  // ON, never fork): unbounded or unattributed claims are rejected by
  // the foundation's own typed discipline.
  const execution = validateCostClaim(value.execution);
  if (!isRecord(value.startup) || value.startup === null) {
    rejectSubstrate("substrate-descriptor-shape", "startup facts are required (cold at minimum)");
  }
  const cold = validateSubstrateStartupFact(value.startup.cold);
  const warm =
    value.startup.warm === undefined ? undefined : validateSubstrateStartupFact(value.startup.warm);
  const snapshot =
    value.startup.snapshot === undefined
      ? undefined
      : validateSubstrateStartupFact(value.startup.snapshot);
  if (
    value.description !== undefined &&
    value.description !== null &&
    (typeof value.description !== "string" || value.description.length > SUBSTRATE_DESCRIPTION_MAX)
  ) {
    rejectSubstrate("substrate-descriptor-shape", `description must be at most ${SUBSTRATE_DESCRIPTION_MAX} characters`);
  }
  if (typeof value.description === "string" && substrateContainsRawSecretValue(value.description)) {
    rejectSubstrate("substrate-descriptor-shape", "description looks like it embeds a raw secret value");
  }
  return {
    substrateId: value.substrateId,
    version: value.version,
    adapterRef: value.adapterRef,
    isolation: value.isolation as IsolationLevel,
    execution,
    startup: { cold, ...(warm === undefined ? {} : { warm }), ...(snapshot === undefined ? {} : { snapshot }) },
    description: value.description === undefined ? null : (value.description as string | null),
  };
}

/** The modes a validated descriptor offers (deterministic order). */
export function offeredModes(descriptor: SubstrateDescriptor): readonly SubstrateAvailabilityMode[] {
  const modes: SubstrateAvailabilityMode[] = ["cold"];
  if (descriptor.startup.warm !== undefined) {
    modes.push("warm");
  }
  if (descriptor.startup.snapshot !== undefined) {
    modes.push("snapshot");
  }
  return modes;
}

/**
 * The startup fact of one offered mode. A mode the substrate does not
 * offer is a TYPED rejection (`mode-not-offered` upstream) — never a
 * silent fallback to cold (an unoffered mode is unrepresentable).
 */
export function startupFactOf(
  descriptor: SubstrateDescriptor,
  mode: SubstrateAvailabilityMode,
): SubstrateStartupFact {
  const fact =
    mode === "cold"
      ? descriptor.startup.cold
      : mode === "warm"
        ? descriptor.startup.warm
        : descriptor.startup.snapshot;
  if (fact === undefined) {
    rejectSubstrate("substrate-descriptor-vocabulary", "mode is not offered by this substrate", {
      substrateId: descriptor.substrateId,
      mode,
    });
  }
  return fact;
}

// ---------------------------------------------------------------------------
// Candidate-set validation and canonical identity
// ---------------------------------------------------------------------------

/**
 * Validate a DECLARED candidate set: every descriptor validated, ids
 * unique (a duplicate substrate identity is ambiguous selection input),
 * the set bounded. Zero candidates is LEGAL here (zero-provider
 * operation is representable — the selection decides the outcome).
 */
export function validateSubstrateCandidateSet(
  values: readonly unknown[],
): readonly SubstrateDescriptor[] {
  if (!Array.isArray(values)) {
    rejectSubstrate("selection-candidate-set", "candidate set must be an array");
  }
  if (values.length > MAX_SUBSTRATE_CANDIDATES) {
    rejectSubstrate("selection-candidate-set", `candidate set exceeds the bound of ${MAX_SUBSTRATE_CANDIDATES}`);
  }
  const seen = new Set<string>();
  const descriptors: SubstrateDescriptor[] = [];
  for (const value of values) {
    const descriptor = validateSubstrateDescriptor(value);
    const key = `${descriptor.substrateId}@${descriptor.version}`;
    if (seen.has(key)) {
      rejectSubstrate("selection-candidate-set", "substrate identities must be unique within a candidate set", {
        substrateId: key,
      });
    }
    seen.add(key);
    descriptors.push(descriptor);
  }
  return descriptors;
}

/**
 * Deterministic canonical JSON of one descriptor (sorted keys at every
 * depth — the WORK-049 canonicalization discipline). This is the
 * exact content the facts digest covers.
 */
export function canonicalSubstrateJson(descriptor: SubstrateDescriptor): string {
  const value = {
    adapterRef: descriptor.adapterRef,
    description: descriptor.description,
    execution: descriptor.execution,
    isolation: descriptor.isolation,
    startup: {
      cold: descriptor.startup.cold,
      snapshot: descriptor.startup.snapshot ?? null,
      warm: descriptor.startup.warm ?? null,
    },
    substrateId: descriptor.substrateId,
    version: descriptor.version,
  };
  if (!isCanonicalizable(value)) {
    throw new TypeError("substrate descriptor is not canonicalizable");
  }
  return canonicalJson(value);
}

/**
 * The canonical form of the WHOLE declared candidate set (deterministic
 * order: sorted by (substrateId, version) so a reordered input set
 * digests identically — input order is never identity).
 */
export function canonicalCandidateSetJson(descriptors: readonly SubstrateDescriptor[]): string {
  const ordered = [...descriptors].sort((a, b) => {
    const left = `${a.substrateId}@${a.version}`;
    const right = `${b.substrateId}@${b.version}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return canonicalJson(ordered.map(canonicalSubstrateJson));
}
