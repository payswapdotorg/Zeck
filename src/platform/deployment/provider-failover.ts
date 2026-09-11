/**
 * Typed provider failover selection (platform deployment plane; D-08 /
 * WORK-060; AVA-003).
 *
 * WHAT THIS IS: the typed, governed selection that resolves a durable
 * concern's declared ALTERNATE provider when the primary has failed —
 * through the EXISTING substrate seams: the manifest's provider map is
 * the declaration surface (providers.json `redundancy.alternate`, parsed
 * fail-closed by `manifest.ts`), and the concrete failover procedures
 * are the existing operator surfaces (the WORK-057 authority-failover
 * machinery, the D-07 artifact-exit substitution engine, the queue
 * replay convergence, the health/readiness gate for hosting). This
 * module is a VALIDATOR + typed projector with replayable provenance —
 * it is NOT an optimization authority (no cost/quality ranking, no
 * candidate search: the E1.1 Execution Compiler and the substrate
 * economics plane keep their exclusive roles untouched).
 *
 * WHAT IS REFUSED (the ambient-substitution boundary, mirroring the
 * substrate plane's `assertAdapterBinding` discipline — never a silent
 * weaker substitution):
 *  - a selection request naming a provider that is NOT the declared
 *    alternate of the concern: refused (`ambient-substitution`) —
 *    operator configuration drift cannot silently re-route a durable
 *    concern to an undeclared provider;
 *  - a concern without a declared alternate: refused
 *    (`no-alternate-declared`) — AVA-003 coverage is enforced at the
 *    manifest loader AND at selection time;
 *  - an observation that does not name the owning primary: refused
 *    (`not-primary-observation`) — a failover is a typed response to
 *    THE primary's failure, never to ambient noise;
 *  - `automatic` failover is unrepresentable at the manifest vocabulary
 *    (`governed-procedure` is the only mode): there is no ambient
 *    automatic path to select through at all.
 *
 * IDEMPOTENCY (IDENTITY-IDEMPOTENCY): the selection is content-addressed
 * over the canonical decision input (manifest digest, concern,
 * observation, window) — the same inputs produce the identical
 * `selectionId` and provenance record; re-running the selection for the
 * same revision window is a byte-identical no-op decision.
 *
 * PROVENANCE (EXECUTION-PROVENANCE): every selection carries the
 * profile (primary + alternate + failover procedure/measurement), the
 * failure observation and the deterministic decision digest — replayable
 * by re-evaluating the pure function over the same inputs.
 *
 * FREE-TIER DOCTRINE: the profile vocabulary carries no free-tier
 * exception — an alternate is an operator-declared, commercially
 * permitted resource (the providers.json commercialUse note documents
 * the doctrine where it applies); disposable free-tier resources are
 * never operationally critical.
 */

import { createHash } from "node:crypto";
import type { AlternateProviderDeclaration, DeploymentManifest } from "./manifest";
import { DURABLE_CONCERNS } from "./manifest";

/** A typed observation of a durable concern's primary failure. */
export interface PrimaryFailureObservation {
  readonly concern: string;
  readonly providerId: string;
  /** The observed failure class (typed vocabulary). */
  readonly failureKind: "unavailable" | "degraded";
  /** Bounded free-form evidence (already redacted by the observer). */
  readonly evidence: string;
}

/** The revision window a selection is idempotent over. */
export interface FailoverSelectionWindow {
  /** The exact Git revision the selection runs at. */
  readonly revision: string;
  /** The window identity (e.g. the drill run id or an operator label). */
  readonly windowId: string;
}

export interface FailoverProvenance {
  /** Content-addressed decision digest (deterministic, replayable). */
  readonly selectionId: string;
  readonly concern: string;
  readonly primaryId: string;
  readonly alternateId: string;
  readonly failoverMode: string;
  readonly procedure: string;
  readonly observation: PrimaryFailureObservation;
  readonly window: FailoverSelectionWindow;
  /** The canonical decision form the digest covers. */
  readonly canonicalForm: string;
}

export type ProviderFailoverSelection =
  | {
      readonly kind: "alternate";
      readonly concern: string;
      readonly providerId: string;
      readonly profile: AlternateProviderDeclaration;
      readonly provenance: FailoverProvenance;
    }
  | {
      readonly kind: "refused";
      readonly refusal:
        | {
            readonly kind: "no-alternate-declared";
            readonly concern: string;
            readonly message: string;
          }
        | {
            readonly kind: "ambient-substitution";
            readonly concern: string;
            readonly requestedProviderId: string | null;
            readonly declaredAlternateId: string | null;
            readonly message: string;
          }
        | {
            readonly kind: "not-primary-observation";
            readonly concern: string;
            readonly observedProviderId: string;
            readonly primaryId: string;
            readonly message: string;
          };
    };

const SELECTION_SCHEMA = "zeck-provider-failover-selection-v1";
const MAX_EVIDENCE = 300;

/**
 * The typed failover profiles of the manifest's durable concerns
 * (exactly one alternate each — the loader enforces coverage).
 */
export function providerFailoverProfiles(manifest: DeploymentManifest): readonly {
  readonly concern: string;
  readonly primaryId: string;
  readonly alternate: AlternateProviderDeclaration;
}[] {
  const profiles: {
    concern: string;
    primaryId: string;
    alternate: AlternateProviderDeclaration;
  }[] = [];
  for (const concern of DURABLE_CONCERNS) {
    const owner = manifest.providers.find((provider) => provider.concern === concern);
    if (owner === undefined || owner.redundancyAlternate === null) {
      continue;
    }
    profiles.push({
      concern,
      primaryId: owner.id,
      alternate: owner.redundancyAlternate,
    });
  }
  return profiles;
}

function canonicalSelectionJson(
  concern: string,
  primaryId: string,
  alternate: AlternateProviderDeclaration,
  observation: PrimaryFailureObservation,
  window: FailoverSelectionWindow,
): string {
  const form = {
    schema: SELECTION_SCHEMA,
    concern,
    primaryId,
    alternateId: alternate.id,
    failoverMode: alternate.failover.mode,
    procedure: alternate.failover.procedure,
    observation: {
      concern: observation.concern,
      providerId: observation.providerId,
      failureKind: observation.failureKind,
      evidence: observation.evidence.slice(0, MAX_EVIDENCE),
    },
    window: { revision: window.revision, windowId: window.windowId },
  };
  const keys = Object.keys(form).sort();
  const entries = keys.map((key) => {
    const value = form[key as keyof typeof form];
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  });
  return `{${entries.join(",")}}`;
}

/**
 * Select the failover target for a durable concern through its DECLARED
 * governed profile. PURE and deterministic.
 *
 * @param requestedProviderId the provider the caller intends to route
 * to (e.g. resolved from operator configuration). Only the declared
 * alternate is ever selectable — any other value (or an absent
 * declaration) is a typed refusal, so ambient substitution is
 * structurally rejected.
 */
export function selectFailoverProvider(
  manifest: DeploymentManifest,
  observation: PrimaryFailureObservation,
  window: FailoverSelectionWindow,
  requestedProviderId?: string,
): ProviderFailoverSelection {
  const owner = manifest.providers.find((provider) => provider.concern === observation.concern);
  if (owner === undefined) {
    return {
      kind: "refused",
      refusal: {
        kind: "no-alternate-declared",
        concern: observation.concern,
        message: `concern "${observation.concern}" has no owning provider in the manifest (no failover profile exists)`,
      },
    };
  }
  const alternate = owner.redundancyAlternate;
  if (alternate === null) {
    return {
      kind: "refused",
      refusal: {
        kind: "no-alternate-declared",
        concern: observation.concern,
        message: `concern "${observation.concern}" (provider "${owner.id}") declares no typed alternate — AVA-003 coverage is enforced at the manifest loader; this refusal is the runtime mirror`,
      },
    };
  }
  if (observation.providerId !== owner.id) {
    return {
      kind: "refused",
      refusal: {
        kind: "not-primary-observation",
        concern: observation.concern,
        observedProviderId: observation.providerId,
        primaryId: owner.id,
        message: `the failure observation names provider "${observation.providerId}" but the owning primary of "${observation.concern}" is "${owner.id}" — a failover responds to THE primary's failure`,
      },
    };
  }
  if (requestedProviderId !== undefined && requestedProviderId !== alternate.id) {
    return {
      kind: "refused",
      refusal: {
        kind: "ambient-substitution",
        concern: observation.concern,
        requestedProviderId,
        declaredAlternateId: alternate.id,
        message: `requested failover target "${requestedProviderId}" is not the declared alternate ("${alternate.id}") of concern "${observation.concern}" — ambient provider substitution is refused; failover is typed, governed and drilled`,
      },
    };
  }
  const canonicalForm = canonicalSelectionJson(
    observation.concern,
    owner.id,
    alternate,
    observation,
    window,
  );
  const selectionId = createHash("sha256").update(canonicalForm, "utf8").digest("hex");
  return {
    kind: "alternate",
    concern: observation.concern,
    providerId: alternate.id,
    profile: alternate,
    provenance: {
      selectionId,
      concern: observation.concern,
      primaryId: owner.id,
      alternateId: alternate.id,
      failoverMode: alternate.failover.mode,
      procedure: alternate.failover.procedure,
      observation,
      window,
      canonicalForm,
    },
  };
}
