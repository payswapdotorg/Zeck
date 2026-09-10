/**
 * Unified failure attribution (platform failure-recovery plane; WORK-055 /
 * E1.1 — ADR-0020 "Intelligence failures and infrastructure/provider/tool
 * failures must be distinguished").
 *
 * ATTRIBUTION IS THE CORE (the Work Order's own guidance): every
 * recovery action is downstream of a TYPED, EVIDENCE-BOUND failure
 * attribution — there is no recovery decision without one (architecture
 * invariant 1: attribution before action).
 *
 * The discipline, fail-closed and total:
 *
 *  - a FAILURE OBSERVATION is what an execution seam reports: one
 *    closed signal, a bounded opaque component reference (WHERE it
 *    failed — never a vendor name), an optional step/route/substrate
 *    anchor binding the observation to the governed work, a bounded
 *    human-auditable detail, the explicit observed-at instant (an
 *    INPUT, never ambient time) and the digest of the raw observation
 *    bytes (provenance: the durable event the seam persisted);
 *  - a FAILURE ATTRIBUTION is ONE class of the closed five
 *    (infrastructure/provider/tool/resource/intelligence) PLUS the
 *    class-specific typed evidence PLUS the observation. Building one
 *    validates EVERYTHING:
 *      · the class must be ADMISSIBLE for the signal (the closed
 *        SIGNAL_CLASS_ADMISSIBILITY table — blaming an unreachable
 *        transport on model quality is a typed cross-classification
 *        rejection, the exact ADR-0020 misattribution);
 *      · the class evidence must MATCH the claimed class (evidence
 *        tagged `infrastructure` cannot support a `provider`
 *        attribution);
 *      · provider signals require the COHERENT provider error class
 *        (a `provider-rate-limited` signal with evidence
 *        `server-error` is incoherent — rejected);
 *      · intelligence evidence must carry the OBSERVED quality that
 *        failed (the number the verification/quality authority
 *        measured — attribution never REDEFINES the gate, it records
 *        the gate's verdict: verification authority contracts remain
 *        the only quality authority);
 *  - attribution is CONTENT-ADDRESSED: `attributionId` is the digest
 *    of the canonical attribution form, so the same observation +
 *    class + evidence always produce the same identity (re-attributing
 *    under the same inputs is a byte-identical value — determinism),
 *    and a tampered value fails read-time validation with a typed
 *    identity-mismatch rejection.
 *
 * Pure and deterministic: no clock, no randomness, no ambient state
 * (architecture invariant 5). Attribution is DECISION INPUT (evidence),
 * never an authorization and never a quality-gate redefinition
 * (VERIFICATION-SEPARATION).
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import {
  boundedDetail,
  COMPONENT_REF_PATTERN,
  DETAIL_MAX,
  FAILURE_SIGNALS,
  type FailureClass,
  type FailureSignal,
  PROVIDER_ERROR_CLASSES,
  type ProviderErrorClass,
  RESOURCE_KINDS,
  type ResourceKind,
  reject,
  SHA256_HEX_PATTERN,
  SIGNAL_CLASS_ADMISSIBILITY,
  SIGNAL_PROVIDER_ERROR_CLASS,
  TOOL_ERROR_CODE_PATTERN,
} from "./catalog";

// ---------------------------------------------------------------------------
// The failure observation (what the seams report)
// ---------------------------------------------------------------------------

/**
 * A failure observation: one closed signal from one bounded component
 * of the execution fabric, anchored (optionally) to the governed work
 * position where it was observed, with the digest of the durable raw
 * observation (the seam's own event bytes — EXECUTION-PROVENANCE).
 */
export interface FailureObservation {
  /** The closed failure-signal vocabulary (the ONLY legal input shape). */
  readonly signal: FailureSignal;
  /** WHERE the failure was observed — a bounded opaque component slug. */
  readonly component: string;
  /** The governed IR step the failure was observed at, when known. */
  readonly stepId?: string;
  /** The model route the failure was observed on, when route-bound. */
  readonly routeRef?: { readonly provider: string; readonly model: string };
  /** The compute substrate the failure was observed on, when substrate-bound. */
  readonly substrateRef?: { readonly substrateId: string; readonly version: string };
  /** Bounded human-auditable detail (never a payload echo). */
  readonly detail: string;
  /** The explicit observed-at instant (RFC3339 — an INPUT, never ambient). */
  readonly observedAt: string;
  /** sha256 over the raw observation bytes the seam persisted. */
  readonly observationDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total, deterministic validation of a failure observation. */
export function validateFailureObservation(value: unknown): FailureObservation {
  if (!isRecord(value)) {
    reject("observation-shape", "failure observation must be an object");
  }
  const record = value;
  if (
    typeof record.signal !== "string" ||
    !(FAILURE_SIGNALS as readonly string[]).includes(record.signal)
  ) {
    reject("observation-shape", "observation signal is outside the closed vocabulary", {
      got: boundedDetail(String(record.signal)),
    });
  }
  if (typeof record.component !== "string" || !COMPONENT_REF_PATTERN.test(record.component)) {
    reject("observation-shape", "observation component must be a bounded neutral slug", {
      got: boundedDetail(String(record.component)),
    });
  }
  if (typeof record.detail !== "string" || record.detail.length > DETAIL_MAX) {
    reject("observation-shape", "observation detail must be bounded text", {
      got: boundedDetail(String(record.detail)),
    });
  }
  if (typeof record.observedAt !== "string" || record.observedAt.length === 0) {
    reject("observation-shape", "observedAt must be a non-empty string");
  }
  if (
    typeof record.observationDigest !== "string" ||
    !SHA256_HEX_PATTERN.test(record.observationDigest)
  ) {
    reject("observation-shape", "observationDigest must be a sha256 hex digest", {
      got: boundedDetail(String(record.observationDigest)),
    });
  }
  if (record.stepId !== undefined) {
    if (typeof record.stepId !== "string" || record.stepId.length === 0) {
      reject("observation-shape", "stepId must be non-empty text when present");
    }
  }
  if (record.routeRef !== undefined) {
    if (
      !isRecord(record.routeRef) ||
      typeof record.routeRef.provider !== "string" ||
      typeof record.routeRef.model !== "string" ||
      record.routeRef.provider.length === 0 ||
      record.routeRef.model.length === 0
    ) {
      reject(
        "observation-shape",
        "routeRef must carry bounded non-empty provider/model when present",
      );
    }
  }
  if (record.substrateRef !== undefined) {
    if (
      !isRecord(record.substrateRef) ||
      typeof record.substrateRef.substrateId !== "string" ||
      typeof record.substrateRef.version !== "string" ||
      record.substrateRef.substrateId.length === 0 ||
      record.substrateRef.version.length === 0
    ) {
      reject(
        "observation-shape",
        "substrateRef must carry non-empty substrateId/version when present",
      );
    }
  }
  return record as unknown as FailureObservation;
}

// ---------------------------------------------------------------------------
// The class-specific evidence (typed, closed)
// ---------------------------------------------------------------------------

/**
 * The class-specific typed evidence every attribution MUST carry. The
 * tag must MATCH the claimed failure class — evidence tagged for one
 * class can never support another (cross-classification guard).
 */
export type FailureClassEvidence =
  | {
      readonly kind: "infrastructure";
      /** Whether the infrastructure failure was observed transient (retryable shape). */
      readonly transient: boolean;
    }
  | {
      readonly kind: "provider";
      /** The closed provider error surface (coherent with the signal). */
      readonly providerErrorClass: ProviderErrorClass;
    }
  | {
      readonly kind: "tool";
      /** The bounded neutral tool error code the tool surface reported. */
      readonly toolErrorCode: string;
    }
  | {
      readonly kind: "resource";
      /** The closed resource-exhaustion vocabulary. */
      readonly resourceKind: ResourceKind;
    }
  | {
      readonly kind: "intelligence";
      /**
       * The OBSERVED quality that failed (the verification/quality
       * authority's own measurement — recorded, never redefined here).
       */
      readonly observedQuality: number;
      /** The verification evidence identity binding, when verification-anchored. */
      readonly verificationId?: string;
    };

/** The frozen basis statement of every attribution. */
export const FAILURE_ATTRIBUTION_BASIS =
  "one-class-of-closed-five;signal-admissible-class-required;class-evidence-kind-must-match;provider-evidence-signal-coherent;content-addressed-identity";

// ---------------------------------------------------------------------------
// The failure attribution
// ---------------------------------------------------------------------------

/** The attributed failure — decision input for recovery selection. */
export interface FailureAttribution {
  /** Content-derived identity: sha256 over the canonical attribution form. */
  readonly attributionId: string;
  /** ONE class of the closed five (typed). */
  readonly failureClass: FailureClass;
  /** The class-specific typed evidence (matching the class — validated). */
  readonly evidence: FailureClassEvidence;
  /** The observation the attribution was derived from (validated). */
  readonly observation: FailureObservation;
  /** The frozen, human-auditable attribution basis. */
  readonly attributionBasis: string;
}

/** The attribution form excluding the derived identity. */
type AttributionForm = Omit<FailureAttribution, "attributionId">;

/** Canonical attribution form — the exact bytes the attributionId covers. */
export function canonicalAttributionForm(form: AttributionForm): string {
  if (!isCanonicalizable(form)) {
    throw new TypeError("attribution form is not canonicalizable");
  }
  return canonicalJson(form);
}

/**
 * Attribute a failure: derive the TYPED, evidence-bound attribution
 * from one observation, one claimed class and its class evidence.
 *
 * Fail-closed BEFORE the attribution exists:
 *  - the claimed class must be admissible for the observation's signal
 *    (the closed table — cross-classification is a typed rejection);
 *  - the evidence kind must match the claimed class;
 *  - provider signals require the coherent provider error class;
 *  - intelligence evidence must carry a bounded observed quality.
 *
 * The result is content-addressed: the same inputs always produce the
 * byte-identical attribution (identical attributionId).
 */
export function attributeFailure(
  observation: FailureObservation,
  claimedClass: FailureClass,
  evidence: FailureClassEvidence,
  digest: IrDigestPort,
): FailureAttribution {
  const validated = validateFailureObservation(observation);
  if (typeof claimedClass !== "string") {
    reject("attribution-unattributed", "the claimed failure class must be a typed class");
  }
  const admissible = SIGNAL_CLASS_ADMISSIBILITY[validated.signal];
  if (!admissible.includes(claimedClass)) {
    // The ADR-0020 misattribution guard: an environmental signal can
    // never become an intelligence failure (and vice versa).
    reject("attribution-cross-classified", "the claimed class is not admissible for the signal", {
      signal: validated.signal,
      claimedClass,
      admissibleClasses: admissible.join(","),
    });
  }
  if (evidence === undefined || evidence === null || typeof evidence !== "object") {
    // No class evidence → unattributed (invariant 1: no attribution
    // without evidence; no recovery action without attribution).
    reject("attribution-unattributed", "an attribution requires its class-specific evidence");
  }
  if (evidence.kind !== claimedClass) {
    reject("attribution-cross-classified", "the evidence kind does not match the claimed class", {
      claimedClass,
      evidenceKind: evidence.kind,
    });
  }
  // Class-evidence discipline: each class's evidence carries its own
  // typed, closed shape — validated per kind (the kind match above
  // makes this switch total over the closed union).
  switch (evidence.kind) {
    case "infrastructure":
      if (typeof evidence.transient !== "boolean") {
        reject("attribution-unattributed", "infrastructure evidence must carry the transient flag");
      }
      break;
    case "provider": {
      // Provider evidence coherence: the signal names the provider
      // error surface; the evidence must agree with it.
      const expected =
        SIGNAL_PROVIDER_ERROR_CLASS[validated.signal as keyof typeof SIGNAL_PROVIDER_ERROR_CLASS];
      if (expected !== undefined && evidence.providerErrorClass !== expected) {
        reject("attribution-cross-classified", "provider evidence is incoherent with the signal", {
          signal: validated.signal,
          expected,
          got: evidence.providerErrorClass,
        });
      }
      if (
        typeof evidence.providerErrorClass !== "string" ||
        !(PROVIDER_ERROR_CLASSES as readonly string[]).includes(evidence.providerErrorClass)
      ) {
        reject("attribution-unattributed", "provider evidence must carry the closed error class");
      }
      break;
    }
    case "resource": {
      if (!(RESOURCE_KINDS as readonly string[]).includes(evidence.resourceKind)) {
        reject("attribution-unattributed", "resource evidence must carry the closed resource kind");
      }
      break;
    }
    case "tool": {
      if (
        typeof evidence.toolErrorCode !== "string" ||
        !TOOL_ERROR_CODE_PATTERN.test(evidence.toolErrorCode)
      ) {
        reject(
          "attribution-unattributed",
          "tool evidence must carry a bounded neutral error code",
          {
            got: boundedDetail(String(evidence.toolErrorCode)),
          },
        );
      }
      break;
    }
    case "intelligence": {
      if (
        typeof evidence.observedQuality !== "number" ||
        !Number.isFinite(evidence.observedQuality) ||
        evidence.observedQuality < 0 ||
        evidence.observedQuality > 1
      ) {
        reject(
          "attribution-unattributed",
          "intelligence evidence must carry the observed quality in [0, 1]",
        );
      }
      if (evidence.verificationId !== undefined && typeof evidence.verificationId !== "string") {
        reject("attribution-unattributed", "verificationId must be a string when present");
      }
      break;
    }
  }

  const form: AttributionForm = {
    failureClass: claimedClass,
    evidence,
    observation: validated,
    attributionBasis: FAILURE_ATTRIBUTION_BASIS,
  };
  const attributionId = digest.sha256Hex(canonicalJson(form));
  return { attributionId, ...form };
}

// ---------------------------------------------------------------------------
// Total validation of a (deserialized) attribution
// ---------------------------------------------------------------------------

/**
 * Total, deterministic validation of an attribution value (e.g. after
 * a round-trip): full observation validation, class-vocabulary
 * admissibility, evidence/class coherence AND identity verification —
 * `attributionId` must be the digest of the canonical form (tampered
 * or foreign values are rejected at read time, never served).
 */
export function validateFailureAttribution(
  value: unknown,
  digest: IrDigestPort,
): FailureAttribution {
  if (!isRecord(value)) {
    reject("attribution-shape", "failure attribution must be an object");
  }
  const record = value;
  if (typeof record.attributionId !== "string" || !SHA256_HEX_PATTERN.test(record.attributionId)) {
    reject("attribution-shape", "attributionId must be a sha256 hex digest", {
      got: boundedDetail(String(record.attributionId)),
    });
  }
  const observation = validateFailureObservation(record.observation);
  if (
    typeof record.failureClass !== "string" ||
    !(SIGNAL_CLASS_ADMISSIBILITY[observation.signal] as readonly string[]).includes(
      record.failureClass,
    )
  ) {
    reject("attribution-cross-classified", "the attribution class is inadmissible for its signal", {
      signal: observation.signal,
      got: boundedDetail(String(record.failureClass)),
    });
  }
  if (record.attributionBasis !== FAILURE_ATTRIBUTION_BASIS) {
    reject("attribution-shape", "attribution basis is outside the frozen vocabulary", {
      got: boundedDetail(String(record.attributionBasis)),
    });
  }
  if (!isRecord(record.evidence)) {
    reject("attribution-unattributed", "the attribution must carry its class evidence");
  }
  if (record.evidence.kind !== record.failureClass) {
    reject("attribution-cross-classified", "the evidence kind does not match the class");
  }
  const form: Record<string, unknown> = {
    failureClass: record.failureClass,
    evidence: record.evidence,
    observation,
    attributionBasis: FAILURE_ATTRIBUTION_BASIS,
  };
  const computed = digest.sha256Hex(canonicalJson(form));
  if (computed !== record.attributionId) {
    reject("attribution-shape", "attribution content does not digest to the claimed identity", {
      claimed: record.attributionId,
      computed,
    });
  }
  return record as unknown as FailureAttribution;
}
