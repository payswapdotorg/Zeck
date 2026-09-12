/**
 * VAL-014 acceptance criterion 6 — discrimination tests proving the
 * voice derivations against controlled fakes:
 *
 *   * fixture digest mismatches (a tampered/swapped materialization is
 *     detected and the run fails BEFORE any network effect);
 *   * wrong-modality requests (a task whose direction has no configured
 *     rail is rejected BEFORE any network effect — including a
 *     roundtrip with only one of its two legs);
 *   * provider failures (a REAL dashscope-shaped 400 on genuinely
 *     corrupted audio; a rate-limit; a TTS 200 with no audio payload)
 *     fail the execution honestly — never a fabricated completion;
 *   * empty TTS text is rejected BEFORE any network effect (the
 *     malformed-input discrimination; never dispatched, never retried);
 *   * oracle provenance (a successful roundtrip whose transcript misses
 *     the phrase's ground-truth term fails its criterion — no
 *     provider-success shortcut);
 *   * an ASR 200 with an empty transcript is an honest success with an
 *     empty transcript (silence-legitimate, never fabricated either
 *     way);
 *   * payload isolation (the ASR rail receives audio data URIs; the
 *     TTS rail receives text + voice; the roundtrip's ASR leg receives
 *     EXACTLY the TTS leg's synthesized bytes);
 *   * the corrupted turn checkpoint is detected and NEVER trusted (the
 *     realtime session fails honestly).
 */

import { describe, expect, test, vi } from "vitest";
import {
  mediaDigest,
  phraseFixture,
  synthesizeWav,
  voiceFixture,
} from "../../benchmarks/validation/apps/shared/media";
import type { VoiceLifecyclePort } from "../../benchmarks/validation/platform/voice";
import {
  createDashscopeVoiceRail,
  createVoiceDispatchBinding,
  deriveVoiceVerification,
  driveRealtimeVoiceSession,
  driveVoiceExecution,
  type HttpTransport,
  toDataUri,
} from "../../benchmarks/validation/platform/voice";

const UTT_TASK = { kind: "transcribe-utterance", clip: "utt-001" } as const;
const ROUNDTRIP_TASK = {
  kind: "transcribe-roundtrip",
  phrase: "phrase-001",
  voice: "Cherry",
} as const;
const TTS_TASK = { kind: "synthesize-speech", phrase: "phrase-002", voice: "Cherry" } as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function countingTransport(response: () => Response): {
  readonly transport: HttpTransport;
  readonly calls: { url: string; method: string; body: unknown }[];
} {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return response();
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
    async recordPlanningDecision() {
      transitions.push("planning-decision");
    },
    async complete({ verdict }) {
      transitions.push(`complete:${verdict}`);
    },
  };
  return { lifecycle, transitions };
}

describe("voice validation discrimination (VAL-014 AC6)", () => {
  test("a tampered fixture materialization fails the run before ANY network effect", async () => {
    const { transport, calls } = countingTransport(() =>
      jsonResponse(200, {
        output: { choices: [{ message: { content: [{ text: "anything" }] } }] },
      }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const binding = createVoiceDispatchBinding({
      asr: rail,
      tts: rail,
      // The controlled fake: the materialization layer returns different
      // bytes (and digest) than the plan derived — the swap is detected.
      materializeClip: (key) => ({
        key,
        digest: "deadbeefdeadbeef",
        bytes: voiceFixture("cmd-002").wav,
        annotation: "tampered",
      }),
      transportCalls: { count: 0 },
    });
    const result = await driveVoiceExecution({
      executionId: "exec-digest",
      task: UTT_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0);
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:fixture-digest-mismatch");
  });

  test("a wrong-modality request (transcribe row, TTS-only rails) fails before ANY network effect", async () => {
    const { transport, calls } = countingTransport(() =>
      jsonResponse(200, { output: { choices: [{ message: { content: "" } }] } }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    // Only the TTS rail is configured: transcribe rows must be rejected.
    const binding = createVoiceDispatchBinding({ tts: rail, transportCalls: { count: 0 } });
    const result = await driveVoiceExecution({
      executionId: "exec-modality",
      task: UTT_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0);
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:wrong-modality");
  });

  test("a roundtrip with only the ASR rail fails before ANY network effect (both legs required)", async () => {
    const { transport, calls } = countingTransport(() =>
      jsonResponse(200, { output: { choices: [{ message: { content: "" } }] } }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const binding = createVoiceDispatchBinding({ asr: rail, transportCalls: { count: 0 } });
    const result = await driveVoiceExecution({
      executionId: "exec-roundtrip-modality",
      task: ROUNDTRIP_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0);
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:wrong-modality");
  });

  test("a REAL dashscope-shaped 400 on corrupted audio fails the execution (never completed)", async () => {
    // The exact provider response shape a corrupted WAV produces on the
    // dashscope-international dedicated ASR task API: HTTP 400 with the
    // dashscope-native error body.
    const { transport, calls } = countingTransport(() =>
      jsonResponse(400, {
        code: "InvalidParameter",
        message: "The audio format is invalid",
        request_id: "disc-1",
      }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const binding = createVoiceDispatchBinding({
      asr: rail,
      tts: rail,
      transportCalls: { count: 0 },
    });
    const result = await driveVoiceExecution({
      executionId: "exec-corrupt",
      task: { kind: "transcribe-utterance", clip: "audio-corrupt" },
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.usage).toBeNull();
    // The dispatched payload WAS the genuine corrupt fixture bytes.
    const body = calls[0]?.body as {
      input: { messages: { content: Record<string, string>[] }[] };
    };
    const sent = body.input.messages[0]?.content[0]?.audio ?? "";
    expect(sent).toBe(toDataUri(voiceFixture("audio-corrupt").wav, "audio/wav"));
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:invalid-request");
    expect(result.criteria[0]?.evidence).toContain("retryable:false");
  });

  test("empty TTS text is refused before ANY network effect (and never retried)", async () => {
    const { transport, calls } = countingTransport(() => jsonResponse(200, {}));
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const binding = createVoiceDispatchBinding({
      asr: rail,
      tts: rail,
      transportCalls: { count: 0 },
      retry: { attempts: 5, delayMs: 0, sleep: async () => {} },
    });
    const result = await driveVoiceExecution({
      executionId: "exec-empty-text",
      task: { kind: "synthesize-speech", phrase: "phrase-blank", voice: "Cherry" },
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0);
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:empty-text");
    expect(result.criteria[0]?.evidence).toContain("retryable:false");
  });

  test("a rate-limit provider failure is honestly classified retryable and fails the run", async () => {
    const { transport } = countingTransport(() =>
      jsonResponse(429, { code: "Throttling", message: "Requests rate limited" }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const binding = createVoiceDispatchBinding({
      asr: rail,
      tts: rail,
      transportCalls: { count: 0 },
    });
    const result = await driveVoiceExecution({
      executionId: "exec-rate",
      task: UTT_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence).toContain("provider-failure:rate-limit");
    expect(result.criteria[0]?.evidence).toContain("retryable:true");
  });

  test("a 'successful' TTS response with no audio payload still fails (no fabricated payload)", async () => {
    const { transport, calls } = countingTransport(() =>
      jsonResponse(200, {
        status_code: 200,
        request_id: "r",
        output: { finish_reason: "stop", audio: { data: "", url: "" } },
        usage: { characters: 5 },
      }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const binding = createVoiceDispatchBinding({
      asr: rail,
      tts: rail,
      transportCalls: { count: 0 },
    });
    const result = await driveVoiceExecution({
      executionId: "exec-empty-audio",
      task: TTS_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:empty-audio");
    expect(calls).toHaveLength(1);
  });

  test("an ASR 200 with an empty transcript is an honest success (silence-legitimate, no fabrication either way)", async () => {
    const { transport } = countingTransport(() =>
      jsonResponse(200, {
        output: { choices: [{ message: { role: "assistant", content: [{ text: "" }] } }] },
        usage: { seconds: 1 },
      }),
    );
    const rail = createDashscopeVoiceRail({ transport, apiKey: "k" });
    const binding = createVoiceDispatchBinding({
      asr: rail,
      tts: rail,
      transportCalls: { count: 0 },
    });
    const result = await driveVoiceExecution({
      executionId: "exec-silence",
      task: UTT_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria[0]?.status).toBe("PASS");
    expect(result.criteria[0]?.evidence.join(" ")).toContain("transcriptChars:0");
  });

  test("oracle provenance: a successful roundtrip missing the phrase term fails its criterion", () => {
    // The dispatch SUCCEEDED (a transcript arrived) but the transcript
    // contradicts the phrase fixture's ground truth — the mechanical
    // oracle fails the run; there is no success shortcut.
    const criteria = deriveVoiceVerification(ROUNDTRIP_TASK, {
      kind: "success",
      direction: "asr",
      transcript: "Hello there, nice weather today.",
    });
    expect(criteria.map((c) => c.status)).toEqual(["FAIL", "PASS"]);
    const anyFail = criteria.some((c) => c.status === "FAIL");
    expect(anyFail).toBe(true);
  });

  test("payload isolation: the ASR leg receives audio data URIs; the TTS leg receives text; the roundtrip ASR receives EXACTLY the TTS bytes", async () => {
    const wav = synthesizeWav([{ freqHz: 500, durationMs: 400 }]);
    const seen = { asr: [] as string[], tts: [] as { text: string; voice: string }[] };
    const rail = {
      railId: "controlled",
      async transcribe(input: { audioDataUri: string }) {
        seen.asr.push(input.audioDataUri);
        return { kind: "success" as const, direction: "asr" as const, transcript: "meeting" };
      },
      async synthesize(input: { text: string; voice: string }) {
        seen.tts.push({ text: input.text, voice: input.voice });
        return {
          kind: "success" as const,
          direction: "tts" as const,
          audio: { bytes: wav, mimeType: "audio/wav", digest: mediaDigest(wav) },
        };
      },
    };
    const binding = createVoiceDispatchBinding({
      asr: rail,
      tts: rail,
      transportCalls: { count: 0 },
    });
    await binding({
      executionId: "e1",
      task: UTT_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
    });
    expect(seen.asr[0]?.startsWith("data:audio/wav;base64,")).toBe(true);
    await binding({
      executionId: "e2",
      task: TTS_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
    });
    expect(seen.tts[0]?.text).toBe(phraseFixture("phrase-002").text);
    expect(seen.tts[0]?.voice).toBe("Cherry");
    await binding({
      executionId: "e3",
      task: ROUNDTRIP_TASK,
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
    });
    // The roundtrip's ASR leg received EXACTLY the TTS leg's bytes.
    expect(seen.asr[1]).toBe(toDataUri(wav, "audio/wav"));
    expect(seen.tts[1]?.text).toBe(phraseFixture("phrase-001").text);
  });

  test("a corrupted turn checkpoint is detected and NEVER trusted (the session fails honestly)", async () => {
    const transitions: string[] = [];
    const lifecycle = {
      async transition(command: { readonly step: string; readonly callKey: string }) {
        transitions.push(command.step);
      },
      async recordPlanningDecision() {
        transitions.push("planning-decision");
      },
      async recordTurnCheckpoint(input: {
        readonly turn: number;
        readonly digest: string;
        readonly callKey: string;
      }) {
        transitions.push(`turn-checkpoint:${input.turn}`);
      },
      async recordInterruption() {
        transitions.push("interruption");
      },
      async recordResumeDenied() {
        transitions.push("resume-denied");
      },
      async complete(_input: { readonly callKey: string }) {
        transitions.push("complete");
      },
      async attemptNoOpResume() {
        return { replayed: false };
      },
    };
    const dispatchTurn = vi.fn(async () => ({
      asr: { kind: "success" as const, direction: "asr" as const, transcript: "" },
      tts: {
        kind: "success" as const,
        direction: "tts" as const,
        audio: {
          bytes: synthesizeWav([{ freqHz: 440, durationMs: 200 }]),
          mimeType: "audio/wav",
          digest: "d",
        },
      },
    }));
    const result = await driveRealtimeVoiceSession({
      executionId: "exec-turn-corrupt",
      sessionKey: "dlg-005",
      provider: "dashscope",
      asrModel: "qwen3-asr-flash",
      ttsModel: "qwen3-tts-flash",
      lifecycle,
      ports: { dispatchTurn, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toContain("turn-checkpoint-corruption");
    // Only the first turn's legs were dispatched before detection.
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    // Evidence never carries payload bytes.
    const evidence = result.criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).not.toContain("base64");
  });
});
