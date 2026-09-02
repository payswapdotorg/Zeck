/**
 * In-process simulated media rail (deployments module adapter;
 * WORK-026, MOD-011/AC2 — the upstream-rail integration adapter).
 *
 * A MEDIA-GENERATION upstream rail simulated fully in process: it
 * implements the provider-neutral `MediaRail` seam exactly like a
 * real media-generation adapter would (opaque job references, the
 * CLOSED normalized observation vocabulary — the adapter performs
 * the provider-state normalization, deterministic progress
 * advancement, completion outputs with content digests, provider
 * failure injection, duplicate callback emission, idempotent
 * cancellation) and records every observable transport side effect
 * for the test suites' discrimination proofs (which dispatches
 * happened, in what order, with what frames).
 *
 * The simulated generation lifecycle the rail walks per dispatched
 * job (deterministic): `accepted` (the dispatch acknowledgment
 * itself) → `progressed` (progress 25) → `progressed` (progress 60)
 * → `provider-completed` (a deterministic output descriptor with a
 * content digest derived from the job's spec digest — the simulated
 * "generated media"). The mode is injectable: `failJobs` fails the
 * generation (`provider-failed`), `stallJobs` keeps the job at the
 * acceptance plateau (`accepted`), and `progression` overridable for
 * step-by-step tests.
 *
 * STABLE RAIL-LEVEL IDEMPOTENCY KEYS (the WORK-024 crash-safety
 * standard): `submitJob` (THE PAID DISPATCH) and `cancelJob` converge
 * on their `(application, idempotencyKey)` — the FIRST call under a
 * key performs the upstream side effect and is remembered; ANY later
 * call under the SAME key returns the ORIGINAL acknowledgment with
 * `replayed: true` and records NO second side effect (the `sends`
 * observable shows exactly one entry per logical key). This is the
 * in-memory twin of a real provider's server-side idempotency-key
 * semantics: the provider survives a Zeck process crash, so the key
 * ledger is deliberately kept on the rail (which models the external
 * world), not in the crashing process. A REFUSAL (failure injection)
 * is not a side effect and is never cached under the key — a retry
 * under the same key may succeed.
 *
 * PROVIDER-INTEGRATION HONESTY: this sandbox has NO external
 * media-provider credentials (no image/video/audio generation
 * vendor access) and no guaranteed egress, so no real provider call
 * is made or claimed. All rail behavior verified by this repository's
 * tests is the SIMULATED in-process rail behind the neutral seam;
 * REAL external media-provider behavior (network transport, vendor
 * job acceptance, polling/webhook semantics of a real rail,
 * provider-side idempotency-key behavior, credential materialization
 * inside a vendor adapter, actual generated media bytes) is
 * explicitly UNVERIFIED and documented as such in
 * docs/work-items/WORK-026.md. Replacing this adapter with a real
 * vendor adapter requires no change to any core contract (the seam
 * is the boundary; the closed observation vocabulary is precisely
 * where a vendor's raw states get normalized).
 */

import { createHash } from "node:crypto";
import type {
  MediaRail,
  MediaRailCancelOutcome,
  MediaRailCancelRequest,
  MediaRailDispatchOutcome,
  MediaRailDispatchRequest,
  MediaRailJobCallback,
  MediaRailPollOutcome,
} from "../ports/media-rail";
import type { MediaGenerationKind } from "../domain/media";

/** One recorded transport side effect (the test observable). */
export interface SimulatedMediaRailRecord {
  readonly kind: "dispatch" | "cancel";
  readonly applicationId: string;
  readonly jobId: string;
  /** The stable rail-level idempotency key that produced this effect. */
  readonly idempotencyKey: string;
  readonly providerJobRef: string | null;
  readonly generationKind: string | null;
  readonly specDigest: string | null;
  readonly cause: string | null;
  readonly at: string;
}

/** One key-converged replay (the idempotency observable). */
export interface SimulatedMediaRailReplayRecord {
  readonly kind: "dispatch" | "cancel";
  readonly idempotencyKey: string;
  readonly at: string;
}

/** The deterministic provider-state progression stages of the simulated rail. */
export type SimulatedMediaProgression = "accepted" | "quarter" | "majority" | "completed";

export interface InProcessMediaRailOptions {
  readonly now?: () => Date;
  /** When set, every dispatch fails with this reason (failure-injection tests). */
  readonly failDispatches?: string;
  /** When set, every job fails at generation time (provider-failure injection). */
  readonly failJobs?: string;
  /** When set, jobs stall at the acceptance plateau (never progress). */
  readonly stallJobs?: boolean;
  /** Deterministic provider job-reference allocator (defaults to an ordinal sequence). */
  readonly allocateJobRef?: () => string;
  /**
   * The deterministic content-digest generator for completed outputs
   * (defaults to sha256 over the rail's job coordinates + spec digest
   * — the simulated "generated media" identity; never real bytes).
   */
  readonly contentDigest?: (jobId: string, specDigest: string) => string;
}

interface RailJob {
  readonly providerJobRef: string;
  readonly generationKind: MediaGenerationKind;
  readonly specDigest: string;
  readonly dispatchedAt: string;
  /** The deterministic progression index (0 = accepted, 1 = quarter, 2 = majority, 3 = completed). */
  stage: number;
  cancelled: boolean;
}

const KIND_DIMENSIONS: Readonly<Record<string, { width: number; height: number }>> = {
  image: { width: 1024, height: 1024 },
  video: { width: 1280, height: 720 },
  audio: { width: 0, height: 0 },
  multimodal: { width: 1280, height: 1280 },
};

export function createInProcessMediaRail(
  generationKinds: readonly string[] = ["video", "image", "audio", "multimodal"],
  options: InProcessMediaRailOptions = {},
): MediaRail & {
  /** The recorded transport side effects, in order (the test observable). */
  readonly sends: readonly SimulatedMediaRailRecord[];
  /** The key-converged replays, in order (the idempotency observable). */
  readonly replays: readonly SimulatedMediaRailReplayRecord[];
  /** Fail the NEXT dispatch once (failure injection). */
  failNextDispatch(reason: string): void;
  /** How many DISTINCT jobs the rail accepted (per idempotency key). */
  readonly acceptedJobs: number;
  /** How many DISTINCT cancellations the rail performed (per key). */
  readonly cancellations: number;
} {
  const records: SimulatedMediaRailRecord[] = [];
  const replays: SimulatedMediaRailReplayRecord[] = [];
  const now = options.now ?? (() => new Date());
  let jobOrdinal = 0;
  let accepted = 0;
  let cancelledCount = 0;
  let failNext: string | null = null;
  const allocateJobRef =
    options.allocateJobRef ??
    (() => {
      jobOrdinal += 1;
      return `simmedia-job-${jobOrdinal}`;
    });
  const contentDigest =
    options.contentDigest ??
    ((jobId: string, specDigest: string) =>
      createHash("sha256").update(`simulated-media:${jobId}:${specDigest}`).digest("hex"));

  // The provider-side idempotency ledgers: key -> the original effect.
  const dispatchesByKey = new Map<
    string,
    {
      readonly jobId: string;
      readonly providerJobRef: string;
      readonly dispatchedAt: string;
      readonly rawStateLabel: string;
    }
  >();
  const cancelsByKey = new Map<string, { readonly cancelledAt: string }>();
  const jobsById = new Map<string, RailJob>();

  const failDispatch = (reason: string): MediaRailDispatchOutcome => {
    const injected = failNext;
    if (injected !== null) {
      failNext = null;
      return { dispatched: false, reason: injected };
    }
    return { dispatched: false, reason: options.failDispatches ?? reason };
  };

  /** Advance the deterministic progression of one rail job. */
  const advance = (job: RailJob): void => {
    if (options.stallJobs === true || job.cancelled) {
      return;
    }
    if (options.failJobs !== undefined && job.stage < 2) {
      job.stage = 3;
      return;
    }
    if (job.stage < 3) {
      job.stage += 1;
    }
  };

  /** The normalized poll outcome for a job at its current stage. */
  const pollOf = (job: RailJob): MediaRailPollOutcome => {
    const failed = options.failJobs !== undefined && job.stage >= 3;
    if (job.cancelled) {
      return {
        observation: "provider-cancelled",
        providerStateLabel: "simulated-cancelled",
        progress: null,
        outputDescriptor: null,
      };
    }
    if (failed) {
      return {
        observation: "provider-failed",
        providerStateLabel: "simulated-failed",
        progress: null,
        outputDescriptor: null,
      };
    }
    if (job.stage === 0) {
      return {
        observation: "accepted",
        providerStateLabel: "simulated-accepted",
        progress: 0,
        outputDescriptor: null,
      };
    }
    if (job.stage === 1) {
      return {
        observation: "progressed",
        providerStateLabel: "simulated-progressed-25",
        progress: 25,
        outputDescriptor: null,
      };
    }
    if (job.stage === 2) {
      return {
        observation: "progressed",
        providerStateLabel: "simulated-progressed-60",
        progress: 60,
        outputDescriptor: null,
      };
    }
    const digest = contentDigest(job.providerJobRef, job.specDigest);
    const dims = KIND_DIMENSIONS[job.generationKind] ?? { width: 0, height: 0 };
    return {
      observation: "provider-completed",
      providerStateLabel: "simulated-completed",
      progress: 100,
      outputDescriptor: {
        contentDigest: digest,
        generationKind: job.generationKind,
        ...(dims.width > 0 ? { width: dims.width, height: dims.height } : {}),
        durationMs: job.generationKind === "video" || job.generationKind === "audio" ? 5000 : null,
      },
    };
  };

  const rail: MediaRail = {
    descriptor: {
      railCapabilityId: "simulated-media-rail",
      generationKinds,
      transportClass: "media-generation",
      generationCostMicroUsd: {
        video: "1200000",
        image: "80000",
        audio: "60000",
        multimodal: "2400000",
      },
    },
    async submitJob(request: MediaRailDispatchRequest): Promise<MediaRailDispatchOutcome> {
      // Idempotent paid dispatch: the SAME stable key converges on the
      // SAME provider job coordinates (a crash between the rail
      // dispatch and the durable job update can never produce a
      // second upstream paid dispatch).
      const key = `${request.applicationId}:${request.idempotencyKey}`;
      const existing = dispatchesByKey.get(key);
      if (existing !== undefined) {
        replays.push({
          kind: "dispatch",
          idempotencyKey: request.idempotencyKey,
          at: now().toISOString(),
        });
        return {
          dispatched: true,
          dispatchedAt: existing.dispatchedAt,
          providerJobRef: existing.providerJobRef,
          providerStateLabel: existing.rawStateLabel,
          replayed: true,
          railMetadata: { simulated: true, generationKind: request.generationKind },
        };
      }
      if (!generationKinds.includes(request.generationKind)) {
        return failDispatch(
          `the rail does not serve generation kind ${request.generationKind}`,
        );
      }
      if (failNext !== null || options.failDispatches !== undefined) {
        return failDispatch(failNext ?? "fixture dispatch refusal");
      }
      const dispatchedAt = now().toISOString();
      const providerJobRef = allocateJobRef();
      dispatchesByKey.set(key, {
        jobId: request.jobId,
        providerJobRef,
        dispatchedAt,
        rawStateLabel: "simulated-accepted",
      });
      jobsById.set(`${request.applicationId}:${request.jobId}`, {
        providerJobRef,
        generationKind: request.generationKind,
        specDigest: request.specDigest,
        dispatchedAt,
        stage: 0,
        cancelled: false,
      });
      accepted += 1;
      records.push({
        kind: "dispatch",
        applicationId: request.applicationId,
        jobId: request.jobId,
        idempotencyKey: request.idempotencyKey,
        providerJobRef,
        generationKind: request.generationKind,
        specDigest: request.specDigest,
        cause: null,
        at: dispatchedAt,
      });
      return {
        dispatched: true,
        dispatchedAt,
        providerJobRef,
        providerStateLabel: "simulated-accepted",
        replayed: false,
        railMetadata: { simulated: true, generationKind: request.generationKind },
      };
    },
    async cancelJob(request: MediaRailCancelRequest): Promise<MediaRailCancelOutcome> {
      const key = `${request.applicationId}:${request.idempotencyKey}`;
      const existing = cancelsByKey.get(key);
      if (existing !== undefined) {
        replays.push({
          kind: "cancel",
          idempotencyKey: request.idempotencyKey,
          at: now().toISOString(),
        });
        return { cancelled: true, cancelledAt: existing.cancelledAt, replayed: true };
      }
      const job = jobsById.get(`${request.applicationId}:${request.jobId}`);
      if (job === undefined) {
        // The job never reached the rail (a submitted job cancelled
        // before dispatch): the cancellation trivially converges.
        const cancelledAt = now().toISOString();
        cancelsByKey.set(key, { cancelledAt });
        cancelledCount += 1;
        records.push({
          kind: "cancel",
          applicationId: request.applicationId,
          jobId: request.jobId,
          idempotencyKey: request.idempotencyKey,
          providerJobRef: request.providerJobRef,
          generationKind: null,
          specDigest: null,
          cause: request.cause,
          at: cancelledAt,
        });
        return { cancelled: true, cancelledAt, replayed: false };
      }
      if (job.stage >= 3 || job.cancelled) {
        // The rail already reached a terminal provider state: report
        // convergence-with-terminal (the fabric converges the job).
        const cancelledAt = now().toISOString();
        cancelsByKey.set(key, { cancelledAt });
        return {
          cancelled: true,
          cancelledAt,
          replayed: true,
          alreadyTerminal: true,
        };
      }
      job.cancelled = true;
      const cancelledAt = now().toISOString();
      cancelsByKey.set(key, { cancelledAt });
      cancelledCount += 1;
      records.push({
        kind: "cancel",
        applicationId: request.applicationId,
        jobId: request.jobId,
        idempotencyKey: request.idempotencyKey,
        providerJobRef: job.providerJobRef,
        generationKind: job.generationKind,
        specDigest: job.specDigest,
        cause: request.cause,
        at: cancelledAt,
      });
      return { cancelled: true, cancelledAt, replayed: false };
    },
    async pollJob(reference: {
      readonly applicationId: string;
      readonly jobId: string;
      readonly providerJobRef: string;
    }): Promise<MediaRailPollOutcome> {
      const job = jobsById.get(`${reference.applicationId}:${reference.jobId}`);
      if (job === undefined || job.providerJobRef !== reference.providerJobRef) {
        throw new Error(
          `the rail has no job ${reference.jobId} under reference ${reference.providerJobRef} (foreign or stale poll)`,
        );
      }
      advance(job);
      return pollOf(job);
    },
  };

  return {
    ...rail,
    get sends() {
      return records;
    },
    get replays() {
      return replays;
    },
    get acceptedJobs() {
      return accepted;
    },
    get cancellations() {
      return cancelledCount;
    },
    failNextDispatch(reason: string) {
      failNext = reason;
    },
  };
}

/**
 * Derive one rail callback frame from the rail's current job state —
 * the async-callback path test helper (a real rail would POST this
 * frame to the fabric's webhook; the simulated world hands it to
 * `applyCallback`). DUPLICATE callbacks (the same observation
 * re-delivered) and REORDERED callbacks are constructed by the
 * caller for the idempotency proofs.
 */
export function mediaRailCallbackFor(poll: MediaRailPollOutcome): {
  readonly observation: MediaRailJobCallback["observation"];
  readonly providerStateLabel: string;
  readonly progress: number | null;
  readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
} {
  return {
    observation: poll.observation,
    providerStateLabel: poll.providerStateLabel,
    progress: poll.progress,
    outputDescriptor: poll.outputDescriptor,
  };
}
