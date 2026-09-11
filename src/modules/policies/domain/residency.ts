/**
 * Data-residency constraint semantics (policies module domain; D-08 /
 * WORK-060; SEC-003).
 *
 * RESIDENCY IS A POLICY-CONSUMED CONSTRAINT — NEVER AN AUTHORITY, never
 * an authorization dimension. This file adds NO restriction dimension
 * (the nine-dimension vocabulary is untouched), NO new denial kind and
 * NO authority surface: it is the typed vocabulary and the PURE
 * fail-closed evaluation of a TENANT-DECLARED constraint against the
 * data-at-rest locality of the durable surfaces (authoritative state,
 * artifact bytes, evidence) that the deployment seam supplies.
 *
 * THE FLOW (SEC-003 binding text): a tenant declares a residency
 * constraint ("my data must remain in region(s) X"); the constraint is
 * consumed by policy (this vocabulary + evaluation — the policies
 * plane owns the constraint semantics as a consumed input); the
 * enforcement happens at the EXISTING deployment/adapter seams — the
 * caller resolves the environment's data-at-rest localities from the
 * repository manifest (the first-class `region` dimension on
 * environments.json) and evaluates: every durable surface's region must
 * satisfy the declared constraint or the operation FAILS CLOSED
 * (`residency-unsatisfied`).
 *
 * There is no grant semantics anywhere: a policy document cannot widen
 * residency (no restriction field exists to loosen), and an
 * unsatisfiable physical constraint is an absolute refusal — the same
 * discipline as the compute plane's typed physical refusals.
 *
 * This file is PURE domain: no platform, no adapters, no I/O. The
 * canonical decision form is deterministic (replayable provenance —
 * EXECUTION-PROVENANCE); digests are computed by the caller through
 * the existing hasher seam.
 */

/** The durable data-at-rest surfaces a residency constraint governs (SEC-003). */
export const DATA_AT_REST_SURFACES = ["authoritative-state", "artifact-bytes", "evidence"] as const;
export type DataAtRestSurface = (typeof DATA_AT_REST_SURFACES)[number];

/** The data-at-rest locality of one durable surface. */
export interface DataAtRestLocality {
  readonly surface: DataAtRestSurface;
  /** The region the surface's bytes live in (kebab-case region id). */
  readonly region: string;
}

/** A tenant-declared data-residency constraint (the policy-consumed input). */
export interface ResidencyConstraint {
  readonly tenantId: string;
  /**
   * The regions the tenant's data-at-rest must remain within
   * (non-empty, kebab-case, unique). An unconstrained tenant simply
   * declares no constraint at all.
   */
  readonly requiredRegions: readonly string[];
}

export type ResidencyOutcome =
  | {
      readonly outcome: "satisfied";
      readonly surfaces: readonly DataAtRestLocality[];
      readonly requiredRegions: readonly string[];
      /** The deterministic canonical decision form (replayable provenance). */
      readonly canonicalForm: string;
    }
  | {
      readonly outcome: "refused";
      readonly refusal: {
        readonly kind: "residency-unsatisfied" | "residency-invalid";
        readonly problems: readonly string[];
      };
      readonly canonicalForm: string;
    };

const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function canonicalResidencyJson(
  constraint: ResidencyConstraint,
  localities: readonly DataAtRestLocality[],
): string {
  const form = {
    tenantId: constraint.tenantId,
    requiredRegions: [...constraint.requiredRegions],
    localities: localities.map((locality) => ({
      surface: locality.surface,
      region: locality.region,
    })),
  };
  const keys = Object.keys(form).sort();
  const entries = keys.map((key) => {
    const value = form[key as keyof typeof form];
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  });
  return `{${entries.join(",")}}`;
}

/**
 * Evaluate a tenant-declared residency constraint against the
 * data-at-rest localities of the durable surfaces. PURE and total.
 *
 * Fail-closed semantics:
 *  - a declared constraint with no regions, malformed/duplicate region
 *    ids, or an empty tenant id is INVALID (typed refusal — garbage
 *    constraints never silently pass);
 *  - an empty locality list cannot prove data-at-rest locality —
 *    refused when a constraint is declared;
 *  - a locality with a malformed region is refused;
 *  - satisfied IFF every declared surface's region is one of the
 *    constraint's required regions.
 */
export function evaluateResidencyConstraint(
  constraint: ResidencyConstraint,
  localities: readonly DataAtRestLocality[],
): ResidencyOutcome {
  const problems: string[] = [];
  const canonicalForm = canonicalResidencyJson(constraint, localities);

  if (constraint.tenantId.trim().length === 0) {
    problems.push("a residency constraint requires the declaring tenant's identity");
  }
  if (constraint.requiredRegions.length === 0) {
    problems.push(
      "a declared residency constraint must name at least one required region (an unconstrained tenant declares no constraint at all)",
    );
  }
  const seenRegions = new Set<string>();
  for (const region of constraint.requiredRegions) {
    if (!REGION_PATTERN.test(region)) {
      problems.push(`required region "${region}" is not a lowercase kebab-case region id`);
    }
    if (seenRegions.has(region)) {
      problems.push(`required region "${region}" is declared twice`);
    }
    seenRegions.add(region);
  }
  for (const locality of localities) {
    if (!(DATA_AT_REST_SURFACES as readonly string[]).includes(locality.surface)) {
      problems.push(`unknown data-at-rest surface "${locality.surface}"`);
    }
    if (!REGION_PATTERN.test(locality.region)) {
      problems.push(
        `the ${locality.surface} surface declares a malformed region "${locality.region}"`,
      );
    }
  }
  if (problems.length > 0) {
    return {
      outcome: "refused",
      refusal: { kind: "residency-invalid", problems },
      canonicalForm,
    };
  }

  if (localities.length === 0) {
    return {
      outcome: "refused",
      refusal: {
        kind: "residency-unsatisfied",
        problems: [
          "no data-at-rest locality was supplied for the environment — an unprovable locality fails closed when a residency constraint is declared",
        ],
      },
      canonicalForm,
    };
  }

  const unsatisfied = localities.filter(
    (locality) => !constraint.requiredRegions.includes(locality.region),
  );
  if (unsatisfied.length > 0) {
    return {
      outcome: "refused",
      refusal: {
        kind: "residency-unsatisfied",
        problems: unsatisfied.map(
          (locality) =>
            `the ${locality.surface} surface lives in region "${locality.region}" which is not among the tenant's required regions (${constraint.requiredRegions.join("|")}) — data-at-rest locality fails closed`,
        ),
      },
      canonicalForm,
    };
  }
  return {
    outcome: "satisfied",
    surfaces: localities,
    requiredRegions: [...constraint.requiredRegions],
    canonicalForm,
  };
}

/** True when the outcome is the fail-closed residency refusal (typed narrowing). */
export function isResidencyRefused(
  outcome: ResidencyOutcome,
): outcome is Extract<ResidencyOutcome, { readonly outcome: "refused" }> {
  return outcome.outcome === "refused";
}
