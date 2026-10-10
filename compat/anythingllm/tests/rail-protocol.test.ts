/**
 * PPR-026 rail protocol test — the task parsing fails closed, the
 * envelope encode/decode round-trips every rail-served kind, the
 * normalized facts extract from structured outputs, and the DETERMINISTIC
 * embeddings executor holds its properties: fixed dimension, unit norm,
 * byte-identical recomputation, and the lexical-overlap retrieval signal
 * the corpus's RAG/embedding journeys depend on.
 */

import { describe, expect, test } from "vitest";
import {
  ANYTHINGLLM_TASK_KINDS,
  ANYTHINGLLM_TURN_NAME,
  buildRailEnvelope,
  COMPLETION_TASK_KIND,
  decodeModelRequest,
  EMBEDDINGS_TASK_KIND,
  encodeModelRequest,
  parseAnythingLlmTask,
  RAIL_ENVELOPE_PREFIX,
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

describe("PPR-026 task parsing (fail closed)", () => {
  test("parses a well-formed chat task on both rails", () => {
    const task = parseAnythingLlmTask({
      kind: COMPLETION_TASK_KIND,
      edge: "anythingllm.chat.local-rail",
      role: "main",
      rail: "ollama",
      model: "zeck-local:8b",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(task?.kind).toBe(COMPLETION_TASK_KIND);
    expect(task?.kind === COMPLETION_TASK_KIND && task.rail).toBe("ollama");
  });

  test("rejects malformed tasks (no messages, empty input, wrong kind)", () => {
    expect(parseAnythingLlmTask({ kind: COMPLETION_TASK_KIND, edge: "e", model: "m", messages: [] })).toBeNull();
    expect(parseAnythingLlmTask({ kind: EMBEDDINGS_TASK_KIND, edge: "e", input: [], model: "m" })).toBeNull();
    expect(parseAnythingLlmTask({ kind: EMBEDDINGS_TASK_KIND, edge: "e", input: [""], model: "m" })).toBeNull();
    expect(parseAnythingLlmTask({ kind: "unknown.kind", edge: "e" })).toBeNull();
    expect(parseAnythingLlmTask({})).toBeNull();
  });

  test("parses the embeddings task (input array + wire shape)", () => {
    const task = parseAnythingLlmTask({
      kind: EMBEDDINGS_TASK_KIND,
      edge: "anythingllm.rag.embeddings",
      input: ["one", "two"],
      model: "zeck-deterministic-embeddings-v1",
      wire: "openai",
    });
    expect(task?.kind).toBe(EMBEDDINGS_TASK_KIND);
    expect(task?.kind === EMBEDDINGS_TASK_KIND && task.input).toEqual(["one", "two"]);
    expect(task?.kind === EMBEDDINGS_TASK_KIND && task.wire).toBe("openai");
  });

  test("the closed task-kind set is the four delegated surfaces (no image kind — the agent-skill dormant seam)", () => {
    expect(ANYTHINGLLM_TASK_KINDS).toEqual([
      "anythingllm.chat.completion",
      "anythingllm.rag.embeddings",
      "anythingllm.audio.transcribe",
      "anythingllm.audio.speech",
    ]);
  });
});

describe("PPR-026 envelope encode/decode (the rail-served kinds)", () => {
  test("chat envelopes round-trip (messages verbatim, vision detected)", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ];
    const envelope = buildRailEnvelope({
      kind: COMPLETION_TASK_KIND,
      edge: "anythingllm.chat.openai-rail",
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
    expect(request.structuredOutput?.name).toBe(ANYTHINGLLM_TURN_NAME);
  });

  test("vision content parts set the vision flag (the pinned runtime's attachment shape)", () => {
    const envelope = buildRailEnvelope({
      kind: COMPLETION_TASK_KIND,
      edge: "anythingllm.chat.openai-rail",
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

  test("speech and transcription envelopes round-trip", () => {
    const speech = decodeModelRequest(
      encodeModelRequest(
        buildRailEnvelope({
          kind: SPEECH_TASK_KIND,
          edge: "anythingllm.audio.tts-generic",
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
          edge: "anythingllm.audio.stt-generic",
          model: "glm-asr",
          fileBase64: "QUJD",
        }),
        "glm-asr",
      ),
    );
    expect(asr.kind === "transcription" && asr.fileBase64).toBe("QUJD");
  });

  test("a non-enveloped ModelRequest is rejected (never guessed)", () => {
    expect(() =>
      decodeModelRequest({ model: "m", messages: [{ role: "user", content: "bare" }] }),
    ).toThrow(/rail protocol violation/);
  });

  test("the envelope prefix is the PPR-026 protocol version", () => {
    expect(RAIL_ENVELOPE_PREFIX).toBe("anythingllm-rail/1\n");
  });
});

describe("PPR-026 normalized facts", () => {
  test("the chat turn extracts from a structured output", () => {
    const turn = turnOfStructuredOutput({
      name: ANYTHINGLLM_TURN_NAME,
      json: { content: "EASTGALE", toolCalls: [], finishReason: "stop" },
    });
    expect(turn?.content).toBe("EASTGALE");
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

describe("PPR-026 deterministic embeddings executor (the recorded supply boundary)", () => {
  test("produces fixed-dimension L2-normalized vectors", () => {
    const vector = deterministicEmbeddingOf("The lighthouse gate code is MERIDIAN-3391.");
    expect(vector).toHaveLength(DETERMINISTIC_EMBEDDINGS_DIMENSIONS);
    expect(isWellFormedEmbedding(vector).ok).toBe(true);
  });

  test("is deterministic: the same input recomputes byte-identically", () => {
    const text = "The primary gate access code is MERIDIAN-3391.";
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

  test("carries the lexical-overlap retrieval signal (the RAG journey's basis)", () => {
    const doc = deterministicEmbeddingOf(
      "The primary gate access code is MERIDIAN-3391. The gate code MERIDIAN-3391 opens the station gate.",
    );
    const matchingQuery = deterministicEmbeddingOf(
      "What is the primary gate access code of the meridian lighthouse station?",
    );
    const otherDoc = deterministicEmbeddingOf(
      "The secondary beacon frequency is 412 kilohertz, monitored by the watch officer.",
    );
    const matchScore = cosineSimilarityOf(doc, matchingQuery);
    const otherScore = cosineSimilarityOf(otherDoc, matchingQuery);
    expect(matchScore).toBeGreaterThan(otherScore);
    expect(matchScore).toBeGreaterThan(0.2);
  });

  test("tokenizes into lowercased words + bigrams", () => {
    expect(tokenize("Lighthouse Gate code")).toEqual([
      "lighthouse",
      "gate",
      "code",
      "lighthouse_gate",
      "gate_code",
    ]);
  });
});
