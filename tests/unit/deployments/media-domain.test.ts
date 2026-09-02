/**
 * Unit tests — the provider-neutral media-generation domain (WORK-026,
 * MOD-011/MOD-012/MOD-013; the closed lifecycle, the normalized
 * observation vocabulary, fail-closed validation, deterministic
 * preprocessing/postprocessing and the stable idempotency-key scheme).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { SubmitMediaJobInput } from "../../../src/modules/deployments/public";
import {
  canTransitionMediaJob,
  deterministicMediaObservationKey,
  deterministicMediaSubmissionKey,
  isCompletionObservation,
  isMediaGenerationKind,
  isMediaJobStatus,
  isMediaOperationKind,
  isMediaOperationStatus,
  isMediaProviderObservation,
  isMediaVerificationMode,
  isTerminalMediaJobStatus,
  MEDIA_ARTIFACT_ROLES,
  MEDIA_GENERATION_KINDS,
  MEDIA_JOB_STATUSES,
  MEDIA_JOB_TRANSITIONS,
  MEDIA_OBSERVATION_SOURCES,
  MEDIA_OPERATION_KINDS,
  MEDIA_OPERATION_STATUSES,
  MEDIA_PROVIDER_OBSERVATIONS,
  MEDIA_VERIFICATION_MODES,
  mediaBudgetOperationId,
  mediaContainsRawSecretValue,
  mediaEvidenceKey,
  mediaJobCreationFingerprint,
  mediaObservationBodyDigestBase,
  mediaOperationKey,
  mediaOutputArtifactKey,
  mediaRailCancelKey,
  mediaRailDispatchKey,
  mediaVariantArtifactKey,
  mediaVerificationKey,
  postprocessMediaOutput,
  preprocessMediaJobSpec,
  validateDeriveMediaVariantInput,
  validateMediaCallbackInput,
  validateSubmitMediaJobInput,
} from "../../../src/modules/deployments/public";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");
const UUID = "00000000-0000-7000-8000-0000000000aa";
const DEPLOYMENT = "00000000-0000-7000-8000-0000000000ab";
const EXECUTION = "00000000-0000-7000-8000-0000000000ac";

describe("media domain: the closed provider-neutral vocabularies", () => {
  test("the generation kinds cover video/image/audio/multimodal and nothing vendor-shaped", () => {
    expect([...MEDIA_GENERATION_KINDS]).toEqual(["video", "image", "audio", "multimodal"]);
    expect(isMediaGenerationKind("video")).toBe(true);
    expect(isMediaGenerationKind("dall-e")).toBe(false);
    expect(isMediaGenerationKind("runway-gen3")).toBe(false);
  });

  test("the job lifecycle is CLOSED: exactly the seven neutral statuses with the frozen transition table", () => {
    expect([...MEDIA_JOB_STATUSES]).toEqual([
      "submitted",
      "dispatching",
      "generating",
      "verifying",
      "completed",
      "failed",
      "cancelled",
    ]);
    // The frozen transitions (the provider NEVER drives vocabulary).
    expect(MEDIA_JOB_TRANSITIONS.submitted).toEqual(["dispatching", "cancelled"]);
    expect(MEDIA_JOB_TRANSITIONS.dispatching).toEqual(["generating", "failed", "cancelled"]);
    expect(MEDIA_JOB_TRANSITIONS.generating).toEqual(["verifying", "failed", "cancelled"]);
    expect(MEDIA_JOB_TRANSITIONS.verifying).toEqual(["completed", "failed"]);
    expect(MEDIA_JOB_TRANSITIONS.completed).toEqual([]);
    expect(MEDIA_JOB_TRANSITIONS.failed).toEqual([]);
    expect(MEDIA_JOB_TRANSITIONS.cancelled).toEqual([]);
    expect(isTerminalMediaJobStatus("completed")).toBe(true);
    expect(isTerminalMediaJobStatus("failed")).toBe(true);
    expect(isTerminalMediaJobStatus("cancelled")).toBe(true);
    expect(isTerminalMediaJobStatus("verifying")).toBe(false);
    // Raw provider states are NEVER statuses.
    expect(isMediaJobStatus("queued")).toBe(false);
    expect(isMediaJobStatus("succeeded")).toBe(false);
    expect(isMediaJobStatus("processing")).toBe(false);
    // Terminal statuses are immutable (no outgoing edge).
    for (const from of ["completed", "failed", "cancelled"] as const) {
      for (const to of MEDIA_JOB_STATUSES) {
        expect(canTransitionMediaJob(from, to)).toBe(false);
      }
    }
  });

  test("the normalized observation vocabulary is CLOSED and separate from job statuses", () => {
    expect([...MEDIA_PROVIDER_OBSERVATIONS]).toEqual([
      "accepted",
      "progressed",
      "provider-completed",
      "provider-failed",
      "provider-cancelled",
    ]);
    for (const observation of MEDIA_PROVIDER_OBSERVATIONS) {
      expect(isMediaProviderObservation(observation)).toBe(true);
      // An observation is never a job status (the two vocabularies are
      // disjoint — the projection is a guarded state machine, not an
      // alias).
      expect(isMediaJobStatus(observation)).toBe(false);
    }
    expect(isMediaProviderObservation("RUNNING")).toBe(false);
    expect(isMediaProviderObservation("done")).toBe(false);
    expect(isCompletionObservation("provider-completed")).toBe(true);
    expect(isCompletionObservation("accepted")).toBe(false);
    expect([...MEDIA_OBSERVATION_SOURCES]).toEqual(["poll", "callback"]);
  });

  test("the verification modes, artifact roles and operation vocabularies are closed", () => {
    expect([...MEDIA_VERIFICATION_MODES]).toEqual(["none", "required"]);
    expect(isMediaVerificationMode("required")).toBe(true);
    expect(isMediaVerificationMode("always")).toBe(false);
    expect([...MEDIA_ARTIFACT_ROLES]).toEqual(["generated-output", "derived-variant"]);
    expect([...MEDIA_OPERATION_KINDS]).toEqual([
      "job-submission",
      "paid-dispatch",
      "observation-apply",
      "job-completion",
      "job-cancellation",
      "variant-adoption",
    ]);
    expect([...MEDIA_OPERATION_STATUSES]).toEqual(["pending", "completed", "failed"]);
    expect(isMediaOperationKind("paid-dispatch")).toBe(true);
    expect(isMediaOperationKind("dispatch")).toBe(false);
    expect(isMediaOperationStatus("pending")).toBe(true);
    expect(isMediaOperationStatus("retrying")).toBe(false);
  });
});

describe("media domain: fail-closed input validation", () => {
  const valid: SubmitMediaJobInput = {
    deploymentId: DEPLOYMENT,
    generationKind: "image",
    prompt: "a red panda painting watercolors",
  };

  test("a valid submission input passes", () => {
    expect(validateSubmitMediaJobInput(valid).valid).toBe(true);
  });

  test("invalid generation kinds, prompts, digests and parameters fail closed", () => {
    expect(validateSubmitMediaJobInput({ ...valid, generationKind: "openai-video" }).valid).toBe(
      false,
    );
    expect(validateSubmitMediaJobInput({ ...valid, generationKind: 7 }).valid).toBe(false);
    expect(validateSubmitMediaJobInput({ ...valid, prompt: "" }).valid).toBe(false);
    expect(validateSubmitMediaJobInput({ ...valid, prompt: "x".repeat(4001) }).valid).toBe(false);
    expect(
      validateSubmitMediaJobInput({ ...valid, inputArtifactDigest: "not-a-digest" }).valid,
    ).toBe(false);
    expect(
      validateSubmitMediaJobInput({ ...valid, inputArtifactDigest: "a".repeat(64) }).valid,
    ).toBe(true);
    expect(validateSubmitMediaJobInput({ ...valid, parameters: "text" }).valid).toBe(false);
    expect(
      validateSubmitMediaJobInput({
        ...valid,
        parameters: { apiKey: "sk-abcdefghijklmnopqrst" },
      }).valid,
    ).toBe(false);
  });

  test("prompt/parameter free-text rejects raw secret shapes (the WORK-011 discipline)", () => {
    expect(
      validateSubmitMediaJobInput({ ...valid, prompt: "use key sk-abcdefghijklmnopqrstuvw" }).valid,
    ).toBe(false);
    expect(mediaContainsRawSecretValue("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(mediaContainsRawSecretValue(`ghp_${"a".repeat(24)}`)).toBe(true);
    expect(mediaContainsRawSecretValue("just an innocent prompt")).toBe(false);
  });

  test("verification criteria declarations are bounded and 1..8 when the mode is required", () => {
    expect(validateSubmitMediaJobInput({ ...valid, verification: { criteria: [] } }).valid).toBe(
      false,
    );
    expect(
      validateSubmitMediaJobInput({
        ...valid,
        verification: { criteria: [{ criterionId: "c", version: 1 }] },
      }).valid,
    ).toBe(true);
    expect(
      validateSubmitMediaJobInput({
        ...valid,
        verification: {
          criteria: Array.from({ length: 9 }, () => ({ criterionId: "c", version: 1 })),
        },
      }).valid,
    ).toBe(false);
    expect(
      validateSubmitMediaJobInput({
        ...valid,
        verification: { criteria: [{ criterionId: "c", version: 0 }] },
      }).valid,
    ).toBe(false);
    expect(
      validateSubmitMediaJobInput({
        ...valid,
        verification: { criteria: [{ criterionId: "", version: 1 }] },
      }).valid,
    ).toBe(false);
  });

  test("callback frames validate the correlation reference, the normalized observation and bounds", () => {
    const frame = {
      jobId: UUID,
      providerJobRef: "simmedia-job-1",
      observation: "provider-completed",
    };
    expect(validateMediaCallbackInput(frame).valid).toBe(true);
    expect(validateMediaCallbackInput({ ...frame, observation: "RUNNING" }).valid).toBe(false);
    expect(validateMediaCallbackInput({ ...frame, jobId: "not-a-uuid" }).valid).toBe(false);
    expect(validateMediaCallbackInput({ ...frame, providerJobRef: "" }).valid).toBe(false);
    expect(validateMediaCallbackInput({ ...frame, providerJobRef: "has whitespace" }).valid).toBe(
      false,
    );
    expect(validateMediaCallbackInput({ ...frame, progress: 101 }).valid).toBe(false);
    expect(
      validateMediaCallbackInput({ ...frame, callbackKey: "sk-abcdefghijklmnopqrst" }).valid,
    ).toBe(false);
    expect(
      validateMediaCallbackInput({
        ...frame,
        outputDescriptor: { bytes: "AAAA" },
      }).valid,
    ).toBe(true);
  });

  test("variant derivation inputs validate the job id and the bounded transform descriptor", () => {
    expect(
      validateDeriveMediaVariantInput({ jobId: UUID, variant: { resize: "512x512" } }).valid,
    ).toBe(true);
    expect(validateDeriveMediaVariantInput({ jobId: "nope", variant: {} }).valid).toBe(false);
    expect(validateDeriveMediaVariantInput({ jobId: UUID, variant: "text" }).valid).toBe(false);
    expect(
      validateDeriveMediaVariantInput({ jobId: UUID, variant: { secret: "sk-abcdefghijklmnopqr" } })
        .valid,
    ).toBe(false);
  });
});

describe("media domain: deterministic preprocessing and postprocessing", () => {
  test("preprocessing is order-stable and canonical (identical inputs — any parameter order — one digest)", () => {
    const a = preprocessMediaJobSpec({
      generationKind: "image",
      prompt: "same prompt",
      inputArtifactDigest: null,
      parameters: { width: 1024, style: "watercolor", seed: 7 },
    });
    const b = preprocessMediaJobSpec({
      generationKind: "image",
      prompt: "same prompt",
      inputArtifactDigest: null,
      parameters: { seed: 7, style: "watercolor", width: 1024 },
    });
    expect(digest(JSON.stringify(a))).toBe(digest(JSON.stringify(b)));
    expect(a.parameters).toEqual({ seed: 7, style: "watercolor", width: 1024 });
    expect(a.generationKind).toBe("image");
  });

  test("postprocessing REJECTS outputs without a 64-hex content digest (the deterministic shape check)", () => {
    expect(() =>
      postprocessMediaOutput({
        generationKind: "image",
        providerOutput: { generationKind: "image" },
      }),
    ).toThrow(/contentDigest/);
    expect(() =>
      postprocessMediaOutput({
        generationKind: "image",
        providerOutput: { generationKind: "image", contentDigest: "zzz" },
      }),
    ).toThrow(/contentDigest/);
  });

  test("postprocessing REJECTS generation-kind mismatches before completion (AC5)", () => {
    expect(() =>
      postprocessMediaOutput({
        generationKind: "video",
        providerOutput: { generationKind: "image", contentDigest: "a".repeat(64) },
      }),
    ).toThrow(/generation kind mismatch/);
  });

  test("postprocessing normalizes a valid output into a bounded descriptor carrying the digest", () => {
    const contentDigest = "a".repeat(64);
    const { descriptor } = postprocessMediaOutput({
      generationKind: "image",
      providerOutput: {
        generationKind: "image",
        contentDigest,
        width: 1024,
        height: 768,
      },
    });
    expect(descriptor.contentDigest).toBe(contentDigest);
    expect(descriptor.generationKind).toBe("image");
    expect(descriptor.width).toBe(1024);
  });
});

describe("media domain: the stable idempotency-key scheme (crash-safety)", () => {
  test("submission, observation and operation keys are deterministic discriminators", () => {
    expect(
      deterministicMediaSubmissionKey({
        applicationId: UUID,
        deploymentId: DEPLOYMENT,
        generationKind: "video",
        preprocessingDigest: "a".repeat(64),
      }),
    ).toBe(`media-${DEPLOYMENT}-video-${"a".repeat(32)}`);
    expect(
      deterministicMediaObservationKey({
        jobId: UUID,
        observation: "progressed",
        progress: 25,
      }),
    ).toBe(`obs-${UUID}-progressed-25`);
    expect(
      deterministicMediaObservationKey({
        jobId: UUID,
        observation: "accepted",
        progress: null,
      }),
    ).toBe(`obs-${UUID}-accepted`);
    // Identical polls converge; new progress is new evidence.
    expect(
      deterministicMediaObservationKey({ jobId: UUID, observation: "progressed", progress: 25 }),
    ).toBe(
      deterministicMediaObservationKey({ jobId: UUID, observation: "progressed", progress: 25.2 }),
    );
    expect(
      deterministicMediaObservationKey({ jobId: UUID, observation: "progressed", progress: 60 }),
    ).not.toBe(
      deterministicMediaObservationKey({ jobId: UUID, observation: "progressed", progress: 25 }),
    );
    expect(mediaOperationKey("paid-dispatch", UUID)).toBe(`mediaop:paid-dispatch:${UUID}`);
  });

  test("the rail dispatch/cancel keys, budget operation id, verification key and artifact keys are job-stable", () => {
    expect(mediaRailDispatchKey(UUID)).toBe(`mediarail:dispatch:${UUID}`);
    expect(mediaRailCancelKey(UUID)).toBe(`mediarail:cancel:${UUID}`);
    expect(mediaBudgetOperationId(UUID)).toBe(`media-reserve:${UUID}`);
    expect(mediaVerificationKey(UUID)).toBe(`media-verify:${UUID}`);
    expect(mediaOutputArtifactKey(UUID)).toBe(`out:${UUID}`);
    expect(mediaVariantArtifactKey("variant-key-1")).toBe("variant:variant-key-1");
    expect(mediaEvidenceKey(UUID, "job-dispatched")).toBe(`media:${UUID}:job-dispatched`);
  });

  test("the creation fingerprint arbitrates idempotent replay vs key reuse", () => {
    const base: SubmitMediaJobInput = {
      deploymentId: DEPLOYMENT,
      generationKind: "image",
      prompt: "a watercolor lighthouse",
    };
    const first = mediaJobCreationFingerprint(UUID, base, EXECUTION);
    expect(mediaJobCreationFingerprint(UUID, base, EXECUTION)).toBe(first);
    expect(
      mediaJobCreationFingerprint(UUID, { ...base, prompt: "an oil lighthouse" }, EXECUTION),
    ).not.toBe(first);
    expect(
      mediaJobCreationFingerprint("00000000-0000-7000-8000-0000000000ba", base, EXECUTION),
    ).not.toBe(first);
  });

  test("the observation body digest base discriminates same-key different-body replays", () => {
    const base = {
      jobId: UUID,
      observationKey: "obs-1",
      observation: "provider-completed",
      outputDescriptor: null,
    } as const;
    const first = digest(mediaObservationBodyDigestBase(base));
    expect(
      digest(
        mediaObservationBodyDigestBase({
          ...base,
          outputDescriptor: { contentDigest: "a".repeat(64) },
        }),
      ),
    ).not.toBe(first);
    expect(
      digest(
        mediaObservationBodyDigestBase({
          ...base,
          outputDescriptor: null,
        }),
      ),
    ).toBe(first);
  });

  test("the observation body digest is INVARIANT to descriptor key order (the jsonb round-trip property the P6 crash proof found)", () => {
    // PostgreSQL jsonb does NOT preserve object key order — a body
    // re-read from an `output_descriptor jsonb` column comes back in
    // PostgreSQL's canonical key order, not the caller's insertion
    // order. A legitimate same-body replay must therefore digest
    // EQUAL under key permutation (the crash-resume convergence in
    // the SQL store's conflict path), while a different body under
    // the same key still fails closed.
    const insertionOrder = {
      contentDigest: "b".repeat(64),
      generationKind: "image",
      width: 1024,
      height: 768,
      durationMs: null,
    };
    const jsonbOrder = {
      width: 1024,
      height: 768,
      durationMs: null,
      contentDigest: "b".repeat(64),
      generationKind: "image",
    };
    expect(
      digest(
        mediaObservationBodyDigestBase({
          jobId: UUID,
          observationKey: "obs-1",
          observation: "provider-completed",
          outputDescriptor: insertionOrder,
        }),
      ),
    ).toBe(
      digest(
        mediaObservationBodyDigestBase({
          jobId: UUID,
          observationKey: "obs-1",
          observation: "provider-completed",
          outputDescriptor: jsonbOrder,
        }),
      ),
    );
    // Nested objects are canonicalized too.
    expect(
      digest(
        mediaObservationBodyDigestBase({
          jobId: UUID,
          observationKey: "obs-1",
          observation: "provider-completed",
          outputDescriptor: { meta: { zeta: 1, alpha: 2 } },
        }),
      ),
    ).toBe(
      digest(
        mediaObservationBodyDigestBase({
          jobId: UUID,
          observationKey: "obs-1",
          observation: "provider-completed",
          outputDescriptor: { meta: { alpha: 2, zeta: 1 } },
        }),
      ),
    );
    // A DIFFERENT body still digests differently under the same key.
    expect(
      digest(
        mediaObservationBodyDigestBase({
          jobId: UUID,
          observationKey: "obs-1",
          observation: "provider-completed",
          outputDescriptor: insertionOrder,
        }),
      ),
    ).not.toBe(
      digest(
        mediaObservationBodyDigestBase({
          jobId: UUID,
          observationKey: "obs-1",
          observation: "provider-completed",
          outputDescriptor: { ...jsonbOrder, width: 512 },
        }),
      ),
    );
    // Array ORDER is preserved (JSON arrays are ordered — only object
    // keys are canonicalized).
    expect(
      digest(
        mediaObservationBodyDigestBase({
          jobId: UUID,
          observationKey: "obs-1",
          observation: "provider-completed",
          outputDescriptor: { frames: [1, 2, 3] },
        }),
      ),
    ).not.toBe(
      digest(
        mediaObservationBodyDigestBase({
          jobId: UUID,
          observationKey: "obs-1",
          observation: "provider-completed",
          outputDescriptor: { frames: [3, 2, 1] },
        }),
      ),
    );
  });
});
