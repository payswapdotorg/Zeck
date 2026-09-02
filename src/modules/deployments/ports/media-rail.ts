/**
 * Media generation upstream rail port (deployments module outbound;
 * WORK-026, MOD-011 — the provider-neutral media-generation upstream
 * seam, THE replaceable infrastructure seam).
 *
 * A media rail adapter TRANSPORTS neutral generation-job frames
 * between the governed media fabric and an upstream
 * media-generation infrastructure (a video-generation rail, an
 * image-generation rail, an audio-generation rail — generation
 * KINDS, never vendors). The port's SHAPE keeps the core contracts
 * provider-neutral and non-authoritative:
 *
 *   - there is NO admission, authorization, budget, capability or
 *     execution-transition surface anywhere in the interface — no
 *     policy/budget/capability/execution handles cross this seam; the
 *     rail is handed only NEUTRAL coordinates (job identity refs,
 *     the normalized generation spec, bounded descriptors, artifact
 *     digests);
 *   - the rail is identified by a NEUTRAL rail capability id and the
 *     neutral generation kinds it serves — vendor identifiers NEVER
 *     cross this contract (a concrete vendor rail binds downstream
 *     in its own adapter, exactly like the model rails, the
 *     messaging rail and the realtime rail);
 *   - RAW provider job states NEVER cross this seam: `pollJob` and
 *     the callback frames return the CLOSED normalized observation
 *     vocabulary (domain/media.ts MEDIA_PROVIDER_OBSERVATIONS) plus a
 *     reference-only `providerStateLabel` — the ADAPTER performs the
 *     normalization (the work order's "normalize provider-specific
 *     job states into a CLOSED provider-neutral lifecycle");
 *   - raw media payloads never cross: outputs arrive as normalized
 *     BOUNDED descriptors carrying the content digest (an ARTIFACT
 *     reference — the bytes live in the canonical artifact plane);
 *   - provider-native job ids never become the primary public
 *     identity: the rail hands back an OPAQUE `providerJobRef`
 *     (reference-only evidence, correlated on every callback/poll);
 *   - credential materialization for a real rail happens INSIDE the
 *     adapter's own scope through the mediated connections vault —
 *     never through this port's shapes (references only).
 *
 * STABLE RAIL-LEVEL IDEMPOTENCY KEYS (the WORK-024 crash-safety
 * standard): `submitJob` is THE PAID DISPATCH side effect and
 * `cancelJob` the cancellation side effect — both carry an
 * `idempotencyKey` derived deterministically from the durable job
 * coordinates (domain/media.ts `mediaRailDispatchKey` /
 * `mediaRailCancelKey`). The key's contract: re-issuing the SAME call
 * under the SAME key MUST converge — the rail performs the upstream
 * side effect EXACTLY ONCE and returns the ORIGINAL acknowledgment
 * with `replayed: true` (a real provider implements this with its
 * idempotency-key semantics; the shipped simulated rail implements it
 * with its in-memory key ledger). A crash between the durable claim
 * and the durable completion of an operation is recovered by REPLAYING
 * the call under the same key — no duplicate upstream side effect,
 * ever (MOD-013's "cannot silently create uncontrolled paid
 * duplicates").
 *
 * The shipped in-process simulated rail (adapters/in-process-media-rail.ts)
 * implements this seam for tests and local composition; REAL external
 * media-provider behavior is explicitly UNVERIFIED in this
 * environment (no provider credentials, no guaranteed egress) and is
 * documented as such in docs/work-items/WORK-026.md.
 */

import type { MediaGenerationKind, MediaProviderObservation } from "../domain/media";

export interface MediaRailDescriptor {
  /** Provider-neutral rail identity (e.g. "simulated-media-rail"). */
  readonly railCapabilityId: string;
  /** The provider-neutral generation kinds this rail serves. */
  readonly generationKinds: readonly string[];
  /** The rail's declared transport class (media generation only). */
  readonly transportClass: "media-generation";
  /**
   * The rail's neutral per-kind cost estimate (micro-USD strings) —
   * the budget reservation amount comes from the RAIL's pricing
   * declaration (the adapter's knowledge, never a caller assertion).
   */
  readonly generationCostMicroUsd: Readonly<Record<string, string>>;
}

/** The neutral paid-dispatch request (THE external paid side effect). */
export interface MediaRailDispatchRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly generationKind: MediaGenerationKind;
  /**
   * The STABLE rail-level idempotency key for this paid dispatch
   * (derived from the durable job identity): a retry/recovery
   * re-dispatches under the same key and converges — exactly one
   * upstream paid dispatch, ever, per job (MOD-013's uncontrolled-
   * paid-duplicate prohibition is structural here).
   */
  readonly idempotencyKey: string;
  /** The deterministic normalized generation spec (preprocessing output). */
  readonly spec: Readonly<Record<string, unknown>>;
  /** The preprocessing digest (the rail records it with the job). */
  readonly specDigest: string;
  /** The source-input ARTIFACT digest when the job transforms one (never the bytes). */
  readonly inputArtifactDigest: string | null;
  /** The deployment plan's bounded session policy (duration/concurrency ceilings). */
  readonly sessionPolicy: {
    readonly maxSessionDurationMs: number;
    readonly maxConcurrentSessions: number;
  };
}

export type MediaRailDispatchOutcome =
  | {
      readonly dispatched: true;
      readonly dispatchedAt: string;
      /**
       * The rail's OPAQUE job reference — reference-only evidence
       * correlated on every poll/callback (never the primary
       * identity).
       */
      readonly providerJobRef: string;
      /**
       * The rail's RAW state label for its acceptance —
       * reference-only evidence (the normalized observation
       * vocabulary is `accepted` by definition of this outcome).
       */
      readonly providerStateLabel: string;
      /** True when the rail converged on the original dispatch (idempotent replay). */
      readonly replayed: boolean;
      readonly railMetadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly dispatched: false; readonly reason: string };

export interface MediaRailCancelRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly providerJobRef: string | null;
  /** The STABLE rail-level idempotency key for this cancellation. */
  readonly idempotencyKey: string;
  readonly cause: string | null;
}

export type MediaRailCancelOutcome =
  | {
      readonly cancelled: true;
      readonly cancelledAt: string;
      /** True when the rail converged on the original cancellation. */
      readonly replayed: boolean;
    }
  | {
      readonly cancelled: true;
      readonly cancelledAt: string;
      readonly replayed: boolean;
      readonly alreadyTerminal: true;
    }
  | { readonly cancelled: false; readonly reason: string };

export interface MediaRail {
  readonly descriptor: MediaRailDescriptor;
  /**
   * Submit the generation job upstream (THE PAID DISPATCH side
   * effect; idempotent by key — exactly one upstream dispatch per
   * job, ever). Called ONLY after the full admission chain (policy →
   * capability → budget reservation → secret mediation) — the fabric
   * enforces the ordering; the rail owns none of it.
   */
  submitJob(request: MediaRailDispatchRequest): Promise<MediaRailDispatchOutcome>;
  /**
   * Cancel the upstream job (the cancellation side effect; idempotent
   * by key; a rail that already reached a terminal provider state
   * reports `alreadyTerminal` — the fabric converges).
   */
  cancelJob(request: MediaRailCancelRequest): Promise<MediaRailCancelOutcome>;
  /**
   * POLL the upstream job state (a READ — never a side effect): the
   * adapter NORMALIZES the provider's raw state into the closed
   * observation vocabulary and returns the bounded output descriptor
   * when the provider reports completion.
   */
  pollJob(reference: {
    readonly applicationId: string;
    readonly jobId: string;
    readonly providerJobRef: string;
  }): Promise<MediaRailPollOutcome>;
}

/** The normalized poll outcome (a READ; the closed observation vocabulary). */
export interface MediaRailPollOutcome {
  readonly observation: MediaProviderObservation;
  /** The rail's RAW state label (reference-only evidence, never a status). */
  readonly providerStateLabel: string;
  readonly progress: number | null;
  /**
   * The rail's normalized output descriptor (bounded,
   * artifact-reference form — contentDigest + neutral metadata; the
   * bytes live in the artifact plane) when the provider reports
   * completion.
   */
  readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
}

/**
 * The neutral inbound callback frame a rail emits into the media
 * fabric (webhook/transport callback shapes — coordinates + the
 * NORMALIZED observation + bounded output descriptor + the upstream
 * callback id when the rail supplies one).
 */
export interface MediaRailJobCallback {
  readonly applicationId: string;
  readonly jobId: string;
  /** The rail's OPAQUE job reference (the correlation guard target). */
  readonly providerJobRef: string;
  /** Upstream-supplied callback idempotency id, when the rail provides one. */
  readonly callbackKey?: string;
  /** The NORMALIZED provider observation (the adapter normalized the vendor state). */
  readonly observation: MediaProviderObservation;
  /** The rail's RAW state label (reference-only evidence, never a status). */
  readonly providerStateLabel: string | null;
  readonly progress: number | null;
  readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
}
