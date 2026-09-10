/**
 * Fresh escalation packages (platform failure-recovery plane; WORK-055 /
 * E1.1 — "fresh escalation" — bounded, typed escalation packages).
 *
 * ESCALATION IS BOUNDED AND EVIDENCE-CARRYING (never
 * self-authorizing): an escalation package is the TYPED value that
 * carries exactly the Work Order's required content —
 *
 *  - the ATTRIBUTED failure (typed, evidence-bound — `attribution.ts`;
 *    an escalation without an attributed cause is unrepresentable);
 *  - the ACCUMULATED EVIDENCE (a bounded set of content-addressed
 *    references: decision-record ids and observation digests — the
 *    evidence the recovery decision ran on, never payload echoes);
 *  - the CONTINUATION PAYLOAD (the typed, content-addressed
 *    continuation package the fresh context resumes from —
 *    `continuation.ts`);
 *  - the recovery STRATEGY record that justified escalation (the
 *    selected escalate-fresh verdict — the economic justification
 *    from the model-economics escalation hook, carried as evidence).
 *
 * Bounded by EXPLICIT policy inputs (the configuration's
 * evidence-entry bound), typed, content-addressed (escalationId =
 * sha256 over the canonical form), and totally validated at read
 * time. Pure data: no store, no lifecycle, no authorization surface —
 * the package is evidence a caller hands to the existing escalation
 * seams (the executions module's WAITING_HUMAN/escalate path and the
 * human-escalation representation), never an engine.
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import type { FailureAttribution } from "./attribution";
import { validateFailureAttribution } from "./attribution";
import {
  boundedDetail,
  MAX_ESCALATION_EVIDENCE_ENTRIES,
  reject,
  SHA256_HEX_PATTERN,
} from "./catalog";
import type { ContinuationPackage } from "./continuation";
import { validateContinuationPackage } from "./continuation";
import type { StrategyVerdict } from "./strategy";

// ---------------------------------------------------------------------------
// The evidence-reference vocabulary
// ---------------------------------------------------------------------------

/**
 * One accumulated-evidence reference — content-addressed, typed:
 * either a WORK-049 decision-record identity or a failure-observation
 * digest (the durable events the recovery decision ran on).
 */
export type EscalationEvidenceReference =
  | { readonly kind: "decision-record"; readonly decisionId: string }
  | { readonly kind: "observation"; readonly observationDigest: string };

/** The frozen basis statement of every escalation package. */
export const ESCALATION_PACKAGE_BASIS =
  "bounded-typed-escalation;attributed-failure-required;accumulated-evidence-bounded-by-configuration;continuation-payload-required;content-addressed-identity";

// ---------------------------------------------------------------------------
// The escalation package
// ---------------------------------------------------------------------------

/**
 * The bounded, typed escalation package — DATA carrying the
 * attributed failure, the accumulated evidence and the continuation
 * payload. Never an authorization, never an engine.
 */
export interface EscalationPackage {
  /** Content-derived identity: sha256 over the canonical package form. */
  readonly escalationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The execution the escalation belongs to, when bound. */
  readonly executionId?: string;
  /** The ATTRIBUTED failure being escalated (validated). */
  readonly failure: FailureAttribution;
  /** The bounded accumulated evidence (content-addressed references). */
  readonly evidence: readonly EscalationEvidenceReference[];
  /** The recovery strategy verdict that justified escalation (validated). */
  readonly strategy: StrategyVerdict;
  /** The continuation payload the fresh context resumes from (validated). */
  readonly continuation: ContinuationPackage;
  /** The explicit created-at instant (an INPUT, never ambient). */
  readonly createdAt: string;
  /** The frozen, human-auditable basis. */
  readonly escalationBasis: string;
}

/** The package form excluding the derived identity. */
type EscalationForm = Omit<EscalationPackage, "escalationId">;

// ---------------------------------------------------------------------------
// Construction (content-addressed, bounded, total validation)
// ---------------------------------------------------------------------------

/** The escalation-package construction input. */
export interface EscalationInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The attributed failure (REQUIRED — no attribution → no escalation). */
  readonly failure: FailureAttribution;
  /** The accumulated evidence (bounded by the configuration). */
  readonly evidence: readonly EscalationEvidenceReference[];
  /** The selected escalate-fresh strategy verdict (REQUIRED). */
  readonly strategy: StrategyVerdict;
  /** The continuation payload (REQUIRED — validated). */
  readonly continuation: ContinuationPackage;
  /** The evidence-entry bound from the recovery configuration ([1, 64]). */
  readonly evidenceBound: number;
  /** The explicit created-at instant. */
  readonly createdAt: string;
  readonly digest: IrDigestPort;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Build the escalation package: total validation (the attributed
 * failure, the strategy verdict discipline, the continuation payload,
 * the bounded evidence set) then the content-addressed identity.
 *
 * Fail-closed BEFORE the package exists:
 *  - the failure must be a valid attributed failure;
 *  - the strategy verdict must be the SELECTED escalate-fresh verdict
 *    (an inadmissible or non-escalation strategy cannot justify an
 *    escalation package — escalation is never self-authorizing);
 *  - the evidence set must respect the configuration bound and carry
 *    only well-formed content-addressed references (no duplicates);
 *  - the continuation payload must be a valid package.
 */
export function buildEscalationPackage(input: EscalationInput): EscalationPackage {
  if (!UUID_PATTERN.test(input.applicationId)) {
    reject("escalation-shape", "applicationId must be a UUID");
  }
  if (!UUID_PATTERN.test(input.tenantId)) {
    reject("escalation-shape", "tenantId must be a UUID");
  }
  if (input.executionId !== undefined && !UUID_PATTERN.test(input.executionId)) {
    reject("escalation-shape", "executionId must be a UUID when present");
  }
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) {
    reject("escalation-shape", "createdAt must be a non-empty string");
  }
  if (
    typeof input.evidenceBound !== "number" ||
    !Number.isInteger(input.evidenceBound) ||
    input.evidenceBound < 1 ||
    input.evidenceBound > MAX_ESCALATION_EVIDENCE_ENTRIES
  ) {
    reject("escalation-shape", "evidenceBound must be an integer in [1, 64]");
  }
  if (input.strategy?.admissible !== true || input.strategy.strategy !== "escalate-fresh") {
    // Escalation requires its own justification: only a SELECTED
    // escalate-fresh verdict (the economically justified path) can
    // carry an escalation package.
    reject(
      "escalation-shape",
      "an escalation package requires the selected escalate-fresh strategy verdict",
      {
        strategy: input.strategy?.strategy ?? "missing",
        admissible: input.strategy?.admissible ?? false,
      },
    );
  }
  const failure = validateFailureAttribution(input.failure, input.digest);
  if (input.strategy.attributionId !== failure.attributionId) {
    // Provenance coherence: the escalate-fresh verdict must be the one
    // decided under THIS attributed failure — a verdict from another
    // failure's selection cannot justify this escalation (exact
    // provenance, fail closed).
    reject(
      "escalation-shape",
      "the escalation strategy verdict was decided under a different failure attribution",
      {
        failureAttributionId: failure.attributionId,
        strategyAttributionId: input.strategy.attributionId,
      },
    );
  }
  const continuation = validateContinuationPackage(input.continuation, input.digest);
  if (!Array.isArray(input.evidence)) {
    reject("escalation-shape", "evidence must be an array of content-addressed references");
  }
  if (input.evidence.length === 0) {
    reject("escalation-shape", "an escalation must carry at least one evidence reference");
  }
  if (input.evidence.length > input.evidenceBound) {
    reject(
      "escalation-shape",
      `escalation evidence exceeds the configured bound of ${input.evidenceBound}`,
      { got: input.evidence.length },
    );
  }
  const evidence: EscalationEvidenceReference[] = [];
  const seen = new Set<string>();
  for (const reference of input.evidence) {
    if (
      reference?.kind === "decision-record" &&
      typeof reference.decisionId === "string" &&
      SHA256_HEX_PATTERN.test(reference.decisionId)
    ) {
      const key = `decision-record:${reference.decisionId}`;
      if (seen.has(key)) {
        reject("escalation-shape", "evidence references must be unique", { key });
      }
      seen.add(key);
      evidence.push({ kind: "decision-record", decisionId: reference.decisionId });
    } else if (
      reference?.kind === "observation" &&
      typeof reference.observationDigest === "string" &&
      SHA256_HEX_PATTERN.test(reference.observationDigest)
    ) {
      const key = `observation:${reference.observationDigest}`;
      if (seen.has(key)) {
        reject("escalation-shape", "evidence references must be unique", { key });
      }
      seen.add(key);
      evidence.push({ kind: "observation", observationDigest: reference.observationDigest });
    } else {
      reject("escalation-shape", "evidence references must be typed content-addressed values", {
        got: boundedDetail(JSON.stringify(reference)),
      });
    }
  }

  const form: EscalationForm = {
    applicationId: input.applicationId,
    tenantId: input.tenantId,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    failure,
    evidence,
    strategy: input.strategy,
    continuation,
    createdAt: input.createdAt,
    escalationBasis: ESCALATION_PACKAGE_BASIS,
  };
  if (!isCanonicalizable(form)) {
    reject("escalation-shape", "escalation form is not canonicalizable");
  }
  const escalationId = input.digest.sha256Hex(canonicalJson(form));
  return { escalationId, ...form };
}

// ---------------------------------------------------------------------------
// Total validation of a (deserialized) package
// ---------------------------------------------------------------------------

/**
 * Total, deterministic validation of an escalation-package value
 * (e.g. after a round-trip): full shape validation, the strategy
 * discipline, the evidence bounds, both embedded payloads, AND the
 * identity re-derivation — tampered or foreign values are rejected at
 * read time, never served.
 */
export function validateEscalationPackage(value: unknown, digest: IrDigestPort): EscalationPackage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("escalation-shape", "escalation package must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.escalationId !== "string" || !SHA256_HEX_PATTERN.test(record.escalationId)) {
    reject("escalation-shape", "escalationId must be a sha256 hex digest", {
      got: boundedDetail(String(record.escalationId)),
    });
  }
  if (record.escalationBasis !== ESCALATION_PACKAGE_BASIS) {
    reject("escalation-shape", "escalation basis is outside the frozen vocabulary", {
      got: boundedDetail(String(record.escalationBasis)),
    });
  }
  if (
    typeof record.evidenceBoundOverride === "number" ||
    (Array.isArray(record.evidence) && record.evidence.length > MAX_ESCALATION_EVIDENCE_ENTRIES)
  ) {
    reject("escalation-shape", "escalation evidence exceeds the hard bound");
  }
  const rebuilt = buildEscalationPackage({
    applicationId: record.applicationId as string,
    tenantId: record.tenantId as string,
    ...(record.executionId === undefined ? {} : { executionId: record.executionId as string }),
    failure: record.failure as FailureAttribution,
    evidence: record.evidence as readonly EscalationEvidenceReference[],
    strategy: record.strategy as StrategyVerdict,
    continuation: record.continuation as ContinuationPackage,
    evidenceBound: Math.min(
      MAX_ESCALATION_EVIDENCE_ENTRIES,
      Math.max(1, (record.evidence as unknown[] | undefined)?.length ?? 1),
    ),
    createdAt: record.createdAt as string,
    digest,
  });
  if (rebuilt.escalationId !== record.escalationId) {
    reject("escalation-shape", "escalation content does not digest to the claimed identity", {
      claimed: record.escalationId,
      computed: rebuilt.escalationId,
    });
  }
  return rebuilt;
}
