/**
 * Dashboard request-mapping tests (WORK-033).
 *
 * The form -> ExecutionRequest mapping is the ONLY create surface: it maps
 * the outcome text to the task record, converts dollars to the integer
 * micro-USD string with integer/BigInt arithmetic ONLY (the platform money
 * discipline — never floats), maps the quality select to minQuality, can
 * never emit a forbidden request key (and the SDK's own client-side
 * rejection of forbidden keys is proven to surface), and carries the
 * idempotency key through the review step so retries converge.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDashboard } from "../../../apps/dashboard/index";
import {
  buildExecutionRequest,
  dollarsToMicroUsd,
  type ExecutionFormValues,
  forbiddenRequestKeys,
  validateExecutionForm,
} from "../../../apps/dashboard/projection";
import type { AgentSummary, ExecutionReceipt } from "../../../sdk";
import { createZeckClient } from "../../../sdk";

// ---------------------------------------------------------------------------
// Pure mapping: dollars -> integer micro-USD (BigInt only)
// ---------------------------------------------------------------------------

describe("dollarsToMicroUsd (integer/BigInt arithmetic only)", () => {
  test("whole and fractional dollars map to exact integer micro-USD strings", () => {
    expect(dollarsToMicroUsd("10.50")).toBe("10500000");
    expect(dollarsToMicroUsd("0.01")).toBe("10000");
    expect(dollarsToMicroUsd("4.18")).toBe("4180000");
    expect(dollarsToMicroUsd("0")).toBe("0");
    expect(dollarsToMicroUsd("120")).toBe("120000000");
  });

  test("more than two decimals are rejected (no silent rounding)", () => {
    expect(dollarsToMicroUsd("10.505")).toBeNull();
    expect(dollarsToMicroUsd("0.000001")).toBeNull();
  });

  test("non-numeric and negative shapes are rejected", () => {
    for (const hostile of ["-5", "abc", "1e3", "10.", ".5", " 10", "10 50", "1,5", ""]) {
      expect(dollarsToMicroUsd(hostile), hostile).toBeNull();
    }
  });

  test("large values stay exact through BigInt (no float drift)", () => {
    expect(dollarsToMicroUsd("123456.78")).toBe("123456780000");
    expect(dollarsToMicroUsd("999999.99")).toBe("999999990000");
  });
});

// ---------------------------------------------------------------------------
// Pure mapping: validation and the closed request vocabulary
// ---------------------------------------------------------------------------

function validValues(overrides: Partial<ExecutionFormValues> = {}): ExecutionFormValues {
  return {
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    environmentId: "",
    outcome: "Analyze the contract and summarize the risks",
    attachments: "",
    spendLimitDollars: "",
    quality: "",
    latencySeconds: "",
    userId: "",
    ...overrides,
  };
}

describe("validateExecutionForm", () => {
  test("valid input produces the values and no errors", () => {
    const { values, errors } = validateExecutionForm({
      applicationId: "app-1",
      outcome: "Summarize the findings",
    });
    expect(errors).toEqual({});
    expect(values?.outcome).toBe("Summarize the findings");
  });

  test("each missing/invalid field produces its own inline error", () => {
    const { values, errors } = validateExecutionForm({
      applicationId: "",
      outcome: "   ",
      spendLimitDollars: "10.505",
      quality: "0.99",
      latencySeconds: "0",
    });
    expect(values).toBeNull();
    expect(errors.applicationId).toBeTruthy();
    expect(errors.outcome).toBeTruthy();
    expect(errors.spendLimitDollars).toBeTruthy();
    expect(errors.quality).toBeTruthy();
    expect(errors.latencySeconds).toBeTruthy();
  });

  test("non-numeric latency is rejected; blank optionals are fine", () => {
    const { errors } = validateExecutionForm({
      applicationId: "app-1",
      outcome: "x",
      latencySeconds: "soon",
    });
    expect(errors.latencySeconds).toBeTruthy();
    const clean = validateExecutionForm({
      applicationId: "app-1",
      outcome: "x",
      spendLimitDollars: "",
      quality: "",
      latencySeconds: "",
    });
    expect(clean.errors).toEqual({});
  });
});

describe("buildExecutionRequest (the closed vocabulary)", () => {
  test("the outcome maps to the task record; empty optionals are omitted", () => {
    const request = buildExecutionRequest(validValues());
    expect(request.task).toEqual({ kind: "outcome", description: request.task.description });
    expect(request.environmentId).toBeUndefined();
    expect(request.constraints).toBeUndefined();
    expect(request.userId).toBeUndefined();
    expect(request.inputArtifactRefs).toBeUndefined();
  });

  test("WORK-036: attachments map to inputArtifactRefs; blank lines and commas both separate", () => {
    const request = buildExecutionRequest(
      validValues({
        attachments: "art-1\nart-2, art-3\n\n",
      }),
    );
    expect(request.inputArtifactRefs).toEqual(["art-1", "art-2", "art-3"]);
    const none = buildExecutionRequest(validValues({ attachments: "" }));
    expect(none.inputArtifactRefs).toBeUndefined();
  });

  test("WORK-036: invalid attachment tokens are rejected by validation, never silently dropped", () => {
    const { values, errors } = validateExecutionForm({
      applicationId: "app-1",
      outcome: "x",
      attachments: "good-ref\nbad ref with spaces",
    });
    expect(values).toBeNull();
    expect(errors.attachments).toBeTruthy();
  });

  test("dollars map to the integer micro-USD string; quality and latency map too", () => {
    const request = buildExecutionRequest(
      validValues({
        spendLimitDollars: "10.50",
        quality: "0.8",
        latencySeconds: "120",
        environmentId: "env-7",
        userId: "user-9",
      }),
    );
    expect(request.constraints).toEqual({
      maxCostMicroUsd: "10500000",
      minQuality: 0.8,
      maxLatencyMs: 120_000,
    });
    expect(request.environmentId).toBe("env-7");
    expect(request.userId).toBe("user-9");
  });

  test("the builder can NEVER emit a forbidden request key, whatever the form carries", () => {
    for (const forbidden of forbiddenRequestKeys()) {
      const request = buildExecutionRequest(validValues());
      expect(forbidden in request, forbidden).toBe(false);
    }
    // Even a hostile outcome string naming provider concepts stays a task
    // description — it can never become a request key.
    const request = buildExecutionRequest(
      validValues({ outcome: "route this via the cheapest provider and model" }),
    );
    const serialized = JSON.stringify(request);
    for (const forbidden of forbiddenRequestKeys()) {
      expect(serialized.includes(`"${forbidden}":`), forbidden).toBe(false);
    }
  });
});

describe("the SDK's forbidden-key rejection surfaces (fail closed, API-001)", () => {
  test("createExecution rejects a request carrying a forbidden key client-side", async () => {
    const calls: string[] = [];
    const client = createZeckClient({
      baseUrl: "http://fake.local",
      token: "token",
      fetchImpl: (async () => {
        calls.push("must-not-be-reached");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(
      client.createExecution({
        applicationId: "app-1",
        task: { kind: "outcome", description: "x" },
        // A hostile caller trying to select the route from the client.
        provider: "chosen-by-caller",
      } as never),
    ).rejects.toThrow(/provider/);
    expect(calls).toEqual([]);
  });

  test("the honest path posts the closed vocabulary with the idempotency key header", async () => {
    const recorded: { path?: string; init?: RequestInit } = {};
    const receipt: ExecutionReceipt = {
      executionId: "00000000-0000-7000-8000-0000000000e9",
      applicationId: "app-1",
      status: "CREATED",
      createdAt: "2026-09-15T12:00:00Z",
      replayed: false,
      lastEventSequence: 1,
    };
    const client = createZeckClient({
      baseUrl: "http://fake.local",
      token: "token",
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        recorded.path = new URL(String(input)).pathname;
        recorded.init = init ?? {};
        return new Response(JSON.stringify(receipt), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const outcome = await client.createExecution(
      buildExecutionRequest(validValues({ spendLimitDollars: "1.00" })),
      "dash-key-1",
    );
    expect(outcome.receipt.executionId).toBe(receipt.executionId);
    expect(recorded.path).toBe("/executions");
    const headers = recorded.init?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("dash-key-1");
    expect(String(recorded.init?.body)).toContain('"maxCostMicroUsd":"1000000"');
    expect(String(recorded.init?.body)).not.toMatch(/"(provider|model|rail|agent|connection)"/);
  });
});

// ---------------------------------------------------------------------------
// The review step carries the idempotency key (real server, fake API world)
// ---------------------------------------------------------------------------

const AGENTS: AgentSummary[] = [];

const fetchImpl = (async (input: string | URL) => {
  const path = new URL(String(input)).pathname;
  if (path === "/agents") {
    return new Response(JSON.stringify(AGENTS), { status: 200 });
  }
  return new Response(JSON.stringify({ code: "PROVIDER_ERROR", message: "x", retryable: true }), {
    status: 500,
  });
}) as unknown as typeof fetch;

let base = "";

beforeAll(async () => {
  const { server } = createDashboard({
    apiUrl: "http://fake.local",
    token: "token",
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    port: 0,
    fetchImpl,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
});

describe("the idempotency key is carried through the review step", () => {
  test("step 1 generates a key and the review POST form echoes it as a hidden field", async () => {
    const step1 = await fetch(`${base}/build/execution`, { redirect: "manual" });
    const step1Html = await step1.text();
    const generated = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(step1Html);
    expect(generated).not.toBeNull();
    const key = generated?.[1] ?? "";

    const review = await fetch(
      `${base}/build/execution?outcome=${encodeURIComponent("Summarize the findings")}` +
        "&applicationId=app-1" +
        `&idempotencyKey=${encodeURIComponent(key)}` +
        "&spendLimitDollars=10.50&quality=0.8&latencySeconds=120",
      { redirect: "manual" },
    );
    const reviewHtml = await review.text();
    expect(review.status).toBe(200);
    expect(reviewHtml).toContain("Review the proposed execution");
    // The Execute form carries EVERY field as hidden inputs, key included.
    expect(reviewHtml).toContain(`<input type="hidden" name="idempotencyKey" value="${key}">`);
    for (const field of [
      `name="applicationId" value="app-1"`,
      `name="spendLimitDollars" value="10.50"`,
      `name="quality" value="0.8"`,
      `name="latencySeconds" value="120"`,
    ]) {
      expect(reviewHtml).toContain(field);
    }
    expect(reviewHtml).toContain('method="post" action="/build/execution"');
    expect(reviewHtml).toContain(">Run</button>");
    // The proposal review summarizes the mapped request (the envelope's
    // declared cost/time limits — never a fabricated platform estimate).
    expect(reviewHtml).toContain("Spend limit: $10.50");
    expect(reviewHtml).toContain("Quality target: 0.8");
    expect(reviewHtml).toContain("Latency limit: 120 seconds");
    // WORK-036 AC3: the proposed-approach envelope's four understandings.
    expect(reviewHtml).toContain("Proposed approach");
    expect(reviewHtml).toContain("Permission and risk envelope");
    expect(reviewHtml).toContain("Proposed verification approach");
    expect(reviewHtml).toContain("not platform estimates");
  });

  test("the edit link preserves the SAME key (retries converge, no duplicate intents)", async () => {
    const review = await fetch(
      `${base}/build/execution?outcome=${encodeURIComponent("Summarize the findings")}` +
        "&applicationId=app-1&idempotencyKey=dash-fixed-key",
      { redirect: "manual" },
    );
    const reviewHtml = await review.text();
    const editHref = /href="([^"]*edit=1[^"]*)"/.exec(reviewHtml);
    expect(editHref).not.toBeNull();
    // An HTML-extracted href carries entity-escaped ampersands; a real
    // browser's HTML parser decodes them before following the link.
    const href = (editHref?.[1] ?? "").replaceAll("&amp;", "&");
    expect(href).toContain("idempotencyKey=dash-fixed-key");
    // Following the edit link back to step 1 keeps the key in the form.
    const edit = await fetch(`${base}${href}`, { redirect: "manual" });
    const editHtml = await edit.text();
    expect(editHtml).toContain('name="idempotencyKey" value="dash-fixed-key"');
  });

  test("an invalid review re-renders the form with inline errors and the key kept", async () => {
    const review = await fetch(
      `${base}/build/execution?outcome=${encodeURIComponent("Summarize")}&applicationId=app-1` +
        "&idempotencyKey=dash-key-2&spendLimitDollars=not-a-number&quality=bogus",
      { redirect: "manual" },
    );
    const html = await review.text();
    expect(review.status).toBe(200);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('name="idempotencyKey" value="dash-key-2"');
    expect(html).toContain("Enter a spend limit as a dollar amount");
    expect(html).toContain("Choose one of the listed quality targets");
  });

  test("a POST without a key re-renders honestly (never a keyless create)", async () => {
    const response = await fetch(`${base}/build/execution`, {
      method: "POST",
      body: "applicationId=app-1&outcome=Summarize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("The form state was lost");
    // The replacement form carries a FRESH key so the retry still converges.
    expect(html).toMatch(/name="idempotencyKey" value="dash-/);
    expect(html).toContain('aria-live="polite"');
  });
});
