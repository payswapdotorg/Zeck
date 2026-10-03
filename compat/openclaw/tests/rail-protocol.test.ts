/**
 * PPR-023 rail protocol test — both sides of the validated envelope
 * translation (encode → decode round-trips for every surface kind, the
 * fail-closed violations, the task parsing, the structured-output
 * contract names, and the size mapping).
 */

import { describe, expect, test } from "vitest";
import {
  buildRailEnvelope,
  COMPLETION_TASK_KIND,
  decodeModelRequest,
  encodeModelRequest,
  IMAGE_TASK_KIND,
  OPENCLAW_IMAGE_RESULT_NAME,
  OPENCLAW_SPEECH_RESULT_NAME,
  OPENCLAW_TRANSCRIPTION_RESULT_NAME,
  OPENCLAW_TURN_NAME,
  parseOpenClawTask,
  RAIL_ENVELOPE_PREFIX,
  SPEECH_TASK_KIND,
  structuredOutputOf,
  supplySizeOf,
  TRANSCRIPTION_TASK_KIND,
} from "../harness/rail-protocol";

const COMPLETION_TASK = {
  kind: COMPLETION_TASK_KIND,
  edge: "openclaw.agent-loop.main",
  role: "main" as const,
  model: "glm-4-plus",
  messages: [
    { role: "system", content: "You are an agent." },
    { role: "user", content: "Run the tests." },
  ],
  tools: [
    {
      type: "function",
      function: { name: "exec", description: "run a command", parameters: { type: "object" } },
    },
  ],
  params: { temperature: 0.2, maxTokens: 512 },
};

describe("PPR-023 rail protocol", () => {
  test("the envelope prefix is version-pinned", () => {
    expect(RAIL_ENVELOPE_PREFIX).toBe("openclaw-rail/1\n");
  });

  test("the structured-output contract names are pinned", () => {
    expect(OPENCLAW_TURN_NAME).toBe("openclaw-agent-turn");
    expect(OPENCLAW_SPEECH_RESULT_NAME).toBe("openclaw-speech-result");
    expect(OPENCLAW_TRANSCRIPTION_RESULT_NAME).toBe("openclaw-transcription-result");
    expect(OPENCLAW_IMAGE_RESULT_NAME).toBe("openclaw-image-result");
  });

  test("a completion task round-trips through the envelope", () => {
    const task = parseOpenClawTask(COMPLETION_TASK);
    expect(task).not.toBeNull();
    const envelope = buildRailEnvelope(task!);
    expect(envelope.kind).toBe("completion");
    const encoded = encodeModelRequest(envelope, "glm-4-plus");
    expect(encoded.model).toBe("glm-4-plus");
    expect(encoded.messages).toHaveLength(1);
    expect((encoded.messages[0] as { role: string }).role).toBe("user");
    const decoded = decodeModelRequest(encoded);
    expect(decoded.kind).toBe("completion");
    if (decoded.kind === "completion") {
      expect(decoded.messages).toHaveLength(2);
      expect(decoded.tools).toHaveLength(1);
      expect(decoded.vision).toBe(false);
      expect(decoded.params?.temperature).toBe(0.2);
    }
  });

  test("a vision-carrying completion round-trips with vision=true", () => {
    const task = parseOpenClawTask({
      ...COMPLETION_TASK,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    const envelope = buildRailEnvelope(task!);
    expect(envelope.kind === "completion" && envelope.vision).toBe(true);
    const decoded = decodeModelRequest(encodeModelRequest(envelope, "glm-4.5v"));
    expect(decoded.kind === "completion" && decoded.vision).toBe(true);
  });

  test("a speech task round-trips", () => {
    const task = parseOpenClawTask({
      kind: SPEECH_TASK_KIND,
      edge: "openclaw.tool.tts-openai",
      model: "glm-tts",
      input: "The compatibility proof is alive and speaking.",
      voice: "tongtong",
      responseFormat: "wav",
    });
    expect(task).not.toBeNull();
    const decoded = decodeModelRequest(
      encodeModelRequest(buildRailEnvelope(task!), "glm-tts"),
    );
    expect(decoded.kind).toBe("speech");
    if (decoded.kind === "speech") {
      expect(decoded.input).toBe("The compatibility proof is alive and speaking.");
      expect(decoded.voice).toBe("tongtong");
      expect(decoded.responseFormat).toBe("wav");
    }
  });

  test("a transcription task round-trips", () => {
    const task = parseOpenClawTask({
      kind: TRANSCRIPTION_TASK_KIND,
      edge: "openclaw.media-understanding.audio",
      model: "glm-asr",
      fileBase64: "UklGRiQ=",
      filename: "memo.wav",
      language: "en",
    });
    expect(task).not.toBeNull();
    const decoded = decodeModelRequest(
      encodeModelRequest(buildRailEnvelope(task!), "glm-asr"),
    );
    expect(decoded.kind).toBe("transcription");
    if (decoded.kind === "transcription") {
      expect(decoded.fileBase64).toBe("UklGRiQ=");
      expect(decoded.filename).toBe("memo.wav");
      expect(decoded.language).toBe("en");
    }
  });

  test("an image task round-trips", () => {
    const task = parseOpenClawTask({
      kind: IMAGE_TASK_KIND,
      edge: "openclaw.tool.image-generate-openai",
      model: "glm-image",
      prompt: "A simple flat orange square icon on a white background.",
      size: "1024x1024",
      n: 1,
    });
    expect(task).not.toBeNull();
    const decoded = decodeModelRequest(
      encodeModelRequest(buildRailEnvelope(task!), "glm-image"),
    );
    expect(decoded.kind).toBe("image");
    if (decoded.kind === "image") {
      expect(decoded.prompt).toContain("orange square");
      expect(decoded.size).toBe("1024x1024");
      expect(decoded.n).toBe(1);
    }
  });

  test("the structured-output contract selects by envelope kind", () => {
    expect(structuredOutputOf("completion")?.name).toBe(OPENCLAW_TURN_NAME);
    expect(structuredOutputOf("speech")?.name).toBe(OPENCLAW_SPEECH_RESULT_NAME);
    expect(structuredOutputOf("transcription")?.name).toBe(OPENCLAW_TRANSCRIPTION_RESULT_NAME);
    expect(structuredOutputOf("image")?.name).toBe(OPENCLAW_IMAGE_RESULT_NAME);
  });

  test("decodeModelRequest fails closed on a non-enveloped message", () => {
    expect(() =>
      decodeModelRequest({
        model: "glm-4-plus",
        messages: [{ role: "user", content: "bare message" }],
      }),
    ).toThrow(/rail protocol violation/);
  });

  test("decodeModelRequest fails closed on an unknown envelope kind", () => {
    expect(() =>
      decodeModelRequest({
        model: "glm-4-plus",
        messages: [{ role: "user", content: `${RAIL_ENVELOPE_PREFIX}{"kind":"unknown"}` }],
      }),
    ).toThrow(/unknown envelope kind/);
  });

  test("parseOpenClawTask fails closed on malformed task shapes", () => {
    expect(parseOpenClawTask({ kind: "nonsense" })).toBeNull();
    expect(parseOpenClawTask({ kind: COMPLETION_TASK_KIND, edge: "", model: "m", messages: [{}] })).toBeNull();
    expect(
      parseOpenClawTask({ kind: COMPLETION_TASK_KIND, edge: "e", model: "", messages: [{ role: "user" }] }),
    ).toBeNull();
    expect(
      parseOpenClawTask({
        kind: COMPLETION_TASK_KIND,
        edge: "e",
        model: "m",
        messages: [],
      }),
    ).toBeNull();
    expect(
      parseOpenClawTask({ kind: SPEECH_TASK_KIND, edge: "e", model: "m", input: "" }),
    ).toBeNull();
    expect(
      parseOpenClawTask({ kind: TRANSCRIPTION_TASK_KIND, edge: "e", model: "m", fileBase64: "" }),
    ).toBeNull();
    expect(parseOpenClawTask({ kind: IMAGE_TASK_KIND, edge: "e", model: "m", prompt: "" })).toBeNull();
  });

  test("the requested image size maps onto the supply's supported sizes", () => {
    expect(supplySizeOf(undefined)).toBe("1024x1024");
    expect(supplySizeOf("1024x1024")).toBe("1024x1024");
    expect(supplySizeOf("1792x1024")).toBe("1344x768");
    expect(supplySizeOf("1024x1792")).toBe("768x1344");
    expect(supplySizeOf("768x1344")).toBe("768x1344");
    expect(supplySizeOf("weird")).toBe("1024x1024");
  });
});
