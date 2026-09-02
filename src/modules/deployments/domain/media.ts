/**
 * Provider-neutral media-generation domain (deployments module domain;
 * WORK-026, MOD-011/MOD-012/MOD-013, ADR-0014 specialization).
 *
 * The provider-neutral MEDIA-GENERATION contract for asynchronous
 * video/image/audio/multimodal generation (the WORK-023 fabric's
 * `media-generation` modality — never a vendor). A MEDIA JOB is the
 * generation-side twin of a governed Execution: it is BOUND to
 * (tenant, application, deployment, PINNED deployment plan version,
 * execution identity) and every submission, paid dispatch, provider
 * observation (poll or callback), verification outcome, artifact
 * adoption, cancellation and retry is preserved as EXECUTION
 * provenance through the executions authority (the deployments
 * module's media ledger port → the executions public step-event
 * seam), never a second event authority.
 *
 * Provider neutrality is structural (MOD-011/ADR-0014 invariant):
 *   - the generation-kind vocabulary is neutral (video / image /
 *     audio / multimodal — KINDS, never vendors; the vocabulary
 *     matches the deployment profile's I/O modality atoms);
 *   - `providerJobRef` is the upstream rail's OPAQUE reference — the
 *     ADAPTER maps provider-native job ids onto it; provider ids are
 *     NEVER the primary public identity (the Zeck job identity is
 *     `jobId` + the caller idempotency/submission key);
 *   - RAW provider job states NEVER cross the rail seam: the ADAPTER
 *     normalizes them into the CLOSED observation vocabulary below
 *     (`accepted` / `progressed` / `provider-completed` /
 *     `provider-failed` / `provider-cancelled`); the job lifecycle
 *     (MEDIA_JOB_STATUSES) is CLOSED and owned by this domain — the
 *     provider is an OBSERVER of it, never a driver of vocabulary;
 *   - raw media payloads never cross: job rows and events carry
 *     ARTIFACT REFERENCES (content digests) and bounded descriptors
 *     only — generated media bytes live in the canonical artifact
 *     authority's plane, referenced by lineage (the work order's
 *     "artifact references for large media" requirement).
 *
 * THE CLOSED JOB LIFECYCLE (the work order's "normalize
 * provider-specific job states into a CLOSED provider-neutral
 * lifecycle"):
 *
 * ```text
 *   submitted ──→ dispatching ──→ generating ──→ verifying ──→ completed
 *       │              │              │             ╲──→ failed
 *       │              ╲──→ failed    ╲──→ failed
 *       ╲──→ cancelled ─────╲──→ cancelled
 * ```
 *
 * `submitted` = the durable job row exists (admitted submission, no
 * paid dispatch yet); `dispatching` = the budget reservation is made
 * and the paid dispatch is being issued; `generating` = the rail
 * accepted the job; `verifying` = the provider reports completion (an
 * OBSERVATION) and the verification boundary is in progress;
 * `completed` / `failed` / `cancelled` are TERMINAL (immutable).
 * Provider success is an OBSERVATION — completion requires the
 * deterministic postprocessing shape check and, when configured, the
 * verification authority's PASS verdict (verification-before-
 * completion, MOD-013/AC5).
 *
 * RETRY is idempotent RESUBMISSION: a retry creates a NEW job row
 * under its own submission key, referencing the failed job
 * (`retryOfJobId`) — one job = one execution identity = one paid
 * dispatch (each structurally unique); a repeated retry call under
 * the SAME key converges on the SAME retry job (no duplicate paid
 * dispatch — MOD-013's "cannot silently create uncontrolled paid
 * duplicates").
 */

// ---------------------------------------------------------------------------
// Neutral vocabularies (frozen).
// ---------------------------------------------------------------------------

/**
 * The provider-neutral generation kinds (the media-generation
 * modality's capability atoms; MOD-011 "video, image, audio and
 * related multimodal generation").
 */
export const MEDIA_GENERATION_KINDS = ["video", "image", "audio", "multimodal"] as const;
export type MediaGenerationKind = (typeof MEDIA_GENERATION_KINDS)[number];

export function isMediaGenerationKind(value: string): value is MediaGenerationKind {
  return (MEDIA_GENERATION_KINDS as readonly string[]).includes(value);
}

/**
 * The CLOSED provider-neutral job lifecycle (the work order's
 * implementation requirement). Provider states are NORMALIZED into
 * observations at the adapter — a raw provider state string is never
 * a job status.
 */
export const MEDIA_JOB_STATUSES = [
  "submitted",
  "dispatching",
  "generating",
  "verifying",
  "completed",
  "failed",
  "cancelled",
] as const;
export type MediaJobStatus = (typeof MEDIA_JOB_STATUSES)[number];

export function isMediaJobStatus(value: string): value is MediaJobStatus {
  return (MEDIA_JOB_STATUSES as readonly string[]).includes(value);
}

export const MEDIA_JOB_TRANSITIONS: Readonly<Record<MediaJobStatus, readonly MediaJobStatus[]>> = {
  submitted: ["dispatching", "cancelled"],
  dispatching: ["generating", "failed", "cancelled"],
  generating: ["verifying", "failed", "cancelled"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionMediaJob(from: MediaJobStatus, to: MediaJobStatus): boolean {
  return MEDIA_JOB_TRANSITIONS[from].includes(to);
}

/** Terminal job statuses (physically immutable after the move). */
export function isTerminalMediaJobStatus(status: MediaJobStatus): boolean {
  return MEDIA_JOB_TRANSITIONS[status].length === 0;
}

/**
 * The CLOSED normalized provider-observation vocabulary — the ONLY
 * provider-state vocabulary that crosses the rail seam (the adapter
 * normalizes vendor states onto it; raw provider strings are
 * reference-only `providerStateLabel` evidence, never status).
 */
export const MEDIA_PROVIDER_OBSERVATIONS = [
  "accepted",
  "progressed",
  "provider-completed",
  "provider-failed",
  "provider-cancelled",
] as const;
export type MediaProviderObservation = (typeof MEDIA_PROVIDER_OBSERVATIONS)[number];

export function isMediaProviderObservation(value: string): value is MediaProviderObservation {
  return (MEDIA_PROVIDER_OBSERVATIONS as readonly string[]).includes(value);
}

/** Whether an observation moves the job toward the verification boundary. */
export function isCompletionObservation(value: MediaProviderObservation): boolean {
  return value === "provider-completed";
}

/** The verification-before-completion policy declared per job (MOD-013/AC5). */
export const MEDIA_VERIFICATION_MODES = ["none", "required"] as const;
export type MediaVerificationMode = (typeof MEDIA_VERIFICATION_MODES)[number];

export function isMediaVerificationMode(value: string): value is MediaVerificationMode {
  return (MEDIA_VERIFICATION_MODES as readonly string[]).includes(value);
}

/** How an observation arrived (evidence only). */
export const MEDIA_OBSERVATION_SOURCES = ["poll", "callback"] as const;
export type MediaObservationSource = (typeof MEDIA_OBSERVATION_SOURCES)[number];

export function isMediaObservationSource(value: string): value is MediaObservationSource {
  return (MEDIA_OBSERVATION_SOURCES as readonly string[]).includes(value);
}

/** The artifact-adoption roles (MOD-012 lineage). */
export const MEDIA_ARTIFACT_ROLES = ["generated-output", "derived-variant"] as const;
export type MediaArtifactRole = (typeof MEDIA_ARTIFACT_ROLES)[number];

export function isMediaArtifactRole(value: string): value is MediaArtifactRole {
  return (MEDIA_ARTIFACT_ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Records.
// ---------------------------------------------------------------------------

/** The immutable job record (the media generation job — one job, one execution, one paid dispatch). */
export interface MediaJobRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  /** The PINNED deployment plan version (immutable for the job lifetime). */
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  /** The governed Execution this job maps to (reference only). */
  readonly executionId: string;
  /** The neutral generation kind (video/image/audio/multimodal). */
  readonly generationKind: MediaGenerationKind;
  readonly status: MediaJobStatus;
  /**
   * The caller's STABLE submission idempotency key (UNIQUE per
   * application — the dedupe key for repeated submissions; the same
   * key with a different body fails closed by fingerprint).
   */
  readonly submissionKey: string;
  /** The creation-fingerprint arbitration discriminator (idempotent replay vs key reuse). */
  readonly creationFingerprint: string;
  /**
   * The upstream rail's OPAQUE job reference (evidence only — never
   * the primary identity; correlated on every callback/poll).
   */
  readonly providerJobRef: string | null;
  /** The rail's last RAW state label, recorded as reference-only evidence (never a status). */
  readonly providerStateLabel: string | null;
  /** The declared verification-before-completion policy. */
  readonly verificationMode: MediaVerificationMode;
  /** The declared verification criteria refs (required mode only; bounded). */
  readonly verificationCriteria: readonly MediaCriteriaRef[];
  /** The budget reservation for the paid dispatch (evidence; the budgets authority is authoritative). */
  readonly reservationId: string | null;
  /** The deterministic preprocessing digest (the normalized input spec). */
  readonly preprocessingDigest: string | null;
  /** The deterministic postprocessing digest (the normalized output descriptor). */
  readonly postprocessingDigest: string | null;
  /**
   * The generated output ARTIFACT digest (content-addressed reference;
   * large media never embeds in job rows or EventEnvelope payloads).
   */
  readonly outputArtifactDigest: string | null;
  /** The source-input artifact digest the job transforms (lineage root; null = prompt-only). */
  readonly inputArtifactDigest: string | null;
  /** The job this retry resubmits (null = an original submission). */
  readonly retryOfJobId: string | null;
  /** The terminal outcome cause (bounded; null while non-terminal). */
  readonly failureCause: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/** One declared verification criteria reference (the verification authority's declaration identity). */
export interface MediaCriteriaRef {
  readonly criterionId: string;
  readonly version: number;
}

/** The append-only provider-observation evidence record (poll/callback — never a second event authority). */
export interface MediaObservationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly deploymentId: string;
  /** The observation's stable dedupe key (UNIQUE per job). */
  readonly observationKey: string;
  readonly source: MediaObservationSource;
  /** The normalized closed-vocabulary observation. */
  readonly observation: MediaProviderObservation;
  /** The rail's OPAQUE job reference at observation time (correlation evidence). */
  readonly providerJobRef: string | null;
  /** The rail's RAW state label (reference-only evidence, never a status). */
  readonly providerStateLabel: string | null;
  /** Normalized progress fraction 0..100 when reported. */
  readonly progress: number | null;
  /** The rail's normalized output descriptor (bounded, artifact-reference form). */
  readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
  readonly executionId: string | null;
  /** Provenance linkage: the executions envelope sequence, when the row has one. */
  readonly ledgerSequence: number | null;
  readonly actorId: string;
  readonly createdAt: string;
}

/** The immutable artifact-adoption record (MOD-012 lineage + deployment version linkage). */
export interface MediaArtifactRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly executionId: string;
  readonly role: MediaArtifactRole;
  /** The adoption's stable key (UNIQUE per application). */
  readonly artifactKey: string;
  /** The content-addressed artifact digest (the canonical artifact authority's identity). */
  readonly artifactDigest: string;
  /** The lineage parent digests (source input → output → derived variants). */
  readonly parentDigests: readonly string[];
  /** The normalized descriptor digest the artifact payload covers. */
  readonly descriptorDigest: string;
  /** The executions envelope sequence of the adoption evidence. */
  readonly ledgerSequence: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Inputs (validated fail-closed).
// ---------------------------------------------------------------------------

/** Input of `submitJob` (validated fail-closed). */
export interface SubmitMediaJobInput {
  readonly deploymentId: string;
  /** The neutral generation kind. */
  readonly generationKind: MediaGenerationKind;
  /**
   * The bounded generation prompt/spec (human intent — never a
   * secret; secret-shaped content is rejected at validation).
   */
  readonly prompt: string;
  /** The source-input ARTIFACT digest the job transforms (optional; lineage root). */
  readonly inputArtifactDigest?: string;
  /** Neutral generation parameters (bounded, canonicalizable; never credentials). */
  readonly parameters?: Readonly<Record<string, unknown>>;
  /**
   * The declared verification-before-completion policy: absent = mode
   * `none` (deterministic postprocessing shape check only); supplied
   * = mode `required` (the verification authority's PASS verdict
   * additionally controls completion).
   */
  readonly verification?: {
    readonly criteria: readonly MediaCriteriaRef[];
  };
}

/** Input of `deriveVariant` (validated fail-closed — MOD-012 derived variants). */
export interface DeriveMediaVariantInput {
  readonly jobId: string;
  /**
   * The bounded variant transform descriptor (deterministic
   * postprocessing of the source artifact — e.g. a resize/remix/
   * transcode intent, expressed as neutral parameters).
   */
  readonly variant: Readonly<Record<string, unknown>>;
}

/** One provider callback frame applied to a job (validated fail-closed). */
export interface MediaCallbackInput {
  readonly jobId: string;
  /** The rail's OPAQUE job reference (the correlation guard). */
  readonly providerJobRef: string;
  /** Upstream-supplied callback idempotency id, when the rail provides one. */
  readonly callbackKey?: string;
  /** The NORMALIZED provider observation (the adapter normalized the vendor state). */
  readonly observation: MediaProviderObservation;
  /** The rail's RAW state label (reference-only evidence). */
  readonly providerStateLabel?: string;
  readonly progress?: number;
  /** The rail's normalized output descriptor (bounded, artifact-reference form). */
  readonly outputDescriptor?: Readonly<Record<string, unknown>>;
}

export type MediaValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REF_PATTERN = /^[\x21-\x7e]{1,200}$/;
const PROMPT_MAX = 4000;
const KEY_MAX = 200;
const PARAMETERS_MAX = 2048;
const MAX_CRITERIA = 8;

/** Raw-secret VALUE patterns (the WORK-011 nine-pattern discipline). */
const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Whether a free-text value looks like a raw long-lived secret. */
export function mediaContainsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed validation of the job-submission input. */
export function validateSubmitMediaJobInput(input: unknown): MediaValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "media job input must be an object" };
  }
  const j = input as unknown as SubmitMediaJobInput;
  if (typeof j.deploymentId !== "string" || !UUID_PATTERN.test(j.deploymentId)) {
    return {
      valid: false,
      reason: "deploymentId must be a UUID (the deployment fabric identity)",
    };
  }
  if (typeof j.generationKind !== "string" || !isMediaGenerationKind(j.generationKind)) {
    return {
      valid: false,
      reason: `generationKind must be one of ${MEDIA_GENERATION_KINDS.join("|")} (provider-neutral)`,
    };
  }
  if (typeof j.prompt !== "string" || j.prompt.length < 1 || j.prompt.length > PROMPT_MAX) {
    return { valid: false, reason: `prompt must be 1..${PROMPT_MAX} characters` };
  }
  if (mediaContainsRawSecretValue(j.prompt)) {
    return { valid: false, reason: "prompt looks like it embeds a raw secret value" };
  }
  if (
    j.inputArtifactDigest !== undefined &&
    (typeof j.inputArtifactDigest !== "string" || !DIGEST_PATTERN.test(j.inputArtifactDigest))
  ) {
    return {
      valid: false,
      reason: "inputArtifactDigest must be a 64-hex content digest (an artifact reference)",
    };
  }
  if (j.parameters !== undefined) {
    if (!isRecord(j.parameters)) {
      return { valid: false, reason: "parameters must be an object" };
    }
    try {
      if (JSON.stringify(j.parameters).length > PARAMETERS_MAX) {
        return {
          valid: false,
          reason: `parameters must serialize to at most ${PARAMETERS_MAX} bytes`,
        };
      }
    } catch {
      return { valid: false, reason: "parameters must be serializable" };
    }
    for (const value of Object.values(j.parameters)) {
      if (typeof value === "string" && mediaContainsRawSecretValue(value)) {
        return { valid: false, reason: "parameters look like they embed a raw secret value" };
      }
    }
  }
  if (j.verification !== undefined) {
    if (!isRecord(j.verification)) {
      return { valid: false, reason: "verification must be an object when present" };
    }
    const criteria = j.verification.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0 || criteria.length > MAX_CRITERIA) {
      return {
        valid: false,
        reason: `verification.criteria must be 1..${MAX_CRITERIA} declared criteria references`,
      };
    }
    for (const ref of criteria) {
      if (
        !isRecord(ref) ||
        typeof ref.criterionId !== "string" ||
        ref.criterionId.length < 1 ||
        ref.criterionId.length > 128 ||
        typeof ref.version !== "number" ||
        !Number.isInteger(ref.version) ||
        ref.version < 1
      ) {
        return {
          valid: false,
          reason: "each verification criterion needs a criterionId and a positive integer version",
        };
      }
    }
  }
  return { valid: true };
}

/** Fail-closed validation of the variant-derivation input. */
export function validateDeriveMediaVariantInput(input: unknown): MediaValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "media variant input must be an object" };
  }
  const v = input as unknown as DeriveMediaVariantInput;
  if (typeof v.jobId !== "string" || !UUID_PATTERN.test(v.jobId)) {
    return { valid: false, reason: "jobId must be a UUID" };
  }
  if (!isRecord(v.variant)) {
    return { valid: false, reason: "variant must be an object (the neutral transform descriptor)" };
  }
  try {
    if (JSON.stringify(v.variant).length > PARAMETERS_MAX) {
      return { valid: false, reason: `variant must serialize to at most ${PARAMETERS_MAX} bytes` };
    }
  } catch {
    return { valid: false, reason: "variant must be serializable" };
  }
  for (const value of Object.values(v.variant)) {
    if (typeof value === "string" && mediaContainsRawSecretValue(value)) {
      return { valid: false, reason: "variant looks like it embeds a raw secret value" };
    }
  }
  return { valid: true };
}

/** Fail-closed validation of one provider callback frame. */
export function validateMediaCallbackInput(input: unknown): MediaValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "media callback must be an object" };
  }
  const c = input as unknown as MediaCallbackInput;
  if (typeof c.jobId !== "string" || !UUID_PATTERN.test(c.jobId)) {
    return { valid: false, reason: "jobId must be a UUID" };
  }
  if (typeof c.providerJobRef !== "string" || !REF_PATTERN.test(c.providerJobRef)) {
    return {
      valid: false,
      reason: "providerJobRef must be the rail's printable opaque reference (1..200 chars)",
    };
  }
  if (
    c.callbackKey !== undefined &&
    (typeof c.callbackKey !== "string" ||
      c.callbackKey.length < 1 ||
      c.callbackKey.length > KEY_MAX)
  ) {
    return {
      valid: false,
      reason: "callbackKey must be 1..200 characters when supplied by the rail",
    };
  }
  if (typeof c.observation !== "string" || !isMediaProviderObservation(c.observation)) {
    return {
      valid: false,
      reason: `observation must be one of ${MEDIA_PROVIDER_OBSERVATIONS.join("|")} (the closed normalized vocabulary)`,
    };
  }
  if (
    c.providerStateLabel !== undefined &&
    (typeof c.providerStateLabel !== "string" || c.providerStateLabel.length > 200)
  ) {
    return { valid: false, reason: "providerStateLabel must be at most 200 characters" };
  }
  if (
    c.progress !== undefined &&
    (!Number.isFinite(c.progress) || c.progress < 0 || c.progress > 100)
  ) {
    return { valid: false, reason: "progress must be a fraction 0..100 when reported" };
  }
  if (c.outputDescriptor !== undefined) {
    if (!isRecord(c.outputDescriptor)) {
      return { valid: false, reason: "outputDescriptor must be an object when present" };
    }
    try {
      if (JSON.stringify(c.outputDescriptor).length > PARAMETERS_MAX) {
        return {
          valid: false,
          reason: `outputDescriptor must serialize to at most ${PARAMETERS_MAX} bytes`,
        };
      }
    } catch {
      return { valid: false, reason: "outputDescriptor must be serializable" };
    }
  }
  for (const [field, value] of [
    ["providerStateLabel", c.providerStateLabel],
    ["callbackKey", c.callbackKey],
  ] as const) {
    if (value !== undefined && typeof value === "string" && mediaContainsRawSecretValue(value)) {
      return { valid: false, reason: `${field} looks like it embeds a raw secret value` };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Deterministic preprocessing / postprocessing (the work order's
// "deterministic preprocessing/postprocessing" — pure functions; the
// postprocessing shape check can REJECT an invalid output before
// completion, AC5).
// ---------------------------------------------------------------------------

/**
 * Deterministic PREPROCESSING: the normalized generation spec (the
 * canonical, order-stable serialization of the job's declared intent
 * — the digest base for `preprocessingDigest`; the rail dispatch
 * carries exactly this normalized form).
 */
export function preprocessMediaJobSpec(input: {
  readonly generationKind: MediaGenerationKind;
  readonly prompt: string;
  readonly inputArtifactDigest: string | null;
  readonly parameters: Readonly<Record<string, unknown>> | null;
}): Readonly<Record<string, unknown>> {
  const parameters = input.parameters ?? {};
  const sortedParameters: Record<string, unknown> = {};
  for (const key of Object.keys(parameters).sort()) {
    sortedParameters[key] = parameters[key];
  }
  return {
    generationKind: input.generationKind,
    prompt: input.prompt,
    inputArtifactDigest: input.inputArtifactDigest,
    parameters: sortedParameters,
  };
}

/**
 * Deterministic POSTPROCESSING: the normalized output descriptor (the
 * canonical form the generated artifact covers). FAIL-CLOSED shape
 * check: a provider output without a content digest, with a mismatched
 * generation kind, or with an oversized/malformed descriptor is
 * REJECTED here — before any adoption, verification or completion
 * (the "verification that can reject an invalid output before
 * completion" boundary, AC5, deterministic half).
 */
export function postprocessMediaOutput(input: {
  readonly generationKind: MediaGenerationKind;
  readonly providerOutput: Readonly<Record<string, unknown>>;
}): { readonly descriptor: Readonly<Record<string, unknown>> } {
  const raw = input.providerOutput;
  const contentDigest = raw.contentDigest;
  if (typeof contentDigest !== "string" || !DIGEST_PATTERN.test(contentDigest)) {
    throw new Error(
      "media provider output rejected: contentDigest must be a 64-hex content digest (the deterministic postprocessing shape check)",
    );
  }
  const outputKind = raw.generationKind;
  if (outputKind !== input.generationKind) {
    throw new Error(
      `media provider output rejected: generation kind mismatch (expected ${input.generationKind}, observed ${String(outputKind)})`,
    );
  }
  const descriptor: Record<string, unknown> = {
    contentDigest,
    generationKind: input.generationKind,
  };
  for (const key of Object.keys(raw).sort()) {
    if (key === "contentDigest" || key === "generationKind") {
      continue;
    }
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      descriptor[key] = value;
    }
    // Structured values stay verbatim (bounded by the rail contract).
    else {
      descriptor[key] = value;
    }
  }
  try {
    if (JSON.stringify(descriptor).length > PARAMETERS_MAX) {
      throw new Error(
        "media provider output rejected: normalized descriptor exceeds the bounded size",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("media provider output rejected")) {
      throw error;
    }
    throw new Error("media provider output rejected: descriptor is not serializable");
  }
  return { descriptor };
}

// ---------------------------------------------------------------------------
// Stable idempotency keys (the WORK-024 crash-safety standard).
// ---------------------------------------------------------------------------

/**
 * The STABLE job-submission deterministic key when the caller does
 * not supply one — the job's logical coordinates. (The canonical
 * path is the caller-supplied key; this substitute exists for
 * composition symmetry with the messaging fabric.)
 */
export function deterministicMediaSubmissionKey(input: {
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly generationKind: MediaGenerationKind;
  readonly preprocessingDigest: string;
}): string {
  return `media-${input.deploymentId}-${input.generationKind}-${input.preprocessingDigest.slice(0, 32)}`;
}

/**
 * The DETERMINISTIC SUBSTITUTE observation key for observations the
 * rail does not id: the job coordinates + the normalized observation
 * (+ progress when reported — identical polls converge, new progress
 * is new evidence).
 */
export function deterministicMediaObservationKey(input: {
  readonly jobId: string;
  readonly observation: MediaProviderObservation;
  readonly progress: number | null;
}): string {
  const progress = input.progress === null ? "" : `-${Math.round(input.progress)}`;
  return `obs-${input.jobId}-${input.observation}${progress}`;
}

/**
 * Deterministic job-creation fingerprint (the idempotency
 * discriminator): the same logical submission under the same key
 * replays; a different submission under a reused key fails
 * `IDEMPOTENCY_KEY_REUSED`.
 */
export function mediaJobCreationFingerprint(
  applicationId: string,
  input: SubmitMediaJobInput,
  executionId: string,
): string {
  return JSON.stringify([
    "deployments.media.job",
    applicationId,
    input.deploymentId,
    input.generationKind,
    input.prompt,
    input.inputArtifactDigest ?? null,
    input.parameters ?? null,
    input.verification === undefined ? null : { criteria: input.verification.criteria },
    executionId,
  ]);
}

/** Bounded observation-body digest base (the dedupe discriminator). */
export function mediaObservationBodyDigestBase(input: {
  readonly jobId: string;
  readonly observationKey: string;
  readonly observation: MediaProviderObservation;
  readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
}): string {
  return JSON.stringify([
    "deployments.media.observation",
    input.jobId,
    input.observationKey,
    input.observation,
    input.outputDescriptor,
  ]);
}

// ---------------------------------------------------------------------------
// DURABLE, RECOVERABLE OPERATION STATE (the WORK-024 crash-safety
// standard, applied to media generation — the architect's review
// bar): every governed media operation that can perform an external
// side effect (job submission, paid dispatch, observation
// application, job completion, job cancellation, variant adoption)
// owns ONE durable operation row with a PENDING → COMPLETED|FAILED
// machine plus STABLE rail-level idempotency keys derived below. A
// crash between the durable claim and the durable completion leaves
// the row PENDING; a retry RESUMES it (the rail converges by key —
// exactly one upstream side effect) and then completes it. A
// COMPLETED row replays its recorded outcome with no side effect; a
// FAILED row replays its recorded failure.
// ---------------------------------------------------------------------------

/** The governed operations that own durable recoverable state. */
export const MEDIA_OPERATION_KINDS = [
  "job-submission",
  "paid-dispatch",
  "observation-apply",
  "job-completion",
  "job-cancellation",
  "variant-adoption",
] as const;
export type MediaOperationKind = (typeof MEDIA_OPERATION_KINDS)[number];

export function isMediaOperationKind(value: string): value is MediaOperationKind {
  return (MEDIA_OPERATION_KINDS as readonly string[]).includes(value);
}

/** The recoverable status machine (pending → completed|failed; terminal-immutable). */
export const MEDIA_OPERATION_STATUSES = ["pending", "completed", "failed"] as const;
export type MediaOperationStatus = (typeof MEDIA_OPERATION_STATUSES)[number];

export function isMediaOperationStatus(value: string): value is MediaOperationStatus {
  return (MEDIA_OPERATION_STATUSES as readonly string[]).includes(value);
}

/**
 * The bounded durable stage checkpoint. A checkpoint's meaning: the
 * operation has passed its POINT OF NO RETURN — resumption must NOT
 * re-run admission (the decision preceded the side effect) and must
 * complete the durable tail from these facts:
 *
 *  - `job-recorded` (job-submission): the durable job row exists
 *    with these coordinates — the provenance tail completes from here
 *    (no second admission walk, no second execution open);
 *  - `dispatched` (paid-dispatch): the rail accepted the paid
 *    dispatch under the STABLE key — the durable tail (generating
 *    move, settle, provenance) completes from here WITHOUT a second
 *    paid dispatch and WITHOUT re-running budget admission (the
 *    reservation converged by operation id);
 *  - `artifact-adopted` (job-completion): the generated output was
 *    adopted as a lineage artifact with this digest — the
 *    verification + terminal tail completes from here (the adoption
 *    is content-addressed and converges anyway — the checkpoint
 *    makes the resume explicit and proven);
 *  - `rail-issued` (job-cancellation): the rail cancel was issued —
 *    the durable terminal tail completes from here;
 *  - `variant-adopted` (variant-adoption): the derived variant was
 *    adopted — the provenance tail completes from here.
 */
export interface MediaOperationCheckpoint {
  readonly stage:
    | "job-recorded"
    | "dispatched"
    | "artifact-adopted"
    | "rail-issued"
    | "variant-adopted";
  readonly jobId?: string;
  readonly executionId?: string;
  readonly deploymentId?: string;
  readonly pinnedPlanId?: string;
  readonly pinnedPlanVersion?: number;
  readonly generationKind?: MediaGenerationKind;
  readonly providerJobRef?: string | null;
  readonly providerStateLabel?: string | null;
  readonly reservationId?: string | null;
  readonly verificationMode?: MediaVerificationMode;
  readonly outputArtifactDigest?: string | null;
  readonly artifactKey?: string | null;
  readonly parentDigests?: readonly string[];
  readonly policySetId?: string | null;
}

/** The immutable-view durable operation record (status moves only pending → terminal). */
export interface MediaOperationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Provenance reference (NO FK — a job-submission row precedes its job row). */
  readonly jobId: string | null;
  readonly deploymentId: string;
  readonly executionId: string | null;
  readonly operationKind: MediaOperationKind;
  /** The stable operation key (UNIQUE per application — the recovery discriminator). */
  readonly operationKey: string;
  readonly status: MediaOperationStatus;
  /** How many invocations claimed/resumed this operation (the retry ledger). */
  readonly attempts: number;
  readonly checkpoint: MediaOperationCheckpoint | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/**
 * The stable DURABLE OPERATION key (the recovery discriminator — the
 * retry looks the operation up by exactly this key): the operation
 * kind plus the operation's logical discriminator (the caller
 * submission key for job-submission; the JOB ID for the per-job
 * operations paid-dispatch/job-completion/job-cancellation — one
 * job = one paid dispatch, structurally; the JOB-SCOPED observation
 * key for observation application; the caller key + job for variant
 * adoption).
 */
export function mediaOperationKey(kind: MediaOperationKind, discriminator: string): string {
  return `mediaop:${kind}:${discriminator}`;
}

/**
 * The STABLE RAIL-LEVEL IDEMPOTENCY KEYS (the WORK-024 crash-safety
 * standard): every call that can perform an upstream side effect
 * (`submitJob` = the PAID dispatch, `cancelJob`) carries one, derived
 * deterministically from the SAME durable job coordinates across
 * retries — a retry (or a crash-resume) re-issues the call under the
 * SAME key and the rail converges (exactly one upstream paid
 * dispatch, ever — per job).
 */
export function mediaRailDispatchKey(jobId: string): string {
  return `mediarail:dispatch:${jobId}`;
}

export function mediaRailCancelKey(jobId: string): string {
  return `mediarail:cancel:${jobId}`;
}

/**
 * The stable BUDGET operation id for the paid dispatch (the budgets
 * authority's idempotency discriminator — a retried or concurrent
 * duplicate reservation converges on the SAME reservation; budget
 * admission BEFORE the paid dispatch, MOD-013's core).
 */
export function mediaBudgetOperationId(jobId: string): string {
  return `media-reserve:${jobId}`;
}

/**
 * The stable VERIFICATION evaluation key for the completion boundary
 * (the verification authority's idempotency discriminator — a
 * crash-resume re-evaluates under the SAME key and converges on the
 * recorded conclusion).
 */
export function mediaVerificationKey(jobId: string): string {
  return `media-verify:${jobId}`;
}

/**
 * The stable ARTIFACT adoption key for the generated output (one
 * adoption record per job — the content-addressed digest converges
 * anyway; the key makes the adoption ledger explicit).
 */
export function mediaOutputArtifactKey(jobId: string): string {
  return `out:${jobId}`;
}

/** The stable artifact adoption key for a derived variant (caller-key scoped). */
export function mediaVariantArtifactKey(idempotencyKey: string): string {
  return `variant:${idempotencyKey}`;
}

/**
 * The stable EXECUTION-ledger evidence key base for media provenance
 * (the executions idempotency discriminators, replay-stable across
 * original runs and crash-resumes).
 */
export function mediaEvidenceKey(jobId: string, evidenceClass: string): string {
  return `media:${jobId}:${evidenceClass}`;
}
