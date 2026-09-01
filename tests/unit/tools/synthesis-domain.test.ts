/**
 * Unit tests — synthesized-program domain (WORK-018, TOL-004).
 *
 * Proves the intended behavior AND the protected negative cases of
 * the fail-closed synthesis vocabulary: request validation (source
 * bounds, raw-secret scan, full tool-contract validation, synth-
 * identity prefix, language vocabulary, test-case shapes, expiry),
 * the lifecycle transition table, content addressing determinism,
 * output parsing, and the v1 language-subset scan.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { SynthesisRequest, ToolContract } from "../../../src/modules/tools/public";
import {
  canonicalSynthesisJson,
  parseSynthesizedOutput,
  SYNTHESIS_FORBIDDEN_SOURCE_TOKENS,
  SYNTHESIZED_PROGRAM_TRANSITIONS,
  SYNTHESIZED_TOOL_ID_PATTERN,
  scanLanguageSubset,
  synthesisSubmissionFingerprint,
  validateSynthesisRequest,
} from "../../../src/modules/tools/public";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

function contract(overrides: Partial<ToolContract> = {}): ToolContract {
  return {
    toolId: "synth-doubler",
    version: "1.0.0",
    capability: { id: "arithmetic", kind: "tool", minVersion: "1.0.0" },
    inputSchema: { fields: [{ name: "value", type: "number", required: true }] },
    outputSchema: { fields: [{ name: "doubled", type: "number", required: true }] },
    execution: { deterministic: true, timeoutMs: 5000, idempotent: true },
    sideEffect: "none",
    network: { egress: "none", hosts: [] },
    secrets: { access: "none", refs: [] },
    cost: { estimatedMicroUsd: "0" },
    evidence: { producesArtifacts: false },
    ...overrides,
  };
}

function request(overrides: Partial<SynthesisRequest> = {}): SynthesisRequest {
  return {
    source: "const input = JSON.parse(process.envInput);",
    language: "javascript",
    contract: contract(),
    testCases: [
      { name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } },
      { name: "doubles-zero", input: { value: 0 }, expectedOutput: { doubled: 0 } },
    ],
    expiresAt: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("synthesized-program request validation (fail-closed)", () => {
  test("a well-formed request passes", () => {
    expect(validateSynthesisRequest(request()).valid).toBe(true);
  });

  test("non-object requests are rejected", () => {
    expect(validateSynthesisRequest(null).valid).toBe(false);
    expect(validateSynthesisRequest("nope").valid).toBe(false);
    expect(validateSynthesisRequest([]).valid).toBe(false);
  });

  test("empty and over-bound sources are rejected (the v1 arg bound)", () => {
    expect(validateSynthesisRequest(request({ source: "" })).valid).toBe(false);
    expect(validateSynthesisRequest(request({ source: "x".repeat(4097) })).valid).toBe(false);
    expect(validateSynthesisRequest(request({ source: "x".repeat(4096) })).valid).toBe(true);
  });

  test("raw-secret-shaped sources are rejected BEFORE anything durable", () => {
    const outcomes: readonly string[] = [
      "const key = 'sk-abcdefghijklmnopqrstuvwx';",
      "const key = 'AKIAABCDEFGHIJKLMNOP';",
      "const key = 'ghp_abcdefghijklmnopqrst';",
    ];
    for (const source of outcomes) {
      const check = validateSynthesisRequest(request({ source }));
      expect(check.valid).toBe(false);
      if (!check.valid) {
        expect(check.reason).toContain("raw secret");
      }
    }
  });

  test("an invalid requested tool contract is rejected (the SAME authority)", () => {
    const check = validateSynthesisRequest(
      request({
        contract: contract({ execution: { deterministic: true, timeoutMs: 0, idempotent: true } }),
      }),
    );
    expect(check.valid).toBe(false);
  });

  test("deterministic contracts cannot declare external writes (tool-contract rule preserved)", () => {
    const check = validateSynthesisRequest(
      request({
        contract: contract({
          execution: { deterministic: true, timeoutMs: 5000, idempotent: false },
          sideEffect: "write-external",
        }),
      }),
    );
    expect(check.valid).toBe(false);
  });

  test("a synthesized toolId MUST carry the synth- prefix (identity is discriminable)", () => {
    const check = validateSynthesisRequest(
      request({ contract: contract({ toolId: "calculator" }) }),
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toContain("synth-");
    }
    expect(SYNTHESIZED_TOOL_ID_PATTERN.test("synth-x")).toBe(true);
    expect(SYNTHESIZED_TOOL_ID_PATTERN.test("synth-")).toBe(false);
    expect(SYNTHESIZED_TOOL_ID_PATTERN.test("Synth-x")).toBe(false);
  });

  test("unknown languages are rejected (frozen v1 vocabulary)", () => {
    const check = validateSynthesisRequest(request({ language: "python" as never }));
    expect(check.valid).toBe(false);
  });

  test("test cases: at least one, at most sixteen, unique names, object shapes", () => {
    expect(validateSynthesisRequest(request({ testCases: [] })).valid).toBe(false);
    const many = Array.from({ length: 17 }, (_, i) => ({
      name: `case-${i}`,
      input: { value: i },
      expectedOutput: { doubled: i * 2 },
    }));
    expect(validateSynthesisRequest(request({ testCases: many })).valid).toBe(false);
    const dup = [
      { name: "dup", input: { value: 1 }, expectedOutput: { doubled: 2 } },
      { name: "dup", input: { value: 2 }, expectedOutput: { doubled: 4 } },
    ];
    expect(validateSynthesisRequest(request({ testCases: dup })).valid).toBe(false);
    expect(
      validateSynthesisRequest(
        request({ testCases: [{ name: "UPPER", input: {}, expectedOutput: {} }] }),
      ).valid,
    ).toBe(false);
    expect(
      validateSynthesisRequest(
        request({ testCases: [{ name: "ok", input: [], expectedOutput: {} }] as never }),
      ).valid,
    ).toBe(false);
  });

  test("expiresAt must be an ISO-8601 UTC timestamp", () => {
    expect(validateSynthesisRequest(request({ expiresAt: "not-a-time" })).valid).toBe(false);
    expect(validateSynthesisRequest(request({ expiresAt: "2099-01-01" })).valid).toBe(false);
  });
});

describe("the synthesized-program lifecycle table", () => {
  test("the frozen transitions gate every advance", () => {
    expect(SYNTHESIZED_PROGRAM_TRANSITIONS.draft).toEqual(["validated", "rejected"]);
    expect(SYNTHESIZED_PROGRAM_TRANSITIONS.validated).toEqual(["usable", "rejected"]);
    expect(SYNTHESIZED_PROGRAM_TRANSITIONS.usable).toEqual(["retired"]);
    expect(SYNTHESIZED_PROGRAM_TRANSITIONS.rejected).toEqual([]);
    expect(SYNTHESIZED_PROGRAM_TRANSITIONS.retired).toEqual([]);
  });
});

describe("content addressing (deterministic, version-stable)", () => {
  test("the same (source, contract) digests identically; any change differs", () => {
    const a = canonicalSynthesisJson(request());
    const b = canonicalSynthesisJson(request());
    expect(a).toBe(b);
    expect(digest(a)).toBe(digest(b));
    const changed = canonicalSynthesisJson(request({ source: "const input = 1;" }));
    expect(digest(a)).not.toBe(digest(changed));
    const versionBump = canonicalSynthesisJson(
      request({ contract: contract({ version: "1.0.1" }) }),
    );
    expect(digest(a)).not.toBe(digest(versionBump));
  });

  test("key order in the contract does not change the canonical form", () => {
    const first = canonicalSynthesisJson(request());
    const shuffled: SynthesisRequest = {
      expiresAt: "2099-01-01T00:00:00Z",
      testCases: request().testCases,
      contract: contract(),
      language: "javascript",
      source: request().source,
    };
    expect(canonicalSynthesisJson(shuffled)).toBe(first);
  });

  test("the submission fingerprint scopes to the application", () => {
    const r = request();
    expect(synthesisSubmissionFingerprint("app-1", r)).not.toBe(
      synthesisSubmissionFingerprint("app-2", r),
    );
  });
});

describe("fail-closed output parsing", () => {
  test("exactly one JSON object parses; everything else is a typed failure", () => {
    expect(parseSynthesizedOutput('{"doubled":4}')).toEqual({ ok: true, output: { doubled: 4 } });
    expect(parseSynthesizedOutput('  {"doubled":4}  ').ok).toBe(true);
    expect(parseSynthesizedOutput("").ok).toBe(false);
    expect(parseSynthesizedOutput("not json").ok).toBe(false);
    expect(parseSynthesizedOutput("[1,2]").ok).toBe(false);
    expect(parseSynthesizedOutput('"string"').ok).toBe(false);
    expect(parseSynthesizedOutput('{"a":1}{"b":2}').ok).toBe(false);
  });
});

describe("the v1 language-subset scan (defense in depth)", () => {
  test("pure compute passes", () => {
    expect(scanLanguageSubset("const x = 1 + 2;").valid).toBe(true);
  });

  test("every forbidden token is rejected", () => {
    for (const token of SYNTHESIS_FORBIDDEN_SOURCE_TOKENS) {
      const check = scanLanguageSubset(`const x = ${token}y;`);
      expect(check.valid, `token ${token} must be rejected`).toBe(false);
    }
  });

  test("the reject reason names the token", () => {
    const check = scanLanguageSubset("const x = setTimeout(f, 1);");
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toContain("forbids the token");
    }
  });
});
