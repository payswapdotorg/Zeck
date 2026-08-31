/**
 * Substrate-selection domain (planning module domain; WORK-031, CSX-003,
 * ADR-0016 invariant 4).
 *
 * THE durable substrate-selection rationale: which computational
 * substrates were considered for the selected strategy, which were
 * ADMITTED and why, which were inadmissible with TYPED reasons, and
 * which substrate was selected — recorded as evidence on the planning
 * decision (criterion 6 of the work order: substrate-selection
 * rationale + resource characteristics as execution evidence).
 *
 * THE ORDERING INVARIANT (CSX-003): substrate selection happens ONLY
 * AFTER policy inputs, capability resolution and deterministic-first
 * sufficiency — the consultation captures reference digests of those
 * upstream decisions (the ordering evidence), and the planner's
 * consultation is structurally post-sufficiency (the composition-
 * consultation precedent). A deterministic-sufficient strategy needs
 * NO substrate: the record is "no-substrate-required" — deterministic-
 * first planning applied BEFORE provider/substrate selection
 * (ADR-0016 invariant 4, proven by the discrimination suite).
 *
 * It is NOT authority: the selection is planning evidence; execution
 * dispatch goes through the EXISTING paths (model routes, tools, the
 * sandbox manager) under the EXISTING admission chains.
 */

import { PlatformError } from "../../../shared/errors";
import type { WorkloadClass } from "../../capabilities/public";
import { isWorkloadClass } from "../../capabilities/public";

/** Why a substrate candidate was inadmissible (typed, closed). */
export const SUBSTRATE_INADMISSIBLE_REASONS = [
  "substrate-suspended",
  "workload-class-unsupported",
  "latency-class-mismatch",
  "isolation-below-policy",
  "cost-above-ceiling",
  "capability-unresolved",
] as const;
export type SubstrateInadmissibleReason = (typeof SUBSTRATE_INADMISSIBLE_REASONS)[number];

export function isSubstrateInadmissibleReason(value: string): value is SubstrateInadmissibleReason {
  return (SUBSTRATE_INADMISSIBLE_REASONS as readonly string[]).includes(value);
}

/** One admissible candidate with its resource characteristics. */
export interface SubstrateCandidate {
  readonly substrateId: string;
  readonly version: string;
  /** The opaque adapter reference (never a vendor). */
  readonly adapterRef: string;
  /** Neutral resource characteristics (the record's profile). */
  readonly resource: {
    readonly cpuMilliCores: number;
    readonly memoryMiB: number;
    readonly estimatedDurationMs: number;
    readonly estimatedCostMicroUsd: string;
  };
  readonly isolation: string;
  readonly latencyClass: string;
}

/** One inadmissible candidate with its typed reason. */
export interface SubstrateRejection {
  readonly substrateId: string;
  readonly version: string;
  readonly reason: SubstrateInadmissibleReason;
  readonly detail: string;
}

/** The durable substrate-selection record. */
export interface SubstrateSelection {
  /**
   * "no-substrate-required" — the deterministic-first outcome: a
   * deterministic-sufficient strategy needs no substrate at all.
   * "selected" — a substrate was selected from the ADMISSIBLE set.
   * "none-admissible" — every candidate was inadmissible (fail-closed
   * honest state; the plan may still stand on non-substrate routes).
   */
  readonly outcome: "no-substrate-required" | "selected" | "none-admissible";
  readonly workloadClass: WorkloadClass | null;
  /** The admissible candidates considered (with resource characteristics). */
  readonly admissible: readonly SubstrateCandidate[];
  /** The inadmissible candidates with typed reasons (full honesty). */
  readonly inadmissible: readonly SubstrateRejection[];
  /** The selected substrate (null unless outcome === "selected"). */
  readonly selected: { readonly substrateId: string; readonly version: string } | null;
  readonly rationale: string;
  /**
   * The ordering evidence (CSX-003): digests/identities of the
   * upstream decisions this selection is provably AFTER —
   * policyInputsDigest, capabilityCatalogRevision, sufficiencyOutcome.
   */
  readonly after: {
    readonly policyInputsCaptured: boolean;
    readonly capabilityResolutionCaptured: boolean;
    readonly deterministicSufficiencyApplied: boolean;
  };
}

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ADAPTER_REF_PATTERN = /^[a-z0-9][a-z0-9.-]{0,199}$/;

/** Fail-closed closed-shape validation of a substrate selection. */
export function validateSubstrateSelection(value: unknown): SubstrateSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "substrate selection must be an object",
    });
  }
  const s = value as SubstrateSelection;
  if (
    s.outcome !== "no-substrate-required" &&
    s.outcome !== "selected" &&
    s.outcome !== "none-admissible"
  ) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "substrate selection outcome must be one of the closed vocabulary",
    });
  }
  if (s.workloadClass !== null && s.workloadClass !== undefined) {
    if (typeof s.workloadClass !== "string" || !isWorkloadClass(s.workloadClass)) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "substrate selection workloadClass must be the frozen vocabulary or null",
      });
    }
  }
  if (!Array.isArray(s.admissible) || !Array.isArray(s.inadmissible)) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "substrate selection candidates must be arrays",
    });
  }
  for (const candidate of s.admissible) {
    if (candidate === null || typeof candidate !== "object") {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "admissible candidate must be an object",
      });
    }
    const c = candidate as SubstrateCandidate;
    if (typeof c.substrateId !== "string" || !IDENTITY_PATTERN.test(c.substrateId)) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "candidate substrateId must be an identifier",
      });
    }
    if (typeof c.version !== "string" || !VERSION_PATTERN.test(c.version)) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "candidate version must be semver",
      });
    }
    if (typeof c.adapterRef !== "string" || !ADAPTER_REF_PATTERN.test(c.adapterRef)) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "candidate adapterRef must be an opaque neutral reference",
      });
    }
    if (c.resource === null || typeof c.resource !== "object") {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "candidate resource profile is required",
      });
    }
  }
  for (const rejection of s.inadmissible) {
    if (rejection === null || typeof rejection !== "object") {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "inadmissible rejection must be an object",
      });
    }
    const r = rejection as SubstrateRejection;
    if (!isSubstrateInadmissibleReason(r.reason)) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: `rejection reason "${String(r.reason)}" is not in the closed vocabulary`,
      });
    }
  }
  if (s.outcome === "selected") {
    if (s.selected === null || s.selected === undefined) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "a selected outcome requires the selected substrate",
      });
    }
    if (typeof s.selected.substrateId !== "string" || typeof s.selected.version !== "string") {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "the selected substrate must be identified",
      });
    }
    const isSelectedAdmissible = s.admissible.some(
      (candidate) =>
        candidate.substrateId === s.selected?.substrateId &&
        candidate.version === s.selected?.version,
    );
    if (!isSelectedAdmissible) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "the selected substrate must be among the ADMISSIBLE candidates",
      });
    }
  } else if (s.selected !== null && s.selected !== undefined) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "only a selected outcome carries a selected substrate",
    });
  }
  if (typeof s.rationale !== "string" || s.rationale.length === 0 || s.rationale.length > 2000) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "substrate selection rationale must be 1..2000 characters",
    });
  }
  if (s.after === null || typeof s.after !== "object") {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "substrate selection must carry the ordering evidence",
    });
  }
  const after = s.after as SubstrateSelection["after"];
  if (
    typeof after.policyInputsCaptured !== "boolean" ||
    typeof after.capabilityResolutionCaptured !== "boolean" ||
    typeof after.deterministicSufficiencyApplied !== "boolean"
  ) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "the ordering evidence must be the three boolean captures",
    });
  }
  // THE ORDERING INVARIANT (CSX-003): a substrate selection may only be
  // recorded AFTER all three upstream decisions.
  if (
    !after.policyInputsCaptured ||
    !after.capabilityResolutionCaptured ||
    !after.deterministicSufficiencyApplied
  ) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message:
        "substrate selection requires policy inputs, capability resolution and deterministic-first sufficiency to be captured first (CSX-003 ordering)",
    });
  }
  return {
    outcome: s.outcome,
    workloadClass: s.workloadClass ?? null,
    admissible: [...s.admissible],
    inadmissible: [...s.inadmissible],
    selected: s.selected ?? null,
    rationale: s.rationale,
    after: {
      policyInputsCaptured: after.policyInputsCaptured,
      capabilityResolutionCaptured: after.capabilityResolutionCaptured,
      deterministicSufficiencyApplied: after.deterministicSufficiencyApplied,
    },
  };
}
