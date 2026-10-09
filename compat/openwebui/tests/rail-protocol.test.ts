/**
 * PPR-025 rail protocol test — the task parsing fails closed, the
 * envelope encode/decode round-trips every rail-served kind, the
 * normalized facts extract from structured outputs, and the DETERMINISTIC
 * embeddings executor holds its properties: fixed dimension, unit norm,
 * byte-identical recomputation, and the lexical-overlap retrieval signal
 * the corpus's RAG/memories journeys depend on.
 */

import { describe, expect, test } from "vitest";
import {
  buildRailEnvelope,
  COMPLETION_TASK_KIND,
  decodeModelRequest,
  EMBEDDINGS_TASK_KIND,
  encodeModelRequest,
  IMAGE_TASK_KIND,
  OPENWEBUI_IMAGE_RESULT_NAME,
  OPENWEBUI_TURN_NAME,
  parseOpenWebUiTask,
  SPEECH_TASK_KIND,
  stripJsonFence,
  TRANSCRIPTION_TASK_KIND,
  turnOfStructuredOutput,
} from "../harness/rail-protocol";
import {
  cosineSimilarityOf,
  deterministicEmbeddingOf,
  DETERMINISTIC_EMBEDDINGS_DIMENSIONS,
  isWellFormedEmbedding,
  tokenize,
} from "../harness/embeddings";

describe("PPR-025 task parsing (fail closed)", () => {
  test("parses a well-formed chat task on both rails", () => {
    const task = parseOpenWebUiTask({
      kind: COMPLETION_TASK_KIND,
      edge: "openwebui.chat.local-rail",
      role: "main",
      rail: "ollama",
      model: "zeck-local:8b",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(task?.kind).toBe(COMPLETION_TASK_KIND);
    expect(task?.kind === COMPLETION_TASK_KIND && task.rail).toBe("ollama");
  });

  test("rejects malformed tasks (no messages, empty input, wrong kind)", () => {
    expect(parseOpenWebUiTask({ kind: COMPLETION_TASK_KIND, edge: "e", model: "m", messages: [] })).toBeNull();
    expect(parseOpenWebUiTask({ kind: EMBEDDINGS_TASK_KIND, edge: "e", input: [], model: "m" })).toBeNull();
    expect(parseOpenWebUiTask({ kind: EMBEDDINGS_TASK_KIND, edge: "e", input: [""], model: "m" })).toBeNull();
    expect(parseOpenWebUiTask({ kind: "unknown.kind", edge: "e" })).toBeNull();
    expect(parseOpenWebUiTask({})).toBeNull();
  });

  test("parses the embeddings task (input array + wire shape)", () => {
    const task = parseOpenWebUiTask({
      kind: EMBEDDINGS_TASK_KIND,
      edge: "openwebui.rag.embeddings",
      input: ["one", "two"],
      model: "zeck-deterministic-embeddings-v1",
      wire: "ollama",
    });
    expect(task?.kind).toBe(EMBEDDINGS_TASK_KIND);
    expect(task?.kind === EMBEDDINGS_TASK_KIND && task.input).toEqual(["one", "two"]);
    expect(task?.kind === EMBEDDINGS_TASK_KIND && task.wire).toBe("ollama");
  });
});

describe("PPR-025 envelope encode/decode (the rail-served kinds)", () => {
  test("chat envelopes round-trip (messages verbatim, vision detected)", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ];
    const envelope = buildRailEnvelope({
      kind: COMPLETION_TASK_KIND,
      edge: "openwebui.chat.openai-rail",
      role: "main",
      rail: "openai",
      model: "glm-4-plus",
      messages,
      params: { temperature: 0.3 },
    });
    expect(envelope.kind).toBe("completion");
    expect(envelope.kind === "completion" && envelope.vision).toBe(false);
    const request = encodeModelRequest(envelope, "glm-4-plus");
    const decoded = decodeModelRequest(request);
    expect(decoded.kind).toBe("completion");
    expect(decoded.kind === "completion" && decoded.messages).toEqual(messages);
    expect(request.model).toBe("glm-4-plus");
    expect(request.structuredOutput?.name).toBe(OPENWEBUI_TURN_NAME);
  });

  test("vision content parts set the vision flag (the vision route)", () => {
    const envelope = buildRailEnvelope({
      kind: COMPLETION_TASK_KIND,
      edge: "openwebui.chat.openai-rail",
      role: "main",
      rail: "openai",
      model: "glm-4.5v",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          ],
        },
      ],
    });
    expect(envelope.kind === "completion" && envelope.vision).toBe(true);
  });

  test("speech, transcription and image envelopes round-trip", () => {
    const speech = decodeModelRequest(
      encodeModelRequest(
        buildRailEnvelope({
          kind: SPEECH_TASK_KIND,
          edge: "openwebui.audio.tts-openai",
          model: "glm-tts",
          input: "hello",
          voice: "tongtong",
        }),
        "glm-tts",
      ),
    );
    expect(speech.kind === "speech" && speech.input).toBe("hello");

    const asr = decodeModelRequest(
      encodeModelRequest(
        buildRailEnvelope({
          kind: TRANSCRIPTION_TASK_KIND,
          edge: "openwebui.audio.stt-openai",
          model: "glm-asr",
          fileBase64: "QUJD",
        }),
        "glm-asr",
      ),
    );
    expect(asr.kind === "transcription" && asr.fileBase64).toBe("QUJD");

    const image = decodeModelRequest(
      encodeModelRequest(
        buildRailEnvelope({
          kind: IMAGE_TASK_KIND,
          edge: "openwebui.images.openai-generate",
          model: "glm-image",
          prompt: "a lighthouse",
          size: "512x512",
        }),
        "glm-image",
      ),
    );
    expect(image.kind === "image" && image.prompt).toBe("a lighthouse");
    expect(image.kind === "image" && image.size).toBe("512x512");
  });

  test("a non-enveloped ModelRequest is rejected (never guessed)", () => {
    expect(() =>
      decodeModelRequest({ model: "m", messages: [{ role: "user", content: "bare" }] }),
    ).toThrow(/rail protocol violation/);
  });
});

describe("PPR-025 normalized facts", () => {
  test("the chat turn extracts from a structured output", () => {
    const turn = turnOfStructuredOutput({
      name: OPENWEBUI_TURN_NAME,
      json: { content: "NORTHWIND", toolCalls: [], finishReason: "stop" },
    });
    expect(turn?.content).toBe("NORTHWIND");
    expect(turn?.finishReason).toBe("stop");
  });

  test("a foreign structured output yields null (never a guess)", () => {
    expect(turnOfStructuredOutput({ name: "other", json: {} })).toBeNull();
    expect(turnOfStructuredOutput(null)).toBeNull();
  });

  test("the deterministic fence strip normalizes GLM JSON bodies", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("PPR-025 deterministic embeddings executor (the recorded supply boundary)", () => {
  test("produces fixed-dimension L2-normalized vectors", () => {
    const vector = deterministicEmbeddingOf("The harbor gate code is MOONRISE-4413.");
    expect(vector).toHaveLength(DETERMINISTIC_EMBEDDINGS_DIMENSIONS);
    expect(isWellFormedEmbedding(vector).ok).toBe(true);
  });

  test("is deterministic: the same input recomputes byte-identically", () => {
    const text = "The primary gate access code is AURORA-7741.";
    expect(deterministicEmbeddingOf(text)).toEqual(deterministicEmbeddingOf(text));
    expect(JSON.stringify(deterministicEmbeddingOf(text))).toBe(
      JSON.stringify(deterministicEmbeddingOf(text)),
    );
  });

  test("well-formedness rejects wrong dimensions and non-normalized vectors", () => {
    expect(isWellFormedEmbedding([1, 0, 0]).ok).toBe(false);
    expect(isWellFormedEmbedding(new Array(DETERMINISTIC_EMBEDDINGS_DIMENSIONS).fill(2)).ok).toBe(
      false,
    );
  });

  test("carries the lexical-overlap retrieval signal (the RAG/memories basis)", () => {
    const doc = deterministicEmbeddingOf(
      "The primary gate access code is AURORA-7741. This code opens the northern gate.",
    );
    const matchingQuery = deterministicEmbeddingOf(
      "What is the primary gate access code of the north harbor station?",
    );
    const otherDoc = deterministicEmbeddingOf(
      "The lighthouse frequency is 412 kilohertz, monitored by the watch officer.",
    );
    const matchScore = cosineSimilarityOf(doc, matchingQuery);
    const otherScore = cosineSimilarityOf(otherDoc, matchingQuery);
    expect(matchScore).toBeGreaterThan(otherScore);
    expect(matchScore).toBeGreaterThan(0.2);
  });

  test("tokenizes into lowercased words + bigrams", () => {
    expect(tokenize("Harbor Gate code")).toEqual([
      "harbor",
      "gate",
      "code",
      "harbor_gate",
      "gate_code",
    ]);
  });
});
