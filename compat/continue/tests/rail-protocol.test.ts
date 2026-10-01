/**
 * PPR-021 rail protocol tests — both sides of the translation between
 * the rail worker and the supply rail, pinned (the disclosed protocol
 * of compat/continue/harness/rail-protocol.ts).
 */

import { describe, expect, it } from "vitest";
import {
  buildRailEnvelope,
  CONTINUE_EMBEDDINGS_NAME,
  CONTINUE_RERANK_NAME,
  CONTINUE_TURN_NAME,
  decodeModelRequest,
  encodeModelRequest,
  embeddingsOfStructuredOutput,
  hasImagePart,
  parseContinueRailTask,
  rerankScoresOfStructuredOutput,
  turnOfStructuredOutput,
  type ContinueRailTask,
} from "../harness/rail-protocol";
import { CONTINUE_ROLE_MODELS } from "../adapter/edges";

const CHAT_TASK: ContinueRailTask = {
  kind: "continue-role.chat-completions",
  edge: "continue.cli.agent-loop.chat",
  role: "main",
  model: CONTINUE_ROLE_MODELS.chat,
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Say hello." },
  ],
  tools: [
    {
      type: "function",
      function: { name: "Bash", description: "Run a command", parameters: { type: "object" } },
    },
  ],
  params: { maxTokens: 512 },
};

describe("task payload validation (fail closed on shape)", () => {
  it("parses a well-formed chat-completions task", () => {
    const task = parseContinueRailTask({
      kind: "continue-role.chat-completions",
      edge: "continue.cli.agent-loop.chat",
      role: "main",
      model: "zeck-chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "Bash" } }],
    });
    expect(task).not.toBeNull();
    expect(task?.kind).toBe("continue-role.chat-completions");
    expect(task?.tools?.length).toBe(1);
  });

  it("rejects a chat task without messages", () => {
    expect(
      parseContinueRailTask({
        kind: "continue-role.chat-completions",
        edge: "e",
        model: "zeck-chat",
        messages: [],
      }),
    ).toBeNull();
  });

  it("parses the completions (autocomplete) task and rejects an empty prompt", () => {
    const task = parseContinueRailTask({
      kind: "continue-role.completions",
      edge: "continue.core.autocomplete.tab",
      role: "main",
      model: CONTINUE_ROLE_MODELS.autocomplete,
      prompt: "const PAI",
      suffix: "];",
    });
    expect(task?.prompt).toBe("const PAI");
    expect(task?.suffix).toBe("];");
    expect(
      parseContinueRailTask({
        kind: "continue-role.completions",
        edge: "e",
        model: "m",
        prompt: "",
      }),
    ).toBeNull();
  });

  it("parses the embeddings task and rejects non-string inputs", () => {
    const task = parseContinueRailTask({
      kind: "continue-role.embeddings",
      edge: "continue.core.indexing.embed",
      role: "auxiliary",
      model: CONTINUE_ROLE_MODELS.embed,
      input: ["chunk one", "chunk two"],
    });
    expect(task?.input?.length).toBe(2);
    expect(
      parseContinueRailTask({
        kind: "continue-role.embeddings",
        edge: "e",
        model: "m",
        input: [42],
      }),
    ).toBeNull();
  });

  it("parses the rerank task and rejects a missing query", () => {
    const task = parseContinueRailTask({
      kind: "continue-role.rerank",
      edge: "continue.core.retrieval.rerank",
      role: "auxiliary",
      model: CONTINUE_ROLE_MODELS.rerank,
      query: "capital of France?",
      documents: ["Paris is the capital.", " unrelated"],
    });
    expect(task?.documents?.length).toBe(2);
    expect(
      parseContinueRailTask({
        kind: "continue-role.rerank",
        edge: "e",
        model: "m",
        query: "",
        documents: ["a"],
      }),
    ).toBeNull();
  });

  it("rejects an unknown task kind", () => {
    expect(parseContinueRailTask({ kind: "unknown", edge: "e", model: "m" })).toBeNull();
  });
});

describe("the request envelope (worker → ModelRequest → rail adapter)", () => {
  it("round-trips a task through encodeModelRequest/decodeModelRequest verbatim", () => {
    const envelope = buildRailEnvelope(CHAT_TASK);
    const request = encodeModelRequest(envelope, "glm-4-plus");
    expect(request.model).toBe("glm-4-plus");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.structuredOutput?.name).toBe(CONTINUE_TURN_NAME);
    const decoded = decodeModelRequest(request);
    expect(decoded.vision).toBe(false);
    expect(decoded.task.model).toBe(CHAT_TASK.model);
    expect(decoded.task.tools?.[0]?.function.name).toBe("Bash");
  });

  it("flags vision when a chat message carries image content parts", () => {
    const visionTask: ContinueRailTask = {
      ...CHAT_TASK,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    };
    expect(buildRailEnvelope(visionTask).vision).toBe(true);
    expect(hasImagePart(visionTask.messages?.[0])).toBe(true);
    expect(hasImagePart({ role: "user", content: "plain text" })).toBe(false);
  });

  it("fails closed on a non-enveloped request", () => {
    expect(() =>
      decodeModelRequest({
        model: "m",
        messages: [{ role: "user", content: "not an envelope" }],
      }),
    ).toThrow(/rail protocol violation/);
  });
});

describe("the response normalizations (adapter → ledger fact shapes)", () => {
  it("normalizes a structured turn", () => {
    const turn = turnOfStructuredOutput({
      name: CONTINUE_TURN_NAME,
      json: {
        content: "Hello!",
        toolCalls: [
          { id: "call_1", type: "function", function: { name: "Bash", arguments: "{}" } },
        ],
        finishReason: "tool_calls",
      },
    });
    expect(turn?.content).toBe("Hello!");
    expect(turn?.toolCalls.length).toBe(1);
    expect(turn?.finishReason).toBe("tool_calls");
    expect(turnOfStructuredOutput({ name: "other", json: {} })).toBeNull();
  });

  it("normalizes embeddings and rerank structured results", () => {
    expect(
      embeddingsOfStructuredOutput({
        name: CONTINUE_EMBEDDINGS_NAME,
        json: { vectors: [[0.1, 0.2], [0.3, 0.4]] },
      }),
    ).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(
      embeddingsOfStructuredOutput({ name: CONTINUE_EMBEDDINGS_NAME, json: { vectors: "x" } }),
    ).toBeNull();
    expect(
      rerankScoresOfStructuredOutput({ name: CONTINUE_RERANK_NAME, json: { scores: [0.9, 0.1] } }),
    ).toEqual([0.9, 0.1]);
    expect(
      rerankScoresOfStructuredOutput({ name: CONTINUE_RERANK_NAME, json: { scores: [1, "x"] } }),
    ).toBeNull();
  });
});
