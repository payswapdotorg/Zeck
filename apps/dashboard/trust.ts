/**
 * Zeck dashboard trust-state presentation (WORK-038).
 *
 * THE ONE trust-state presentation vocabulary: every route that renders a
 * trust fact — the execution Result/Evidence views, the artifact views,
 * the Trust surfaces — composes THIS module, so the same semantic
 * vocabulary (axis labels, the never-a-score note, the evidence links)
 * appears everywhere and nowhere else (Implementation Requirement 2).
 *
 * The honesty rules (the WORK-033/036 trust checkpoint, extended):
 *  - the four success dimensions (provider/execution/quality/policy) are
 *    rendered as SEPARATE facts and never merged into a single verdict
 *    or score (AC3);
 *  - every displayed trust claim is grounded in a platform verification /
 *    evidence authority — a reference is LINKED only when a public object
 *    with that id exists on the public wire (an output artifact of this
 *    execution); otherwise the recorded reference is shown verbatim as
 *    what it is — a platform-recorded reference — never as a link that
 *    would imply evidence the platform does not expose (AC2);
 *  - no confidence verdict exists without verification results;
 *  - the trust summary on a result surface states WHERE each axis's
 *    evidence lives and links there contextually — never forcing the
 *    user back through indexes (AC4).
 *
 * This module renders; the derivations live in projection.ts (pure
 * view-models over the public wire shapes only).
 */

import type {
  ArtifactReference,
  Execution,
  ExecutionEvent,
  ExecutionResult,
  VerificationResult,
} from "../../sdk";
import { esc, keyValueTable } from "./components";
import {
  deriveTrustAxes,
  deriveVerificationChip,
  type TrustAxis,
  type TrustAxisKind,
} from "./projection";

// ---------------------------------------------------------------------------
// The shared vocabulary (one source for every route)
// ---------------------------------------------------------------------------

/** The user-language label for each trust axis (AC3 — distinct, never merged). */
export const TRUST_AXIS_LABELS: Readonly<Record<TrustAxisKind, string>> = {
  provider: "Provider success",
  execution: "Execution success",
  quality: "Quality success",
  policy: "Policy success",
};

/** The one note every trust surface carries (AC1 — no magic score). */
export const TRUST_NOTE =
  "The four axes are separate facts — they are never merged into a single score.";

/** The trust-summary lead: trust is what the platform recorded (AC1). */
export const TRUST_SUMMARY_LEAD =
  "Trust in this result is what the platform recorded — each fact below links to the evidence behind it.";

/** The axis label function (the one; pages never define their own). */
export function trustAxisLabel(kind: TrustAxisKind): string {
  return TRUST_AXIS_LABELS[kind];
}

// ---------------------------------------------------------------------------
// Where each axis's evidence lives (AC4 — contextual drill-down)
// ---------------------------------------------------------------------------

/**
 * The contextual evidence location for each axis: where on the execution
 * surface the axis's platform facts are shown in full. Links are
 * contextual (same execution, targeted view) — never through an index.
 */
export function axisEvidenceLocation(
  axis: TrustAxis,
  executionId: string,
): { readonly label: string; readonly href: string } {
  const id = encodeURIComponent(executionId);
  switch (axis.kind) {
    case "provider":
      return {
        label: "Route facts (the recorded route summary)",
        href: `/runs/${id}?tab=evidence#route-facts`,
      };
    case "execution":
      return {
        label: "Activity timeline (the recorded lifecycle)",
        href: `/runs/${id}?tab=activity`,
      };
    case "quality":
      return {
        label: "Verification results (each check, with its evidence refs)",
        href: `/runs/${id}?tab=evidence#verification-results`,
      };
    case "policy":
      return {
        label: "Activity timeline (the recorded policy events)",
        href: `/runs/${id}?tab=activity`,
      };
  }
}

// ---------------------------------------------------------------------------
// Evidence reference links (AC2 — link only what publicly exists)
// ---------------------------------------------------------------------------

/**
 * Render one platform-recorded evidence reference: a LINK to the artifact
 * view when the reference identifies an output artifact of this execution
 * (a public object), otherwise the reference verbatim with an explicit
 * note — the platform recorded the reference, but no public object with
 * that id is exposed on this execution, and the dashboard never invents
 * a target (never a dead or fabricated link).
 */
export function evidenceRefLink(
  reference: string,
  artifacts: readonly ArtifactReference[],
  executionId: string,
): string {
  const known = artifacts.some((artifact) => artifact.id === reference);
  if (known) {
    return `<a class="evidence-ref" href="/assets/artifacts/${encodeURIComponent(
      reference,
    )}?executionId=${encodeURIComponent(executionId)}">${esc(reference)}</a>`;
  }
  return `<span class="evidence-ref evidence-ref-plain" title="A platform-recorded reference — no public object with this id is exposed on this execution">${esc(
    reference,
  )}</span>`;
}

/**
 * Render a check's evidence refs: linked where a public artifact exists,
 * verbatim otherwise. With no refs at all: the honest empty marker.
 */
export function evidenceRefLinks(
  refs: readonly string[],
  artifacts: readonly ArtifactReference[],
  executionId: string,
): string {
  if (refs.length === 0) {
    return '<span class="muted">— no evidence refs recorded on this check</span>';
  }
  return refs.map((ref) => evidenceRefLink(ref, artifacts, executionId)).join("\n      ");
}

// ---------------------------------------------------------------------------
// The Result-view trust summary (AC1/AC3)
// ---------------------------------------------------------------------------

export interface TrustSummaryView {
  readonly execution: Execution;
  readonly result: ExecutionResult;
  readonly events: readonly ExecutionEvent[];
}

/**
 * The result-surface trust summary: the four axes as four separate
 * labeled facts (each linked to its evidence location on this execution),
 * the verification chip, and the never-a-score vocabulary. Rendered on
 * the Result view; the same vocabulary serves every other trust surface.
 */
export function trustSummarySection(view: TrustSummaryView): string {
  const { execution, result, events } = view;
  const axes = deriveTrustAxes(execution, result, events);
  const chip = deriveVerificationChip(result.verification);
  const rows = axes
    .map((axis) => {
      const location = axisEvidenceLocation(axis, execution.id);
      return `<li class="trust-summary-axis">
      <span class="axis-kind">${esc(trustAxisLabel(axis.kind))}</span>
      <span class="axis-fact">${esc(axis.label)}</span>
      <a class="axis-evidence" href="${esc(location.href)}">${esc(location.label)}</a>
    </li>`;
    })
    .join("\n    ");
  return `<section class="trust-summary" aria-labelledby="trust-summary-title">
  <h3 id="trust-summary-title">Can you trust it?</h3>
  <p class="trust-summary-lead">${esc(TRUST_SUMMARY_LEAD)}</p>
  <ul class="trust-summary-axes">
    ${rows}
  </ul>
  <p class="trust-summary-chip">Checks: ${esc(chip)}</p>
  <p class="trust-summary-note">${esc(TRUST_NOTE)}</p>
</section>`;
}

// ---------------------------------------------------------------------------
// The Evidence-view axes table (AC2/AC3 — each claim mapped to evidence)
// ---------------------------------------------------------------------------

/**
 * The Evidence-view trust table: each axis — its user-language label,
 * what the platform records (label + detail), the fact source, and the
 * contextual link to where the full facts live (AC4). The same
 * vocabulary as the Result-view summary (one presentation module).
 */
export function trustAxesTable(axes: readonly TrustAxis[], executionId: string): string {
  const rows = axes
    .map((axis) => {
      const location = axisEvidenceLocation(axis, executionId);
      return `<tr>
      <th scope="row">${esc(trustAxisLabel(axis.kind))}</th>
      <td>${esc(axis.label)}<br><span class="muted">${esc(axis.detail)}</span></td>
      <td class="mono">${esc(axis.source)}</td>
      <td><a href="${esc(location.href)}">${esc(location.label)}</a></td>
    </tr>`;
    })
    .join("\n    ");
  return `<table class="data" aria-label="Trust state — four separate facts">
  <thead><tr><th scope="col">Trust axis</th><th scope="col">What the platform records</th><th scope="col">Fact source</th><th scope="col">See the evidence</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p class="muted trust-note">${esc(TRUST_NOTE)}</p>`;
}

// ---------------------------------------------------------------------------
// Artifact provenance/lineage/verification facts (AC5 — the shared parts)
// ---------------------------------------------------------------------------

/**
 * The artifact metadata facts (AC5): the id, the recorded digest and the
 * creation timestamp — exactly the fields the public artifact reference
 * carries, never more (no invented mime type, size or content).
 */
export function artifactMetadataTable(artifact: ArtifactReference): string {
  return keyValueTable([
    ["artifact id", artifact.id],
    ["content digest", artifact.digest === null ? "not recorded by the platform" : artifact.digest],
    ["created", artifact.createdAt],
  ]);
}

/**
 * The artifact verification references (AC5): the producing execution's
 * verification checks whose recorded evidence refs point at this
 * artifact — the platform's own linkage, never a dashboard-invented one.
 * Zero referencing checks renders the honest note.
 */
export function artifactVerificationReferences(
  verification: readonly VerificationResult[],
  artifactId: string,
  executionId: string,
): string {
  const referencing = verification.filter((check) =>
    check.evidenceRefs.some((ref) => ref === artifactId),
  );
  if (referencing.length === 0) {
    return '<p class="muted">No verification check on the producing execution records this artifact as evidence — verification results reference evidence explicitly, and none points here.</p>';
  }
  const rows = referencing
    .map((check) => {
      const symbol = check.status === "PASS" ? "✓" : check.status === "FAIL" ? "✕" : "–";
      return `<li class="check-detail">
      <span class="check-status" aria-hidden="true">${symbol}</span>
      <div class="check-facts">
        <p class="check-criterion"><strong>${esc(check.criterionId)}</strong> — ${esc(check.status)}</p>
        <p class="muted">Strategy: ${esc(check.strategy)} · Evaluator: ${esc(
          check.evaluator.kind,
        )}:${esc(check.evaluator.id)} v${esc(check.evaluator.version)} · Recorded: ${esc(
          check.recordedAt,
        )}</p>
      </div>
    </li>`;
    })
    .join("\n    ");
  const id = encodeURIComponent(executionId);
  return `<ul class="check-detail-list" aria-label="Verification checks referencing this artifact">
    ${rows}
  </ul>
<p class="muted">These are the producing execution's recorded checks — <a href="/runs/${id}?tab=evidence">see them in the full evidence view</a>.</p>`;
}

/**
 * The parent-lineage list (AC5): the input artifact references the
 * producing execution consumed (the platform's own `execution.created`
 * record), each linked to its artifact view. The honest absence renders
 * when no input refs are recorded.
 */
export function artifactParentLineage(inputRefs: readonly string[], executionId: string): string {
  if (inputRefs.length === 0) {
    return '<p class="muted">No input artifact references are recorded on the producing execution — the platform recorded no parents for this artifact.</p>';
  }
  const items = inputRefs
    .map(
      (ref) =>
        `<li><a class="evidence-ref" href="/assets/artifacts/${encodeURIComponent(
          ref,
        )}?executionId=${encodeURIComponent(executionId)}">${esc(ref)}</a></li>`,
    )
    .join("\n    ");
  return `<ul class="lineage-list" aria-label="Parent artifacts (the producing execution's recorded inputs)">
    ${items}
  </ul>
<p class="muted">Parent references come from the platform's own record of what the producing execution consumed. A parent's own detail page shows what the public wire exposes for it — artifacts cross the wire as id/digest/createdAt references, so a parent outside this execution's outputs carries exactly those reference facts and no more.</p>`;
}

/**
 * The usage references list (AC5): executions opened in this browser that
 * consumed this artifact as a recorded input — the public per-execution
 * record, honestly scoped (no cross-work usage claim is possible on the
 * public wire today).
 */
export function artifactUsageReferences(
  usages: readonly { readonly executionId: string; readonly title: string }[],
): string {
  if (usages.length === 0) {
    return '<p class="muted">No execution opened in this browser records this artifact as an input. The public API exposes no cross-work usage route — usage facts render only from executions visible here.</p>';
  }
  const items = usages
    .map(
      (usage) =>
        `<li><a href="/runs/${encodeURIComponent(usage.executionId)}">${esc(
          usage.title,
        )}</a> <span class="muted mono">${esc(usage.executionId)}</span></li>`,
    )
    .join("\n    ");
  return `<ul class="lineage-list" aria-label="Executions using this artifact as a recorded input">
    ${items}
  </ul>
<p class="muted">Usage is per-execution public record, scoped to executions opened in this browser — the public API exposes no cross-work usage route, so no such claim is made.</p>`;
}

// ---------------------------------------------------------------------------
// The contextual traversal strip (AC4)
// ---------------------------------------------------------------------------

/**
 * The contextual object navigation between result, evidence, artifact,
 * producing execution and source (AC4): rendered on the evidence and
 * artifact views so traversal never forces the user back through an
 * index. Every link is contextual (the same execution/artifact).
 */
export function contextTraversal(options: {
  readonly executionId: string;
  readonly artifactId?: string;
  readonly includeArtifact: boolean;
}): string {
  const id = encodeURIComponent(options.executionId);
  const links: string[] = [
    `<a href="/runs/${id}">Result</a>`,
    `<a href="/runs/${id}?tab=evidence">Evidence</a>`,
    `<a href="/runs/${id}?tab=activity">Activity</a>`,
  ];
  if (options.includeArtifact && options.artifactId !== undefined) {
    links.push(
      `<a href="/assets/artifacts/${encodeURIComponent(
        options.artifactId,
      )}?executionId=${id}">This artifact</a>`,
    );
  } else if (options.includeArtifact) {
    links.push(`<a href="/runs/${id}">Artifacts (on the Result view)</a>`);
  }
  return `<nav class="context-traversal" aria-label="Where to go from here">
  ${links.join('\n  <span class="muted" aria-hidden="true">·</span>\n  ')}
</nav>`;
}
