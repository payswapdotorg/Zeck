/**
 * VAL-014 platform unit tests: the voice derivations (pure), the REAL
 * rails over controlled fake transports (no network), the dispatch
 * binding's pre-dispatch discriminations, and both drivers (the
 * voice-io execution driver and the realtime voice-loop session
 * driver with its bounded typed turn protocol).
 *
 * Honesty invariants under test:
 *   * a missing fixture is a NOT RUN boundary (thrown BEFORE any
 *     lifecycle mutation);
 *   * verification oracles come from the fixtures' ground truth — a
 *     provider failure FAILS the run; a missing transcript term fails
 *     its criterion; an invalid TTS payload fails the container
 *     criterion; a digest criterion never carries payload bytes;
 *   * the rails normalize REAL provider response shapes (the
 *     dashscope-international dedicated ASR task API and the
 *     text-to-audio TTS rail, both over the multimodal-generation
 *     endpoint) and map HTTP failures to the provider-failure taxonomy
 *     honestly (400 invalid-request is NOT retryable — the
 *     corrupted-audio edge is a genuine failure);
 *   * an ASR 200 with an empty transcript is an honest success with an
 *     empty transcript (silence-legitimate), never a fabricated
 *     failure;
 *   * the binding rejects digest mismatches, wrong-modality requests
 *     and empty TTS text BEFORE any network effect;
 *   * the turn protocol is bounded (declared turns only), exactly-once
 *     per turn leg across interruptions, resume-continuous, with the
 *     stale-worker denial journaled and the corrupted turn checkpoint
 *     detected and never trusted.
 */

import { describe, expect, test, vi } from "vitest";
import { VOICE_SESSIONS } from "../../../benchmarks/validation/apps/realtime-voice/dialogs";
import {
  dialogFixture,
  mediaDigest,
  phraseFixture,
  synthesizeWav,
  textDigest,
  voiceFixture,
} from "../../../benchmarks/validation/apps/shared/media";
import { VOICE_IO_TASKS } from "../../../benchmarks/validation/apps/voice-io/application";
import type {
  RealtimeVoiceTurnPorts,
  VoiceLifecyclePort,
} from "../../../benchmarks/validation/platform/voice";
import {
  createDashscopeVoiceRail,
  createVoiceDispatchBinding,
  deriveVoicePlan,
  deriveVoiceVerification,
  driveRealtimeVoiceSession,
  driveVoiceExecution,
  type HttpTransport,
  materializeVoiceSession,
  REALTIME_VOICE_RAIL_REQUIREMENT,
  toDataUri,
  ttsPayloadCriteria,
  type VoiceDispatchOutcome,
  VoiceFixtureNotMaterializedError,
  verifyAudioContainer,
} from "../../../benchmarks/validation/platform/voice";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wavResponse(wav: Buffer): Response {
  return new Response(new Uint8Array(wav), { status: 200 });
}

/** A fake transport scripted with one response (or a thrown error). */
function scriptedTransport(response: () => Promise<Response> | Response): {
  readonly transport: HttpTransport;
  readonly calls: { url: string; method: string; body: unknown }[];
} {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return await response();
  };
  return { transport, calls };
}

function recordingLifecycle(): {
  readonly lifecycle: VoiceLifecyclePort;
  readonly transitions: string[];
} {
  const transitions: string[] = [];
  const lifecycle: VoiceLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
    },
    async recordPlanningDecision({ route, legs }) {
      transitions.push(`planning-decision:${route.strategyClass}:${legs.length}legs`);
    },
    async complete({ verdict }) {
      transitions.push(`complete:${verdict}`);
    },
  };
  return { lifecycle, transitions };
}

/** A stateful fake realtime lifecycle mirroring the REAL state machine. */
function realtimeLifecycle(options: { readonly denyStaleResume: boolean }): {
  readonly lifecycle: ReturnType<typeof bindLifecycle>;
  readonly transitions: string[];
  readonly turnCheckpoints: { turn: number; digest: string }[];
  readonly resumeDenied: string[];
} {
  const transitions: string[] = [];
  const turnCheckpoints: { turn: number; digest: string }[] = [];
  const resumeDenied: string[] = [];
  let status: "RUNNING" | "WAITING_USER" | "TERMINAL" = "RUNNING";
  let completeCallKey: string | null = null;
  const transitions2 = transitions;
  const lifecycle = {
    async transition(command: {
      readonly executionId: string;
      readonly step: string;
      readonly reason: string;
      readonly callKey: string;
    }) {
      if (command.step === "wait-user") {
        status = "WAITING_USER";
        transitions2.push("wait-user");
        return;
      }
      if (command.step === "resume") {
        if (status !== "WAITING_USER") {
          // The REAL state machine: resume is legal only from WAITING_*.
          if (options.denyStaleResume) {
            throw new Error(`resume rejected in state ${status} (not WAITING_USER)`);
          }
          transitions2.push("resume:ignored-stale");
          return;
        }
        status = "RUNNING";
        transitions2.push("resume");
        return;
      }
      if (command.step === "pass" || command.step === "fail") {
        status = "TERMINAL";
      }
      transitions2.push(command.step);
    },
    async recordPlanningDecision() {
      transitions2.push("planning-decision");
    },
    async recordTurnCheckpoint(input: { readonly turn: number; readonly digest: string }) {
      turnCheckpoints.push({ turn: input.turn, digest: input.digest });
      transitions2.push("turn-checkpoint");
    },
    async recordInterruption() {
      transitions2.push("interruption");
    },
    async recordResumeDenied(input: { readonly reason: string }) {
      resumeDenied.push(input.reason);
      transitions2.push("resume-denied");
    },
    async complete(input: { readonly callKey: string }) {
      completeCallKey = input.callKey;
      status = "TERMINAL";
      transitions2.push("complete");
    },
    async attemptNoOpResume(input: { readonly completeCallKey: string }) {
      // The REAL idempotency ledger: the exact same transition key REPLAYS.
      const replayed = input.completeCallKey === completeCallKey;
      return { replayed };
    },
  };
  return { lifecycle, transitions, turnCheckpoints, resumeDenied };
}

function bindLifecycle(port: {
  transition(command: {
    readonly executionId: string;
    readonly step: string;
    readonly reason: string;
    readonly callKey: string;
  }): Promise<void>;
  recordPlanningDecision(input: { readonly executionId: string }): Promise<void>;
  recordTurnCheckpoint(input: {
    readonly executionId: string;
    readonly turn: number;
    readonly digest: string;
    readonly callKey: string;
  }): Promise<void>;
  recordInterruption(input: { readonly executionId: string }): Promise<void>;
  recordResumeDenied(input: {
    readonly executionId: string;
    readonly reason: string;
  }): Promise<void>;
  complete(input: { readonly executionId: string; readonly callKey: string }): Promise<void>;
  attemptNoOpResume(input: {
    readonly completeCallKey: string;
  }): Promise<{ readonly replayed: boolean }>;
}) {
  return port;
}

const UTT_TASK = { kind: "transcribe-utterance", clip: "utt-001" } as const;
const ROUNDTRIP_TASK = {
  kind: "transcribe-roundtrip",
  phrase: "phrase-001",
  voice: "Cherry",
} as const;
const TTS_TASK = { kind: "synthesize-speech", phrase: "phrase-002", voice: "Cherry" } as const;

// ---------------------------------------------------------------------------
// Materialization + plan derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-014 voice fixture materialization", () => {
  test("every pinned voice-io fixture materializes deterministically (same bytes, same digest)", () => {
    for (const task of VOICE_IO_TASKS) {
      if (task.kind === "transcribe-utterance") {
        const first = voiceFixture(task.clip);
        const second = voiceFixture(task.clip);
        expect(first.wav.equals(second.wav)).toBe(true);
        expect(mediaDigest(first.wav)).toBe(mediaDigest(second.wav));
      } else {
        const first = phraseFixture(task.phrase);
        const second = phraseFixture(task.phrase);
        expect(first.text).toBe(second.text);
        expect(textDigest(first.text)).toBe(textDigest(second.text));
      }
    }
  });

  test("the synthetic audio fixtures are valid 16 kHz mono PCM WAV clips", () => {
    for (const key of ["utt-001", "brf-001", "cmd-001", "cmd-002"]) {
      const wav = voiceFixture(key).wav;
      expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(wav.readUInt32LE(24)).toBe(16000);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(verifyAudioContainer(wav).valid).toBe(true);
    }
  });

  test("the dialog fixtures materialize bounded turn streams with joined WAV payloads", () => {
    for (const session of VOICE_SESSIONS) {
      const fixture = dialogFixture(session.sessionId);
      expect(fixture.turns).toHaveLength(session.turns.length);
      expect(verifyAudioContainer(fixture.stream).valid).toBe(true);
      const materialized = materializeVoiceSession(session.sessionId);
      expect(materialized.streamDigest).toBe(mediaDigest(fixture.stream));
      expect(materialized.definition.sessionId).toBe(session.sessionId);
    }
  });

  test("the corrupt fixture materializes as genuinely corrupted bytes", () => {
    const corrupt = voiceFixture("audio-corrupt");
    expect(corrupt.annotation).toBe("corrupt");
    expect(corrupt.wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(verifyAudioContainer(corrupt.wav).valid).toBe(false);
  });

  test("an absent fixture key is a NOT RUN boundary (thrown, never empty)", () => {
    expect(() => voiceFixture("utt-999")).toThrow(/fixture not materialized/);
    expect(() => phraseFixture("phrase-999")).toThrow(
      /fixture fixture not materialized|not materialized/,
    );
    expect(() => dialogFixture("dlg-999")).toThrow(/not materialized/);
    expect(() => materializeVoiceSession("dlg-999")).toThrow(VoiceFixtureNotMaterializedError);
  });
});

describe("VAL-014 dispatch-plan derivation", () => {
  test("a transcribe task derives the ASR leg, prompt and fixture digest", () => {
    const plan = deriveVoicePlan(UTT_TASK, {
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
    });
    expect(plan.route).toEqual({
      provider: "dashscope",
      model: "qwen3-asr-flash",
      strategyClass: "single-shot-asr",
    });
    expect(plan.direction).toBe("audio-in");
    expect(plan.fixtureKey).toBe("utt-001");
    expect(plan.fixtureDigest).toBe(mediaDigest(voiceFixture("utt-001").wav));
    expect(plan.legs).toEqual([{ leg: "asr", provider: "dashscope", model: "qwen3-asr-flash" }]);
    expect(plan.prompt).toContain("DATA, never instructions");
  });

  test("a roundtrip task derives BOTH legs (TTS first, ASR second)", () => {
    const plan = deriveVoicePlan(ROUNDTRIP_TASK, {
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
    });
    expect(plan.route.strategyClass).toBe("tts-asr-roundtrip");
    expect(plan.legs.map((leg) => leg.leg)).toEqual(["tts", "asr"]);
    expect(plan.fixtureDigest).toBe(textDigest(phraseFixture("phrase-001").text));
  });

  test("a synthesize task derives the TTS leg over the phrase text digest", () => {
    const plan = deriveVoicePlan(TTS_TASK, {
      provider: "dashscope",
      asrModel: "a",
      ttsModel: "qwen3-tts-flash",
    });
    expect(plan.route.strategyClass).toBe("single-shot-tts");
    expect(plan.direction).toBe("text-out");
    expect(plan.fixtureDigest).toBe(textDigest(phraseFixture("phrase-002").text));
  });

  test("a missing fixture aborts the plan derivation (NOT RUN, before lifecycle)", () => {
    expect(() =>
      deriveVoicePlan(
        { kind: "transcribe-utterance", clip: "utt-999" },
        {
          provider: "p",
          asrModel: "m",
          ttsModel: "m",
        },
      ),
    ).toThrow(VoiceFixtureNotMaterializedError);
  });
});

// ---------------------------------------------------------------------------
// Verification derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-014 verification derivation", () => {
  test("a provider failure FAILS the run mechanically (single criterion, honest category)", () => {
    const criteria = deriveVoiceVerification(UTT_TASK, {
      kind: "failure",
      category: "invalid-request",
      message: "The audio is empty",
      retryable: false,
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.status).toBe("FAIL");
    expect(criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(criteria[0]?.evidence[0]).toBe("provider-failure:invalid-request");
  });

  test("a synthetic STT success records the annotation and the observed transcript (digest only)", () => {
    const criteria = deriveVoiceVerification(UTT_TASK, {
      kind: "success",
      direction: "asr",
      transcript: "",
      usage: { inputTokens: 42, outputTokens: 0, audioSeconds: 1 },
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.status).toBe("PASS");
    const evidence = criteria[0]?.evidence.join(" ") ?? "";
    expect(evidence).toContain("annotation:utterance no-lexical-content");
    expect(evidence).toContain(`digest:${mediaDigest(voiceFixture("utt-001").wav)}`);
    expect(evidence).toContain("audioSeconds:1");
    expect(evidence).not.toContain("base64");
    expect(evidence).not.toContain("RIFF");
  });

  test("roundtrip transcript terms are matched case-insensitively against the phrase ground truth", () => {
    const criteria = deriveVoiceVerification(ROUNDTRIP_TASK, {
      kind: "success",
      direction: "asr",
      transcript: "Good morning. The MEETING is at nine tomorrow.",
    });
    expect(criteria.map((c) => c.status)).toEqual(["PASS", "PASS"]);
    expect(criteria[0]?.criterionId).toBe("transcript-contains:meeting");
  });

  test("a roundtrip transcript missing the phrase term fails its criterion (no provider-success shortcut)", () => {
    const criteria = deriveVoiceVerification(ROUNDTRIP_TASK, {
      kind: "success",
      direction: "asr",
      transcript: "Hello there.",
    });
    expect(criteria.map((c) => c.status)).toEqual(["FAIL", "PASS"]);
    expect(criteria[0]?.evidence[0]).toBe("term-missing:meeting");
  });

  test("an empty roundtrip transcript fails the presence criterion", () => {
    const criteria = deriveVoiceVerification(ROUNDTRIP_TASK, {
      kind: "success",
      direction: "asr",
      transcript: "   ",
    });
    expect(criteria.map((c) => c.status)).toEqual(["FAIL", "FAIL"]);
  });

  test("TTS payload criteria verify container, non-emptiness and digest capture", () => {
    const wav = synthesizeWav([{ freqHz: 440, durationMs: 300 }]);
    const criteria = ttsPayloadCriteria(
      wav,
      "phrase-002",
      textDigest(phraseFixture("phrase-002").text),
    );
    expect(criteria.map((c) => c.criterionId)).toEqual([
      "tts-payload-present",
      "tts-container-valid",
      "tts-digest-captured",
    ]);
    expect(criteria.every((c) => c.status === "PASS")).toBe(true);
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain(`digest:${mediaDigest(wav)}`);
    expect(evidence).toContain("container:wav");
    expect(evidence).not.toContain("base64");
  });

  test("a corrupted TTS payload fails the container criterion honestly", () => {
    const corrupt = voiceFixture("audio-corrupt").wav;
    const criteria = ttsPayloadCriteria(corrupt, "phrase-002", "d");
    expect(criteria.find((c) => c.criterionId === "tts-container-valid")?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The REAL rails over fake transports (no network)
// ---------------------------------------------------------------------------

const ASR_SUCCESS_BODY = {
  request_id: "req-1",
  output: {
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: [{ text: "Good morning. The meeting is at nine tomorrow." }],
        },
      },
    ],
  },
  usage: {
    input_tokens_details: { audio_tokens: 42 },
    output_tokens_details: { text_tokens: 9 },
    seconds: 2,
  },
};

const TTS_SUCCESS_BODY = {
  status_code: 200,
  request_id: "req-2",
  code: "",
  message: "",
  output: {
    finish_reason: "stop",
    audio: {
      data: "",
      url: "https://dashscope-result.example.com/audio.wav?Expires=1&Signature=s",
      id: "audio-1",
      expires_at: 1766113409,
    },
  },
  usage: { input_tokens: 0, output_tokens: 0, characters: 43 },
};

describe("VAL-014 dashscope voice rail — ASR direction (fake transport)", () => {
  test("a success outcome parses the native multimodal-generation shape and usage", async () => {
    const { transport, calls } = scriptedTransport(() => jsonResponse(200, ASR_SUCCESS_BODY));
    const rail = createDashscopeVoiceRail({ transport, apiKey: "test-key" });
    const outcome = await rail.transcribe({
      model: "qwen3-asr-flash",
      audioDataUri: toDataUri(voiceFixture("utt-001").wav, "audio/wav"),
      context: "Transcribe the speech exactly.",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success" && outcome.direction === "asr") {
      expect(outcome.transcript).toContain("meeting");
      expect(outcome.usage?.inputTokens).toBe(42);
      expect(outcome.usage?.outputTokens).toBe(9);
      expect(outcome.usage?.audioSeconds).toBe(2);
      expect(outcome.usage?.costUsd).toBeUndefined();
    }
    expect(calls[0]?.url).toBe(
      "https://dashscope-international.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    const body = calls[0]?.body as {
      model: string;
      input: { messages: { role: string; content: Record<string, string>[] }[] };
      parameters: { asr_options: { enable_itn: boolean } };
    };
    expect(body.model).toBe("qwen3-asr-flash");
    expect(body.input.messages[0]?.role).toBe("user");
    expect(body.input.messages[0]?.content[0]?.audio).toBe(
      toDataUri(voiceFixture("utt-001").wav, "audio/wav"),
    );
    expect(body.input.messages[0]?.content[1]?.text).toBe("Transcribe the speech exactly.");
    expect(body.parameters.asr_options.enable_itn).toBe(false);
  });

  test("a plain-string content shape normalizes to the transcript", async () => {
    const { transport } = scriptedTransport(() =>
      jsonResponse(200, {
        output: { choices: [{ message: { role: "assistant", content: "hello" } }] },
        usage: { seconds: 1 },
      }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const outcome = await rail.transcribe({
      model: "m",
      audioDataUri: toDataUri(voiceFixture("cmd-001").wav, "audio/wav"),
    });
    expect(
      outcome.kind === "success" && outcome.direction === "asr" ? outcome.transcript : "",
    ).toBe("hello");
  });

  test("a 200 with an EMPTY transcript is an honest success with an empty transcript", async () => {
    const { transport } = scriptedTransport(() =>
      jsonResponse(200, { output: { choices: [{ message: { content: [{ text: "" }] } }] } }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const outcome = await rail.transcribe({
      model: "m",
      audioDataUri: toDataUri(voiceFixture("utt-001").wav, "audio/wav"),
    });
    // Silence-legitimate: never a fabricated failure, never fabricated content.
    expect(outcome).toMatchObject({ kind: "success", direction: "asr", transcript: "" });
  });

  test("HTTP failures map to the provider-failure taxonomy honestly", async () => {
    const cases: [number, unknown, { category: string; retryable: boolean }][] = [
      [
        400,
        { code: "InvalidParameter", message: "The audio is empty", request_id: "r" },
        { category: "invalid-request", retryable: false },
      ],
      [
        401,
        { code: "InvalidApiKey", message: "Invalid API-key" },
        { category: "auth", retryable: false },
      ],
      [
        404,
        { code: "ModelNotFound", message: "model not found" },
        { category: "model-unavailable", retryable: false },
      ],
      [
        429,
        { code: "Throttling", message: "Requests rate limited" },
        { category: "rate-limit", retryable: true },
      ],
      [
        503,
        { code: "ServiceUnavailable", message: "upstream down" },
        { category: "provider-unavailable", retryable: true },
      ],
    ];
    for (const [status, body, expected] of cases) {
      const { transport } = scriptedTransport(() => jsonResponse(status, body));
      const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
      const outcome = await rail.transcribe({
        model: "m",
        audioDataUri: toDataUri(voiceFixture("utt-001").wav, "audio/wav"),
      });
      expect(outcome).toMatchObject({ kind: "failure", ...expected });
    }
  });

  test("a transport exception is a retryable transport failure", async () => {
    const { transport } = scriptedTransport(() => {
      throw new Error("ECONNRESET");
    });
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const outcome = await rail.transcribe({
      model: "m",
      audioDataUri: toDataUri(voiceFixture("utt-001").wav, "audio/wav"),
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "transport", retryable: true });
  });
});

describe("VAL-014 dashscope voice rail — TTS direction (fake transport)", () => {
  test("a success outcome downloads the payload URL and captures digest + character usage", async () => {
    const wav = synthesizeWav([{ freqHz: 440, durationMs: 500 }]);
    const calls: { url: string; method: string; body: unknown }[] = [];
    const transport: HttpTransport = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === "POST") {
        return jsonResponse(200, TTS_SUCCESS_BODY);
      }
      expect(init.method).toBe("GET");
      // The signed payload URL carries no credential headers.
      expect(Object.keys(init.headers)).toHaveLength(0);
      return wavResponse(wav);
    };
    const rail = createDashscopeVoiceRail({ transport, apiKey: "test-key" });
    const outcome = await rail.synthesize({
      model: "qwen3-tts-flash",
      text: phraseFixture("phrase-002").text,
      voice: "Cherry",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success" && outcome.direction === "tts") {
      expect(outcome.audio.bytes.equals(wav)).toBe(true);
      expect(outcome.audio.digest).toBe(mediaDigest(wav));
      expect(outcome.audio.mimeType).toBe("audio/wav");
      expect(outcome.usage?.characters).toBe(43);
    }
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(TTS_SUCCESS_BODY.output.audio.url);
    const body = calls[0]?.body as { model: string; input: Record<string, string> };
    expect(body.model).toBe("qwen3-tts-flash");
    expect(body.input.text).toBe(phraseFixture("phrase-002").text);
    expect(body.input.voice).toBe("Cherry");
    expect(body.input.language_type).toBe("English");
  });

  test("a base64 data payload (streaming-mode shape) decodes without a URL fetch", async () => {
    const wav = synthesizeWav([{ freqHz: 330, durationMs: 300 }]);
    const { transport, calls } = scriptedTransport(() =>
      jsonResponse(200, {
        output: {
          finish_reason: "stop",
          audio: { data: wav.toString("base64"), url: "", id: "audio-2", expires_at: 1 },
        },
        usage: { characters: 10 },
      }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const outcome = await rail.synthesize({ model: "m", text: "hi", voice: "Cherry" });
    expect(
      outcome.kind === "success" && outcome.direction === "tts"
        ? outcome.audio.bytes.equals(wav)
        : false,
    ).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("a 200 with no audio url and no data is an honest empty-audio failure", async () => {
    const { transport } = scriptedTransport(() =>
      jsonResponse(200, { output: { finish_reason: "stop", audio: {} } }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const outcome = await rail.synthesize({ model: "m", text: "hi", voice: "Cherry" });
    expect(outcome).toMatchObject({ kind: "failure", category: "empty-audio", retryable: true });
  });

  test("a payload download failure is an honest failure (never a fabricated payload)", async () => {
    const transport: HttpTransport = async (_url, init) => {
      if (init.method === "POST") {
        return jsonResponse(200, TTS_SUCCESS_BODY);
      }
      return jsonResponse(500, { code: "InternalError", message: "oss unavailable" });
    };
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const outcome = await rail.synthesize({ model: "m", text: "hi", voice: "Cherry" });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "provider-unavailable",
      retryable: true,
    });
  });

  test("a TTS 400 (invalid request) is a non-retryable honest failure", async () => {
    const { transport } = scriptedTransport(() =>
      jsonResponse(400, { code: "InvalidParameter", message: "The text is empty" }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const outcome = await rail.synthesize({ model: "m", text: "", voice: "Cherry" });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "invalid-request",
      retryable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The dispatch binding (pre-dispatch discriminations)
// ---------------------------------------------------------------------------

describe("VAL-014 dispatch binding", () => {
  test("routes transcribe rows to the ASR direction and synthesize rows to the TTS direction", async () => {
    const asrDispatch = vi.fn(async () => ({
      kind: "success" as const,
      direction: "asr" as const,
      transcript: "",
    }));
    const ttsDispatch = vi.fn(async () => ({
      kind: "success" as const,
      direction: "tts" as const,
      audio: {
        bytes: synthesizeWav([{ freqHz: 440, durationMs: 100 }]),
        mimeType: "audio/wav",
        digest: "d",
      },
    }));
    const calls = { count: 0 };
    const binding = createVoiceDispatchBinding({
      asr: { railId: "a", transcribe: asrDispatch, synthesize: ttsDispatch },
      tts: { railId: "t", transcribe: asrDispatch, synthesize: ttsDispatch },
      transportCalls: calls,
    });
    const asrOutcome = await binding({
      executionId: "e1",
      task: UTT_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
    });
    expect(asrOutcome).toMatchObject({ kind: "success", direction: "asr" });
    expect(asrDispatch).toHaveBeenCalledTimes(1);
    const ttsOutcome = await binding({
      executionId: "e2",
      task: TTS_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
    });
    expect(ttsOutcome).toMatchObject({ kind: "success", direction: "tts" });
    expect(ttsDispatch).toHaveBeenCalledTimes(1);
    expect(calls.count).toBe(2);
  });

  test("the roundtrip drives BOTH legs in order: TTS speech then ASR over exactly those bytes", async () => {
    const wav = synthesizeWav([{ freqHz: 440, durationMs: 600 }]);
    const asrInput: { audioDataUri: string }[] = [];
    const rail: {
      railId: string;
      transcribe: (input: { audioDataUri: string }) => Promise<VoiceDispatchOutcome>;
      synthesize: (input: { text: string }) => Promise<VoiceDispatchOutcome>;
    } = {
      railId: "dashscope-voice",
      async transcribe(input) {
        asrInput.push({ audioDataUri: input.audioDataUri });
        return { kind: "success", direction: "asr", transcript: "the meeting is at nine" };
      },
      async synthesize() {
        return {
          kind: "success",
          direction: "tts",
          audio: { bytes: wav, mimeType: "audio/wav", digest: mediaDigest(wav) },
        };
      },
    };
    const calls = { count: 0 };
    const binding = createVoiceDispatchBinding({ asr: rail, tts: rail, transportCalls: calls });
    const outcome = await binding({
      executionId: "e3",
      task: ROUNDTRIP_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
    });
    expect(outcome).toMatchObject({
      kind: "success",
      direction: "asr",
      transcript: "the meeting is at nine",
    });
    expect(calls.count).toBe(2);
    expect(asrInput).toHaveLength(1);
    // The ASR leg received EXACTLY the TTS leg's synthesized bytes.
    expect(asrInput[0]?.audioDataUri).toBe(toDataUri(wav, "audio/wav"));
  });

  test("a tampered clip materialization (digest mismatch) is rejected BEFORE any dispatch", async () => {
    const transcribe = vi.fn();
    const binding = createVoiceDispatchBinding({
      asr: {
        railId: "a",
        transcribe,
        synthesize: async () => ({
          kind: "failure",
          category: "x",
          message: "x",
          retryable: false,
        }),
      },
      materializeClip: (key) => ({
        key,
        digest: "0000000000000000",
        bytes: voiceFixture("cmd-002").wav,
        annotation: "tampered",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: UTT_TASK,
      provider: "p",
      asrModel: "m",
      ttsModel: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "fixture-digest-mismatch",
      retryable: false,
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("a tampered phrase materialization (digest mismatch) is rejected BEFORE any dispatch", async () => {
    const synthesize = vi.fn();
    const binding = createVoiceDispatchBinding({
      tts: {
        railId: "t",
        transcribe: async () => ({
          kind: "failure",
          category: "x",
          message: "x",
          retryable: false,
        }),
        synthesize,
      },
      materializePhrase: (key) => ({
        key,
        digest: "deadbeefdeadbeef",
        text: "tampered text",
        terms: [],
        annotation: "tampered",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: TTS_TASK,
      provider: "p",
      asrModel: "m",
      ttsModel: "m",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "fixture-digest-mismatch" });
    expect(synthesize).not.toHaveBeenCalled();
  });

  test("wrong-modality: a transcribe row with no ASR rail is rejected BEFORE any dispatch", async () => {
    const synthesize = vi.fn();
    const binding = createVoiceDispatchBinding({
      tts: {
        railId: "t",
        transcribe: async () => ({
          kind: "failure",
          category: "x",
          message: "x",
          retryable: false,
        }),
        synthesize,
      },
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: UTT_TASK,
      provider: "p",
      asrModel: "m",
      ttsModel: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "wrong-modality",
      retryable: false,
    });
    expect(synthesize).not.toHaveBeenCalled();
  });

  test("wrong-modality: a synthesize row with no TTS rail is rejected BEFORE any dispatch", async () => {
    const transcribe = vi.fn();
    const binding = createVoiceDispatchBinding({
      asr: {
        railId: "a",
        transcribe,
        synthesize: async () => ({
          kind: "failure",
          category: "x",
          message: "x",
          retryable: false,
        }),
      },
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: TTS_TASK,
      provider: "p",
      asrModel: "m",
      ttsModel: "m",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "wrong-modality" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("wrong-modality: a roundtrip with only one rail is rejected BEFORE any dispatch", async () => {
    const transcribe = vi.fn();
    const synthesize = vi.fn();
    const binding = createVoiceDispatchBinding({
      asr: { railId: "a", transcribe, synthesize },
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: ROUNDTRIP_TASK,
      provider: "p",
      asrModel: "m",
      ttsModel: "m",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "wrong-modality" });
    expect(transcribe).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  test("empty TTS text (the phrase-blank edge) is rejected BEFORE any dispatch, never retried", async () => {
    const synthesize = vi.fn();
    const binding = createVoiceDispatchBinding({
      tts: {
        railId: "t",
        transcribe: async () => ({
          kind: "failure",
          category: "x",
          message: "x",
          retryable: false,
        }),
        synthesize,
      },
      transportCalls: { count: 0 },
      retry: { attempts: 3, delayMs: 0, sleep: async () => {} },
    });
    const outcome = await binding({
      executionId: "e",
      task: { kind: "synthesize-speech", phrase: "phrase-blank", voice: "Cherry" },
      provider: "p",
      asrModel: "m",
      ttsModel: "m",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "empty-text", retryable: false });
    expect(synthesize).not.toHaveBeenCalled();
  });

  test("the bounded retry policy retries RETRYABLE failures only, with REAL attempts", async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];
    const rail = {
      railId: "a",
      async transcribe() {
        attempts.push(attempts.length + 1);
        if (attempts.length === 1) {
          return {
            kind: "failure" as const,
            category: "rate-limit",
            message: "429",
            retryable: true,
          };
        }
        return { kind: "success" as const, direction: "asr" as const, transcript: "" };
      },
      async synthesize() {
        return { kind: "failure" as const, category: "x", message: "x", retryable: false };
      },
    };
    const binding = createVoiceDispatchBinding({
      asr: rail,
      tts: rail,
      transportCalls: { count: 0 },
      retry: {
        attempts: 2,
        delayMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    const outcome = await binding({
      executionId: "e",
      task: UTT_TASK,
      provider: "p",
      asrModel: "m",
      ttsModel: "m",
    });
    expect(outcome).toMatchObject({ kind: "success", direction: "asr" });
    expect(attempts).toEqual([1, 2]);
    expect(sleeps).toEqual([50]);

    // A NON-retryable failure (the corrupted-audio 400) is never retried.
    const nonRetryableAttempts: number[] = [];
    const failingRail = {
      railId: "a",
      async transcribe() {
        nonRetryableAttempts.push(nonRetryableAttempts.length + 1);
        return {
          kind: "failure" as const,
          category: "invalid-request",
          message: "bad audio",
          retryable: false,
        };
      },
      async synthesize() {
        return { kind: "failure" as const, category: "x", message: "x", retryable: false };
      },
    };
    const failingBinding = createVoiceDispatchBinding({
      asr: failingRail,
      tts: failingRail,
      transportCalls: { count: 0 },
      retry: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });
    const failedOutcome = await failingBinding({
      executionId: "e2",
      task: UTT_TASK,
      provider: "p",
      asrModel: "m",
      ttsModel: "m",
    });
    expect(failedOutcome).toMatchObject({ kind: "failure", category: "invalid-request" });
    expect(nonRetryableAttempts).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// The voice-io execution driver (lifecycle order + honest terminals)
// ---------------------------------------------------------------------------

describe("VAL-014 voice-io execution driver", () => {
  test("drives the canonical lifecycle with the planning decision before dispatch", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const dispatchTransitions: string[] = [];
    const result = await driveVoiceExecution({
      executionId: "exec-1",
      task: UTT_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle,
        dispatch: async () => {
          dispatchTransitions.push(...transitions);
          return { kind: "success", direction: "asr", transcript: "" };
        },
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(transitions).toEqual([
      "authorize",
      "plan",
      "planning-decision:single-shot-asr:1legs",
      "queue",
      "start",
      "verify",
      "complete:pass",
    ]);
    expect(dispatchTransitions).toContain("planning-decision:single-shot-asr:1legs");
    expect(dispatchTransitions).not.toContain("verify");
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
    expect(result.dispatchLatencyMs).toBe(0);
  });

  test("a provider failure completes as FAILED (never COMPLETED)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveVoiceExecution({
      executionId: "exec-2",
      task: { kind: "transcribe-utterance", clip: "audio-corrupt" },
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle,
        dispatch: async () => ({
          kind: "failure",
          category: "invalid-request",
          message: "The audio is empty",
          retryable: false,
        }),
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions).toContain("complete:fail");
    expect(result.usage).toBeNull();
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]?.status).toBe("FAIL");
  });

  test("a missing fixture aborts BEFORE any lifecycle mutation (NOT RUN)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    await expect(
      driveVoiceExecution({
        executionId: "exec-3",
        task: { kind: "transcribe-utterance", clip: "utt-999" },
        provider: "p",
        asrModel: "m",
        ttsModel: "m",
        ports: {
          lifecycle,
          dispatch: async () => ({ kind: "success", direction: "asr", transcript: "x" }),
          now: () => new Date(1_000_000),
        },
      }),
    ).rejects.toThrow(VoiceFixtureNotMaterializedError);
    expect(transitions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The realtime voice-loop driver (bounded typed turn protocol)
// ---------------------------------------------------------------------------

function fakeTurnDispatch(options: {
  readonly replyWav?: Buffer;
  readonly failAsrAt?: number;
  readonly failTtsAt?: number;
}): {
  readonly dispatchTurn: RealtimeVoiceTurnPorts["dispatchTurn"];
  readonly asrCalls: number[];
  readonly ttsCalls: number[];
} {
  const asrCalls: number[] = [];
  const ttsCalls: number[] = [];
  const dispatchTurn: RealtimeVoiceTurnPorts["dispatchTurn"] = async (input) => {
    asrCalls.push(input.turn);
    ttsCalls.push(input.turn);
    const asr: VoiceDispatchOutcome =
      options.failAsrAt === input.turn
        ? { kind: "failure", category: "invalid-request", message: "asr failed", retryable: false }
        : { kind: "success", direction: "asr", transcript: "" };
    const tts: VoiceDispatchOutcome =
      options.failTtsAt === input.turn
        ? { kind: "failure", category: "empty-audio", message: "tts failed", retryable: true }
        : {
            kind: "success",
            direction: "tts",
            audio: {
              bytes: options.replyWav ?? synthesizeWav([{ freqHz: 440, durationMs: 200 }]),
              mimeType: "audio/wav",
              digest: "d",
            },
          };
    return { asr, tts };
  };
  return { dispatchTurn, asrCalls, ttsCalls };
}

describe("VAL-014 realtime voice-loop driver (bounded turn protocol)", () => {
  test("a healthy bounded session commits every declared turn exactly once", async () => {
    const world = realtimeLifecycle({ denyStaleResume: true });
    const { dispatchTurn, asrCalls } = fakeTurnDispatch({});
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-r1",
      sessionKey: "dlg-001",
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      lifecycle: world.lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.turns).toBe(2);
    expect(result.legDispatches).toBe(4);
    expect(asrCalls).toEqual([0, 1]);
    expect(result.turnCheckpoints.map((checkpoint) => checkpoint.turn)).toEqual([0, 1]);
    expect(result.criteria.map((c) => c.criterionId)).toEqual([
      "turn-accounting",
      "turn-order",
      "session-completion",
      "resume-continuity",
    ]);
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
    expect(result.noOpResumeReplayed).toBeNull();
    expect(world.transitions).not.toContain("wait-user");
  });

  test("the session is BOUNDED: no turn beyond the declared count is ever dispatched", async () => {
    const { dispatchTurn, asrCalls } = fakeTurnDispatch({});
    const world = realtimeLifecycle({ denyStaleResume: true });
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-r2",
      sessionKey: "dlg-001",
      provider: "dashscope",
      asrModel: "m",
      ttsModel: "m",
      lifecycle: world.lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.turns).toBe(2);
    expect(asrCalls).toEqual([0, 1]);
    expect(result.criteria.find((c) => c.criterionId === "turn-order")?.status).toBe("PASS");
  });

  test("a mid-session interruption resumes without replaying committed turns", async () => {
    const world = realtimeLifecycle({ denyStaleResume: true });
    const { dispatchTurn, asrCalls } = fakeTurnDispatch({});
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-r3",
      sessionKey: "dlg-002",
      provider: "dashscope",
      asrModel: "m",
      ttsModel: "m",
      lifecycle: world.lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.turns).toBe(2);
    // Each turn dispatched EXACTLY once across the interruption+resume.
    expect(asrCalls).toEqual([0, 1]);
    expect(world.transitions.filter((step) => step === "wait-user")).toHaveLength(1);
    expect(world.transitions.filter((step) => step === "resume")).toHaveLength(1);
    expect(world.transitions).toContain("interruption");
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
  });

  test("the stale worker's resume on the healthy RUNNING session is denied and journaled", async () => {
    const world = realtimeLifecycle({ denyStaleResume: true });
    const { dispatchTurn, asrCalls } = fakeTurnDispatch({});
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-r4",
      sessionKey: "dlg-003",
      provider: "dashscope",
      asrModel: "m",
      ttsModel: "m",
      lifecycle: world.lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.resumeDeniedEvents).toBe(1);
    expect(world.resumeDenied).toHaveLength(1);
    expect(world.resumeDenied[0]).toContain("stale-worker");
    expect(asrCalls).toEqual([0, 1]);
    const deniedCriterion = result.criteria.find((c) => c.criterionId === "stale-worker-denied");
    expect(deniedCriterion?.status).toBe("PASS");
  });

  test("a corrupted turn checkpoint is detected and NEVER trusted (honest FAILED)", async () => {
    const world = realtimeLifecycle({ denyStaleResume: true });
    const { dispatchTurn, asrCalls } = fakeTurnDispatch({});
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-r5",
      sessionKey: "dlg-005",
      provider: "dashscope",
      asrModel: "m",
      ttsModel: "m",
      lifecycle: world.lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]?.criterionId).toBe("voice-loop-session");
    expect(result.criteria[0]?.evidence[0]).toContain("turn-checkpoint-corruption");
    // Only the first turn was dispatched before the corruption was detected.
    expect(asrCalls).toEqual([0]);
  });

  test("a no-op resume after terminal replays the exact completion (idempotent)", async () => {
    const world = realtimeLifecycle({ denyStaleResume: true });
    const { dispatchTurn } = fakeTurnDispatch({});
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-r6",
      sessionKey: "dlg-004",
      provider: "dashscope",
      asrModel: "m",
      ttsModel: "m",
      lifecycle: world.lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.turns).toBe(1);
    expect(result.noOpResumeReplayed).toBe(true);
  });

  test("an ASR leg failure fails the session honestly (never completed)", async () => {
    const world = realtimeLifecycle({ denyStaleResume: true });
    const { dispatchTurn } = fakeTurnDispatch({ failAsrAt: 1 });
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-r7",
      sessionKey: "dlg-001",
      provider: "dashscope",
      asrModel: "m",
      ttsModel: "m",
      lifecycle: world.lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toContain("turn-1-asr:invalid-request");
  });

  test("an invalid TTS reply payload fails the session honestly", async () => {
    const world = realtimeLifecycle({ denyStaleResume: true });
    const { dispatchTurn } = fakeTurnDispatch({
      replyWav: voiceFixture("audio-corrupt").wav,
    });
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-r8",
      sessionKey: "dlg-001",
      provider: "dashscope",
      asrModel: "m",
      ttsModel: "m",
      lifecycle: world.lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toContain("turn-0-tts-payload-invalid");
  });

  test("an absent session fixture aborts BEFORE any lifecycle mutation (NOT RUN)", async () => {
    const world = realtimeLifecycle({ denyStaleResume: true });
    await expect(
      driveRealtimeVoiceSession({
        executionId: "exec-r9",
        sessionKey: "dlg-999",
        provider: "p",
        asrModel: "m",
        ttsModel: "m",
        lifecycle: world.lifecycle,
        ports: {
          dispatchTurn: fakeTurnDispatch({}).dispatchTurn,
          now: () => new Date(1_000_000),
        },
      }),
    ).rejects.toThrow(VoiceFixtureNotMaterializedError);
    expect(world.transitions).toEqual([]);
  });

  test("the realtime rail requirement is a surfaced constant (the exact missing access)", () => {
    expect(REALTIME_VOICE_RAIL_REQUIREMENT).toContain("realtime voice rail");
    expect(REALTIME_VOICE_RAIL_REQUIREMENT).toContain("WebSocket");
  });
});
