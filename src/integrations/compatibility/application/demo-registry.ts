/**
 * The Demo Mirror registry (work order part E; ACR-006 §5).
 *
 * A registry of demo entries BOUND to compatibility evidence records.
 * The binding is the whole security model of the public demo surface:
 *
 *  - an entry carries NO status, NO verdict, NO completeness claim of
 *    its own (the type has no field where one could even appear);
 *  - the demo projection derives the status from the BOUND RECORD
 *    through the same strict admission evaluation used everywhere else
 *    — one definition, no drift, and a demo can therefore NEVER
 *    manufacture or upgrade a certification status (the record's facts
 *    are the only input; a PARTIAL record renders PARTIAL, always);
 *  - a registry entry whose bound record does not exist is a REGISTRY
 *    DEFECT (a named error state on the surface — never a silent
 *    fallback, never an "assume unassessed" guess);
 *  - run availability is a property of the BOUND RECORD's proof state,
 *    not of the entry: an entry can only offer a live run when the
 *    record's assessment is AI_EXECUTION_COMPLETE (the certified
 *    integration path rule — ACR-006 §5's "the mirror must execute the
 *    actual certified integration path, or a pinned application
 *    runtime, rather than a toy response generator").
 */

import type { CompatibilityEvidenceRecord } from "../domain/evidence";
import type { RevisionPin } from "../domain/revisions";
import { revisionPinsEqual } from "../domain/revisions";
import type { CompatibilityStatus } from "../domain/status";
import { evaluateCompatibility } from "../domain/status";

/** One demo entry of the public Demo Mirror. */
export interface DemoMirrorEntry {
  /** Stable demo slug (the URL coordinate: /console/demos/:demoId). */
  readonly demoId: string;
  /** The bound evidence record (by record id — the status source). */
  readonly evidenceRecordId: string;
  /** The representative task a certified run would replay. */
  readonly representativeTask: {
    readonly title: string;
    readonly description: string;
  };
  /**
   * The run binding: "none" (no certified integration exists for this
   * entry yet — the run control renders the honest not-runnable state)
   * or "pinned-runtime" (a certified integration path exists; the
   * runner executes THAT path, never a toy response generator). The
   * runner refuses "pinned-runtime" bindings whose bound record is not
   * AI_EXECUTION_COMPLETE — the binding alone confers nothing.
   */
  readonly runBinding:
    | { readonly kind: "none" }
    | { readonly kind: "pinned-runtime"; readonly runtime: string };
  /** Reproducibility metadata (rendered verbatim; fixture entries say so). */
  readonly reproducibility: {
    readonly instructions: string;
    readonly pinnedUpstreamRevision: string;
    readonly integrationRevision: string;
  };
  /** Additional warnings the entry discloses (rendered verbatim). */
  readonly warnings: readonly string[];
}

/** The registry itself (a validated list of entries). */
export interface DemoMirrorRegistry {
  readonly entries: readonly DemoMirrorEntry[];
}

/** A demo registry defect (named, machine-readable; never a silent skip). */
export interface DemoRegistryIssue {
  readonly demoId?: string;
  readonly issue: string;
}

/** Validate the registry's structure (ids, bindings, revision pins). */
export function validateDemoRegistry(registry: DemoMirrorRegistry): readonly DemoRegistryIssue[] {
  const issues: DemoRegistryIssue[] = [];
  const seen = new Set<string>();
  for (const entry of registry.entries) {
    if (typeof entry.demoId !== "string" || entry.demoId.trim().length === 0) {
      issues.push({ issue: "every demo entry carries a non-empty demo id" });
      continue;
    }
    if (seen.has(entry.demoId)) {
      issues.push({ demoId: entry.demoId, issue: "duplicate demo id" });
    }
    seen.add(entry.demoId);
    if (typeof entry.evidenceRecordId !== "string" || entry.evidenceRecordId.trim().length === 0) {
      issues.push({
        demoId: entry.demoId,
        issue: "every demo entry binds an evidence record id (the status source)",
      });
    }
    if (
      typeof entry.representativeTask?.title !== "string" ||
      entry.representativeTask.title.trim().length === 0
    ) {
      issues.push({
        demoId: entry.demoId,
        issue: "every demo entry declares its representative task",
      });
    }
    if (entry.runBinding === undefined || entry.runBinding === null) {
      issues.push({ demoId: entry.demoId, issue: "every demo entry declares its run binding" });
    }
    if (
      entry.reproducibility === undefined ||
      typeof entry.reproducibility.instructions !== "string" ||
      entry.reproducibility.instructions.trim().length === 0
    ) {
      issues.push({
        demoId: entry.demoId,
        issue: "every demo entry carries reproducibility metadata",
      });
    }
  }
  return issues;
}

/** The derived demo projection (EVERY fact derived — nothing asserted). */
export interface DemoMirrorProjection {
  readonly demoId: string;
  readonly applicationName: string;
  readonly applicationId: string;
  /** The pinned revisions, derived from the BOUND RECORD (never the entry). */
  readonly pin: RevisionPin;
  readonly representativeTask: DemoMirrorEntry["representativeTask"];
  /** Derived from the bound record through the strict admission evaluation. */
  readonly status: CompatibilityStatus;
  /** The full assessment (rule results + findings, rendered verbatim). */
  readonly findings: ReturnType<typeof evaluateCompatibility>["findings"];
  readonly ruleResults: ReturnType<typeof evaluateCompatibility>["ruleResults"];
  readonly runAvailability:
    | { readonly available: true }
    | { readonly available: false; readonly reason: string };
  readonly reproducibility: DemoMirrorEntry["reproducibility"];
  readonly warnings: readonly string[];
  readonly recordBasis: CompatibilityEvidenceRecord["recordBasis"];
}

/** The registry-resolution outcome: either the projection or a named defect. */
export type DemoMirrorResolution =
  | { readonly kind: "available"; readonly projection: DemoMirrorProjection }
  | { readonly kind: "unknown-demo"; readonly demoId: string }
  | {
      readonly kind: "record-missing";
      readonly demoId: string;
      readonly evidenceRecordId: string;
    }
  | {
      readonly kind: "revision-mismatch";
      readonly demoId: string;
      readonly detail: string;
    };

/**
 * Resolve one registry entry against the bound record into the public
 * demo projection. The status, the pins, the findings and the run
 * availability are ALL derived from the record; the entry contributes
 * presentation data only. A revision mismatch between the entry's
 * reproducibility pins and the record's pin is a named defect (the
 * entry describes a different revision than the evidence proves).
 */
export function resolveDemoMirrorEntry(
  entry: DemoMirrorEntry,
  record: CompatibilityEvidenceRecord | null,
): DemoMirrorResolution {
  if (record === null) {
    return {
      kind: "record-missing",
      demoId: entry.demoId,
      evidenceRecordId: entry.evidenceRecordId,
    };
  }
  const entryPin: RevisionPin = {
    upstreamRevision: entry.reproducibility.pinnedUpstreamRevision,
    integrationRevision: entry.reproducibility.integrationRevision,
  };
  if (!revisionPinsEqual(entryPin, record.pinnedApplication.pin)) {
    return {
      kind: "revision-mismatch",
      demoId: entry.demoId,
      detail: `The demo entry's reproducibility pins (upstream ${entryPin.upstreamRevision}, integration ${entryPin.integrationRevision}) do not match the bound evidence record's pins (upstream ${record.pinnedApplication.pin.upstreamRevision}, integration ${record.pinnedApplication.pin.integrationRevision}) — the entry describes a different revision than the evidence proves. Resolve by re-binding the entry to the record of the exact pinned revision.`,
    };
  }
  const assessment = evaluateCompatibility(record);
  const warnings = [
    ...entry.warnings,
    ...(record.recordBasis === "fixture"
      ? [
          "This demo is bound to an honest FIXTURE evidence record (proof scaffolding for the foundation itself) — it can never show a certified run.",
        ]
      : []),
  ];
  return {
    kind: "available",
    projection: {
      demoId: entry.demoId,
      applicationName: record.pinnedApplication.identity.name,
      applicationId: record.pinnedApplication.identity.applicationId,
      pin: record.pinnedApplication.pin,
      representativeTask: entry.representativeTask,
      status: assessment.status,
      findings: assessment.findings,
      ruleResults: assessment.ruleResults,
      runAvailability: runAvailabilityOf(entry, assessment.status),
      reproducibility: entry.reproducibility,
      warnings,
      recordBasis: record.recordBasis,
    },
  };
}

/**
 * Run availability is derived from the PROOF STATE: only an
 * AI_EXECUTION_COMPLETE bound record offers a live run (the certified
 * integration path rule). Everything else renders the honest reason.
 */
function runAvailabilityOf(
  entry: DemoMirrorEntry,
  status: CompatibilityStatus,
): DemoMirrorProjection["runAvailability"] {
  if (status !== "AI_EXECUTION_COMPLETE") {
    return {
      available: false,
      reason: `The bound compatibility evidence does not certify this application (status ${status}) — the Demo Mirror never runs an uncertified integration path, and never fabricates a result.`,
    };
  }
  if (entry.runBinding.kind === "none") {
    return {
      available: false,
      reason:
        "The bound record is certified, but this demo entry declares no pinned application runtime to execute — bind the certified integration's runtime to enable the run.",
    };
  }
  return { available: true };
}
