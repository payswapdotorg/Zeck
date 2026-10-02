/**
 * PPR-022 rail-protocol tests — the four-surface envelope protocol:
 * task parsing, encode/decode roundtrips, the normalized result-fact
 * readers, and the size mapping (pure, no I/O).
 */

import { describe, expect, test } from "vitest";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import {
  COMPLETION_TASK_KIND,
  IMAGE_TASK_KIND,
  SPEECH_TASK_KIND,
  TRANSCRIPTION_TASK_KIND,
  buildRailEnvelope,
  decodeModelRequest,
  encodeModelRequest,
  imageResultOf,
  normalizeStopReason,
  parseHermesTask,
  railFailure,
  speechResultOf,
  structuredOutputOf,
  successOutcomeOfFact,
  successOutcomeOfTurn,
  supplySizeOf,
  transcriptionResultOf,
  turnOfStructuredOutput,
} from "../harness/rail-protocol";

const COMPLETION_TASK = {
  kind: COMPLETION_TASK_KIND,
  edge: "hermes.agent-loop.main",
  role: "main",
  model: "glm-4-plus",
  messages: [
    { role: "system", content: "You are Hermes Agent." },
    { role: "user", content: "Say hi." },
  ],
  tools: [
    {
      type: "function",
      function: { name: "terminal", description: "run", parameters: { type: "object" } },
    },
  ],
  params: { temperature: 0.7, maxTokens: 2000 },
} as const;

const SPEECH_TASK = {
  kind: SPEECH_TASK_KIND,
  edge: "hermes.tool.tts-openai",
  model: "gpt-4o-mini-tts",
  input: "Hello from the proof.",
  voice: "alloy",
  responseFormat: "wav",
} as const;

const TRANSCRIPTION_TASK = {
  kind: TRANSCRIPTION_TASK_KIND,
  edge: "hermes.tool.stt-openai",
  model: "whisper-1",
  fileBase64: "AAAA",
  filename: "memo.wav",
} as const;

const IMAGE_TASK = {
  kind: IMAGE_TASK_KIND,
  edge: "hermes.tool.image-generate-openai",
  model: "gpt-image-2",
  prompt: "a teal circle icon",
  size: "1024x1024",
  n: 1,
} as const;

describe("PPR-022 task parsing (fail closed)", () => {
  test("each surface's task shape parses", () => {
    expect(parseHermesTask({ ...COMPLETION_TASK })?.kind).toBe(COMPLETION_TASK_KIND);
    expect(parseHermesTask({ ...SPEECH_TASK })?.kind).toBe(SPEECH_TASK_KIND);
    expect(parseHermesTask({ ...TRANSCRIPTION_TASK })?.kind).toBe(TRANSCRIPTION_TASK_KIND);
    expect(parseHermesTask({ ...IMAGE_TASK })?.kind).toBe(IMAGE_TASK_KIND);
  });

  test("malformed shapes return null (never a guess)", () => {
    expect(parseHermesTask({})).toBeNull();
    expect(parseHermesTask({ kind: "unknown.kind" })).toBeNull();
    expect(parseHermesTask({ ...COMPLETION_TASK, messages: [] })).toBeNull();
    expect(parseHermesTask({ ...COMPLETION_TASK, edge: "" })).toBeNull();
    expect(parseHermesTask({ ...SPEECH_TASK, input: "" })).toBeNull();
    expect(parseHermesTask({ ...TRANSCRIPTION_TASK, fileBase64: "" })).toBeNull();
    expect(parseHermesTask({ ...IMAGE_TASK, prompt: "" })).toBeNull();
  });

  test("the completion role normalizes to main|auxiliary", () => {
    const auxiliary = parseHermesTask({ ...COMPLETION_TASK, role: "auxiliary" });
    const nonsense = parseHermesTask({ ...COMPLETION_TASK, role: "nonsense" });
    expect(auxiliary?.kind === "agent-loop.completion" && auxiliary.role).toBe("auxiliary");
    expect(nonsense?.kind === "agent-loop.completion" && nonsense.role).toBe("main");
  });
});

describe("PPR-022 envelope encode/decode roundtrips", () => {
  const cases = [
    { label: "completion", task: COMPLETION_TASK },
    { label: "speech", task: SPEECH_TASK },
    { label: "transcription", task: TRANSCRIPTION_TASK },
    { label: "image", task: IMAGE_TASK },
  ] as const;

  for (const { label, task } of cases) {
    test(`the ${label} envelope roundtrips through a ModelRequest`, () => {
      const envelope = buildRailEnvelope(parseHermesTask({ ...task })!);
      const request = encodeModelRequest(envelope, "route-model");
      expect(request.model).toBe("route-model");
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0]?.role).toBe("user");
      expect(typeof request.messages[0]?.content).toBe("string");
      expect(request.structuredOutput).toBeDefined();
      const decoded = decodeModelRequest(request);
      expect(decoded.kind).toBe(envelope.kind);
    });
  }

  test("the vision flag derives from image content parts", () => {
    const visionTask = {
      ...COMPLETION_TASK,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          ],
        },
      ],
    } as const;
    const envelope = buildRailEnvelope(parseHermesTask({ ...visionTask })!);
    expect(envelope.kind === "completion" && envelope.vision).toBe(true);
  });

  test("a non-enveloped ModelRequest is rejected with a named error", () => {
    const bad: ModelRequest = {
      model: "m",
      messages: [{ role: "user", content: "not an envelope" }],
    };
    expect(() => decodeModelRequest(bad)).toThrowError(/rail protocol violation/);
  });

  test("the structured-output contract names are per-surface", () => {
    expect(structuredOutputOf("completion")?.name).toBe("hermes-agent-turn");
    expect(structuredOutputOf("speech")?.name).toBe("hermes-speech-result");
    expect(structuredOutputOf("transcription")?.name).toBe("hermes-transcription-result");
    expect(structuredOutputOf("image")?.name).toBe("hermes-image-result");
  });
});

describe("PPR-022 normalized result-fact readers", () => {
  test("the chat turn reads back from the structured output", () => {
    const outcome = successOutcomeOfTurn({
      turn: { content: "Done.", toolCalls: [], finishReason: "stop" },
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      providerLatencyMs: 42,
    });
    const turn = turnOfStructuredOutput(outcome.response.structuredOutput);
    expect(turn?.content).toBe("Done.");
    expect(turn?.finishReason).toBe("stop");
  });

  test("tool calls survive the normalization", () => {
    const outcome = successOutcomeOfTurn({
      turn: {
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "write_file", arguments: "{\"path\":\"a.txt\"}" },
          },
        ],
        finishReason: "tool_calls",
      },
      stopReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      providerLatencyMs: 42,
    });
    const turn = turnOfStructuredOutput(outcome.response.structuredOutput);
    expect(turn?.toolCalls).toHaveLength(1);
    expect(turn?.toolCalls[0]?.function.name).toBe("write_file");
  });

  test("the speech result reads back", () => {
    const outcome = successOutcomeOfFact(
      "hermes-speech-result",
      { audioBase64: "QUJD", mime: "audio/wav", format: "wav", audioBytes: 3 },
      { usage: { inputTokens: 0, outputTokens: 0 }, providerLatencyMs: 10 },
    );
    const speech = speechResultOf(outcome.response.structuredOutput);
    expect(speech?.audioBase64).toBe("QUJD");
    expect(speech?.mime).toBe("audio/wav");
  });

  test("the transcription result reads back", () => {
    const outcome = successOutcomeOfFact(
      "hermes-transcription-result",
      { text: "Proof of life.", inputTokens: 94, outputTokens: 11 },
      { usage: { inputTokens: 94, outputTokens: 11 }, providerLatencyMs: 10 },
    );
    const transcript = transcriptionResultOf(outcome.response.structuredOutput);
    expect(transcript?.text).toBe("Proof of life.");
    expect(transcript?.inputTokens).toBe(94);
  });

  test("the image result reads back", () => {
    const outcome = successOutcomeOfFact(
      "hermes-image-result",
      { imageBase64: "QUJD", mime: "image/png", size: "1024x1024" },
      { usage: { inputTokens: 0, outputTokens: 0 }, providerLatencyMs: 10 },
    );
    const image = imageResultOf(outcome.response.structuredOutput);
    expect(image?.imageBase64).toBe("QUJD");
    expect(image?.size).toBe("1024x1024");
  });

  test("a fact of the wrong name reads back null (never a cross-surface guess)", () => {
    const outcome = successOutcomeOfFact(
      "hermes-speech-result",
      { audioBase64: "QUJD", mime: "audio/wav", format: "wav" },
      { usage: { inputTokens: 0, outputTokens: 0 }, providerLatencyMs: 10 },
    );
    expect(imageResultOf(outcome.response.structuredOutput)).toBeNull();
    expect(transcriptionResultOf(outcome.response.structuredOutput)).toBeNull();
    expect(turnOfStructuredOutput(outcome.response.structuredOutput)).toBeNull();
  });
});

describe("PPR-022 wire helpers", () => {
  test("the finish-reason vocabulary maps onto the platform's stop reasons", () => {
    expect(normalizeStopReason("stop")).toBe("stop");
    expect(normalizeStopReason("length")).toBe("length");
    expect(normalizeStopReason("tool_calls")).toBe("tool-use");
    expect(normalizeStopReason("content_filter")).toBe("other");
  });

  test("the app's requested image sizes map onto the supply's supported set", () => {
    expect(supplySizeOf("1024x1024")).toBe("1024x1024");
    expect(supplySizeOf("1536x1024")).toBe("1344x768");
    expect(supplySizeOf("1024x1536")).toBe("768x1344");
    expect(supplySizeOf(undefined)).toBe("1024x1024");
    expect(supplySizeOf("weird")).toBe("1024x1024");
  });

  test("the rail failure carries the retryability policy", () => {
    const rateLimit = railFailure("rate-limit", "no", 429, 5, "custom");
    expect(rateLimit.failure.retryable).toBe(true);
    const invalid = railFailure("invalid-request", "no", 400, 5, "custom");
    expect(invalid.failure.retryable).toBe(false);
    expect(invalid.failure.providerCode).toBe("400");
  });
});
