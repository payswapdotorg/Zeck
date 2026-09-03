/**
 * Dashboard HTML-escape boundary tests (WORK-033; M7 the dashboard never
 * displays hostile material).
 *
 * Hostile values are interpolated through EVERY component surface that
 * renders caller/platform data — task fields, event types and payloads,
 * verification fields, attention copy, key/value tables, and the shell's
 * query echo. Every output must contain the ESCAPED forms and never the
 * raw payload (no injected markup, no attribute breakout).
 */

import { describe, expect, test } from "vitest";
import {
  attentionCard,
  executionHeader,
  keyValueTable,
  progressTimeline,
  resultSurface,
  statusBadge,
  verificationSummary,
  whyPanel,
} from "../../../apps/dashboard/components";
import { appShell } from "../../../apps/dashboard/shell";
import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../../sdk";

const HOSTILE = `"><script>zeck("x")</script>&'`;

function hostileExecution(): Execution {
  return {
    id: HOSTILE,
    applicationId: HOSTILE,
    environmentId: null,
    status: "RUNNING",
    task: { description: HOSTILE, kind: HOSTILE },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:00:01Z",
    terminalAt: null,
  };
}

function hostileResult(): ExecutionResult {
  return {
    executionId: HOSTILE,
    status: "RUNNING",
    route: { provider: HOSTILE, model: HOSTILE, strategyClass: HOSTILE, modelCalls: 2 },
    cost: null,
    usage: null,
    outputArtifacts: [{ id: HOSTILE, digest: HOSTILE, createdAt: "2026-09-15T12:01:00Z" }],
    verification: [
      {
        id: HOSTILE,
        executionId: HOSTILE,
        criterionId: HOSTILE,
        strategy: HOSTILE,
        status: "PASS",
        confidence: 0.5,
        evaluator: { kind: HOSTILE, id: HOSTILE, version: HOSTILE },
        evidenceRefs: [HOSTILE],
        recordedAt: "2026-09-15T12:01:30Z",
      },
    ],
    warnings: [HOSTILE],
    terminalAt: null,
  };
}

function hostileEvents(): ExecutionEvent[] {
  return [
    {
      eventId: HOSTILE,
      executionId: HOSTILE,
      type: HOSTILE,
      sequence: 1,
      occurredAt: "2026-09-15T12:00:00Z",
      payload: { message: HOSTILE, note: HOSTILE },
    },
  ];
}

function hostileVerification(): readonly VerificationResult[] {
  return hostileResult().verification;
}

/** The raw payload must never survive into any rendered surface. */
function assertNoRawPayload(output: string): void {
  expect(output).not.toContain("<script>");
  expect(output).not.toContain(`zeck("x")`);
  expect(output).not.toContain("&'");
  expect(output).toContain("&lt;script&gt;");
}

describe("dashboard html-escape boundary (M7)", () => {
  test("the header escapes the hostile task title and identity", () => {
    const html = executionHeader({
      execution: hostileExecution(),
      durationMs: 62_000,
      costMicroUsd: "4180000",
      verificationChip: "1/1 checks passed",
    });
    assertNoRawPayload(html);
    expect(html).toContain("&lt;script&gt;zeck(");
  });

  test("the timeline escapes hostile event types and payload detail", () => {
    const html = progressTimeline(hostileEvents());
    assertNoRawPayload(html);
  });

  test("the verification surface escapes hostile verification fields", () => {
    const html = verificationSummary(hostileVerification());
    assertNoRawPayload(html);
    const compact = verificationSummary(hostileVerification(), { compact: true });
    assertNoRawPayload(compact);
  });

  test("the result surface escapes hostile artifact ids, digests and warnings", () => {
    const html = resultSurface({
      execution: hostileExecution(),
      result: hostileResult(),
      events: hostileEvents(),
    });
    assertNoRawPayload(html);
  });

  test("the why panel escapes hostile task fields and route detail", () => {
    const html = whyPanel({
      execution: hostileExecution(),
      result: hostileResult(),
      events: hostileEvents(),
    });
    assertNoRawPayload(html);
  });

  test("key/value tables escape hostile pairs", () => {
    const html = keyValueTable([
      [HOSTILE, HOSTILE],
      ["plain", "value"],
    ]);
    assertNoRawPayload(html);
  });

  test("the status badge escapes a hostile (unknown) status", () => {
    const html = statusBadge(HOSTILE);
    assertNoRawPayload(html);
    expect(html).toContain("aria-hidden");
  });

  test("attention cards escape hostile titles, bodies and link labels", () => {
    const html = attentionCard({
      kind: "decision",
      title: HOSTILE,
      body: HOSTILE,
      links: [{ label: HOSTILE, href: `/runs/${encodeURIComponent("x")}` }],
    });
    assertNoRawPayload(html);
  });

  test("the shell escapes the hostile search query echo (attribute context)", () => {
    const html = appShell({
      title: "Zeck — test",
      activePath: "/command",
      mainContent: "<h1>Command</h1>",
      searchEcho: HOSTILE,
    });
    assertNoRawPayload(html);
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;');
  });

  test("the shell escapes a hostile page title (head context)", () => {
    const html = appShell({
      title: HOSTILE,
      activePath: "/",
      mainContent: "<h1>Home</h1>",
    });
    assertNoRawPayload(html);
  });

  test("no surface renders a hostile secret-shaped task field value", () => {
    const execution: Execution = {
      ...hostileExecution(),
      task: { description: "honest task", apiKey: "sk-live-hostile-token" },
    };
    const html = whyPanel({ execution, result: hostileResult(), events: hostileEvents() });
    expect(html).not.toContain("sk-live-hostile-token");
    expect(html).toContain("[not displayed]");
  });
});
