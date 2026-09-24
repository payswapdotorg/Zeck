/**
 * PPR-003 — the defect-class vocabulary (the failure taxonomy every
 * finding and failed step carries).
 *
 * A defect class names the CLASS of a deviation so the next
 * smallest-valid correction Work Order can be scoped mechanically.
 * The vocabulary is closed: a finding outside this set is a harness
 * defect (pinned by the contract unit test).
 */

export interface DefectClass {
  readonly id: string;
  readonly description: string;
}

/** The closed defect-class vocabulary (sorted, stable). */
export const DEFECT_CLASSES: readonly DefectClass[] = Object.freeze([
  {
    id: "reachability",
    description:
      "the target surface did not answer over HTTP (connection refused, timeout, DNS) — recorded as evidence, never a crash",
  },
  {
    id: "identity-drift",
    description:
      "the deployed plane's /identity attestation does not verify at the expected exact revision/manifest/tier state (wrong revision, tampered manifest or schema drift) — fail-closed for the whole run",
  },
  {
    id: "health-semantics",
    description:
      "GET /health deviates from the honest control-plane/dependency vocabulary (control plane not ready, or an unexpected status class without the explicit degraded allowance)",
  },
  {
    id: "route-boundary",
    description:
      "a public route answered outside its honest boundary semantics (expected 401 AUTHENTICATION_FAILED, 422 CAPABILITY_UNAVAILABLE or the 200 public artifact)",
  },
  {
    id: "landing-chain",
    description:
      "a landing redirect-chain defect on the plane's root bridge (a loop, a chain exceeding the hop budget or an unreachable hop — a real browser fails to land too)",
  },
  {
    id: "navigation",
    description:
      "an experience-surface link graph defect (a served page's internal navigation target does not answer, or a required structural navigation landmark is absent)",
  },
  {
    id: "console-error-signal",
    description:
      "a resource referenced by a served page failed to load (the HTTP-observable source of browser console errors — 4xx/5xx on script/style/image targets)",
  },
  {
    id: "accessibility-structure",
    description:
      "a served experience page lacks a structural keyboard/focus affordance (skip link, focusable navigation anchors, aria-current active semantics, viewport meta or labeled controls)",
  },
  {
    id: "responsive-plan",
    description:
      "a served experience page lacks the responsive plan markers (no mobile and/or tablet-desktop media-query classes in the served CSS)",
  },
  {
    id: "reduced-motion",
    description: "a served experience page's CSS carries no prefers-reduced-motion rule",
  },
  {
    id: "disclosure-honesty",
    description:
      "an availability/capability disclosure deviates from the machine manifest's recorded truth (a provider-gated family presented without its gate, a missing disclosure section, or a served page misclassifying a family)",
  },
  {
    id: "secret-exposure",
    description:
      "a secret-shaped value appeared in a served page or response (or would have appeared in the harness's own output) — recorded redacted, never echoed",
  },
  {
    id: "url-hygiene",
    description:
      "a configured target URL carries embedded credentials (scheme://user:pass@host) — refused before any request is made",
  },
  {
    id: "matrix-integrity",
    description:
      "the capability coverage matrix could not be derived from the machine manifests (missing family, non-existent example path, invalid classification vocabulary or a value-shaped gate)",
  },
  {
    id: "harness-internal",
    description:
      "the harness's own machinery deviated (self-scan unclean, report shape invalid) — a harness defect, never a target defect",
  },
] as const);

/** The closed id set (for the contract test and runtime validation). */
export const DEFECT_CLASS_IDS: readonly string[] = Object.freeze(
  DEFECT_CLASSES.map((entry) => entry.id),
);

/** Fail-closed check: an id must be in the closed vocabulary. */
export function isDefectClass(id: string): boolean {
  return DEFECT_CLASS_IDS.includes(id);
}
