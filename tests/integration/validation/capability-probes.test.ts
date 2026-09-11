/**
 * VAL-009 acceptance criterion 2 — the REAL readiness probe executor.
 *
 * For every provider whose credential exists in the environment, this
 * suite executes a minimal REAL authenticated invocation and records
 * the outcome through the secret-free contract. Providers without
 * credentials are SKIPPED WITH REASON (an absent credential is a NOT
 * RUN boundary — never a failure, never a pass).
 *
 * Proven invocations (2026-09-11 diagnostics, recorded in
 * docs/work-items/VAL-009.md): OpenRouter routes open-weights models
 * from this environment (geo-gated flagship routes excluded) — the
 * text probe uses an open-weights chat model and the VLM probe sends
 * a generated 1x1 white PNG, asserting the vision round trip. The
 * OpenAI probe classifies the observed region block; the qwen and
 * BytePlus/Seedance probes record the unresolved-endpoint gaps.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  type ProbeResult,
  probePlans,
  validateProbeResult,
} from "../../../benchmarks/validation/capabilities";

/** A minimal VALID 1x1 white PNG (correct CRCs, constructed in-code). */
function whitePixelPngBase64(): string {
  const crcOf = (bytes: Buffer): Buffer => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return out;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBuffer = Buffer.from(type, "latin1");
    return Buffer.concat([length, typeBuffer, data, crcOf(Buffer.concat([typeBuffer, data]))]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0x00, 0xff, 0xff, 0xff]));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

interface ProbeSpec {
  readonly provider: string;
  readonly credentialEnvVar: string;
  readonly run: (apiKey: string) => Promise<ProbeResult>;
}

function classifyFromStatus(
  status: number,
  body: string,
): "auth-rejected" | "region-blocked" | "quota-exhausted" | "provider-error" {
  if (status === 401) {
    return "auth-rejected";
  }
  if (status === 403) {
    if (/region|country|territory|geo/i.test(body)) {
      return "region-blocked";
    }
    return "auth-rejected";
  }
  if (status === 429) {
    return "quota-exhausted";
  }
  return "provider-error";
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  started: number,
  provider: string,
  credentialEnvVar: string,
): Promise<ProbeResult> {
  try {
    const response = await globalThis.fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const text = await response.text();
    const base = {
      provider,
      credentialEnvVar,
      at: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
    if (response.ok) {
      return { ...base, outcome: "ready", detail: `HTTP 200 — ${new URL(url).host}` };
    }
    return {
      ...base,
      outcome: "failed",
      failure: classifyFromStatus(response.status, text.slice(0, 200)),
      detail: `HTTP ${response.status} — ${new URL(url).host}`,
    };
  } catch (error) {
    return {
      provider,
      credentialEnvVar,
      at: new Date().toISOString(),
      outcome: "failed",
      failure: "network-error",
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message.slice(0, 100) : "network error",
    };
  }
}

const OPENROUTER_TEXT_MODEL = "qwen/qwen-2.5-7b-instruct";
const OPENROUTER_VLM_MODEL = "qwen/qwen3-vl-8b-instruct";
const TINY_PROMPT = { role: "user" as const, content: "Reply with the single word: ready" };

const specs: readonly ProbeSpec[] = [
  {
    provider: "openrouter",
    credentialEnvVar: "OPENROUTER_API_KEY",
    async run(apiKey) {
      const started = Date.now();
      return postJson(
        "https://openrouter.ai/api/v1/chat/completions",
        apiKey,
        { model: OPENROUTER_TEXT_MODEL, messages: [TINY_PROMPT], max_tokens: 5 },
        started,
        "openrouter",
        "OPENROUTER_API_KEY",
      );
    },
  },
  {
    provider: "openrouter",
    credentialEnvVar: "OPENROUTER_API_KEY",
    async run(apiKey) {
      const started = Date.now();
      return postJson(
        "https://openrouter.ai/api/v1/chat/completions",
        apiKey,
        {
          model: OPENROUTER_VLM_MODEL,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "One word: what color is this image?" },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${whitePixelPngBase64()}` },
                },
              ],
            },
          ],
          max_tokens: 10,
        },
        started,
        "openrouter",
        "OPENROUTER_API_KEY",
      );
    },
  },
  {
    provider: "openai",
    credentialEnvVar: "OPENAI_API_KEY",
    async run(apiKey) {
      const started = Date.now();
      return postJson(
        "https://api.openai.com/v1/chat/completions",
        apiKey,
        { model: "gpt-4o-mini", messages: [TINY_PROMPT], max_tokens: 5 },
        started,
        "openai",
        "OPENAI_API_KEY",
      );
    },
  },
  {
    provider: "qwen",
    credentialEnvVar: "QWEN_API_KEY",
    async run(apiKey) {
      const started = Date.now();
      return postJson(
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        apiKey,
        { model: "qwen-plus", messages: [TINY_PROMPT], max_tokens: 5 },
        started,
        "qwen",
        "QWEN_API_KEY",
      );
    },
  },
  {
    provider: "byteplus-ark",
    credentialEnvVar: "BYTEPLUS_ARK_API_KEY",
    async run(apiKey) {
      const started = Date.now();
      return postJson(
        "https://ark.ap-southeast-1.bytepluses.com/api/v3/chat/completions",
        apiKey,
        { model: "doubao-seed-1-6-lite-250815", messages: [TINY_PROMPT] },
        started,
        "byteplus-ark",
        "BYTEPLUS_ARK_API_KEY",
      );
    },
  },
  {
    provider: "seedance",
    credentialEnvVar: "SEEDANCE_API_KEY",
    async run(apiKey) {
      const started = Date.now();
      return postJson(
        "https://ark.ap-southeast-1.bytepluses.com/api/v3/chat/completions",
        apiKey,
        { model: "seedance-lite-v1", messages: [TINY_PROMPT] },
        started,
        "seedance",
        "SEEDANCE_API_KEY",
      );
    },
  },
];

describe("validation: real provider readiness probes (VAL-009 AC2)", () => {
  test("the probe plans match the provider registry", () => {
    const registry = new Set(probePlans().map((plan) => plan.provider.provider));
    for (const spec of specs) {
      expect(registry.has(spec.provider)).toBe(true);
    }
  });

  for (const spec of specs) {
    test(`${spec.provider}${spec.run.name !== "" ? ` (${spec.credentialEnvVar})` : ""}: minimal authenticated invocation (NOT RUN when the credential is absent)`, async () => {
      const apiKey = process.env[spec.credentialEnvVar];
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        console.info(`[VAL-009] NOT RUN: ${spec.provider} — set ${spec.credentialEnvVar}`);
        return;
      }
      const result = await spec.run(apiKey);
      console.info(`[VAL-009] ${JSON.stringify(result)}`);
      expect(validateProbeResult(result)).toEqual([]);
      expect(["ready", "failed"]).toContain(result.outcome);
    });
  }
});
