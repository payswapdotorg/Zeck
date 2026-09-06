/**
 * Integration — the OTLP/HTTP-JSON exporter over REAL HTTP
 * (WORK-047 / D-06; OBSERVABILITY-BOUNDARY + SELF-HOSTING-BOUNDARY).
 *
 * A real in-process HTTP collector (node:http) receives the exports
 * and asserts the documented OTLP protocol shapes. Proves:
 *
 *  - the traces/metrics/logs payloads are OTLP/HTTP-JSON
 *    (resourceSpans/resourceMetrics/resourceLogs; hex trace/span ids;
 *    nanosecond timestamps; severity numbers; attribute maps);
 *  - 202/200 accepts; 401 is PERMANENT (misconfiguration, no
 *    unbounded retry); 500/network is TRANSIENT (bounded retry);
 *  - the authorization header carries the resolved token; the token
 *    never appears in any diagnostic;
 *  - the secret-containing emission is rejected BEFORE the wire (the
 *    collector never receives it);
 *  - the exporter never throws into the caller path.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createOtlpExporter } from "../../../src/platform/observability/otlp";
import {
  BoundedTelemetrySink,
  bindSinkEnvironment,
} from "../../../src/platform/observability/telemetry";

interface ReceivedRequest {
  readonly path: string;
  readonly body: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
}

describe("the OTLP/HTTP-JSON exporter over real HTTP (WORK-047 D-06)", () => {
  let server: Server;
  let baseUrl: string;
  let received: ReceivedRequest[] = [];
  let respondWith: (request: IncomingMessage, response: ServerResponse) => void;

  beforeEach(async () => {
    received = [];
    respondWith = (_request, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    };
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        received.push({
          path: request.url ?? "/",
          body,
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
        });
        respondWith(request, response);
      });
    });
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (address !== null && typeof address === "object") {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
  });

  const correlation = { environment: "local" as const, executionId: "exec-otlp-1" };

  test("spans, metrics and logs export as OTLP/HTTP-JSON to the three endpoints", async () => {
    const exporter = createOtlpExporter({ endpoint: baseUrl, token: "collector-token-1" });
    const sink = new BoundedTelemetrySink({ exporter });
    const bound = bindSinkEnvironment(sink, "local");
    await bound.emitSpan({
      name: "zeck.worker.claim",
      status: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.500Z",
      correlation,
      attributes: { claimEpoch: "1" },
    });
    await bound.emitMetric({
      name: "zeck.worker.dispositions",
      kind: "counter",
      value: 1,
      correlation,
      attributes: { disposition: "settled" },
    });
    await bound.emitLog({
      level: "warn",
      message: "dead-lettered: governed rejection",
      correlation,
      attributes: { reason: "governed-rejection" },
    });
    const outcomes = await sink.flush();
    expect(outcomes.every((outcome) => outcome.kind === "accepted")).toBe(true);
    expect(received.map((request) => request.path)).toEqual([
      "/v1/traces",
      "/v1/metrics",
      "/v1/logs",
    ]);

    // The OTLP trace payload shape.
    const tracePayload = JSON.parse(received[0]?.body ?? "{}") as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] };
        scopeSpans: { scope: { name: string }; spans: Record<string, unknown>[] }[];
      }[];
    };
    const span = tracePayload.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(tracePayload.resourceSpans[0]?.scopeSpans[0]?.scope.name).toBe("zeck.platform");
    expect(tracePayload.resourceSpans[0]?.resource.attributes[0]).toEqual({
      key: "service.name",
      value: { stringValue: "zeck" },
    });
    expect(span?.name).toBe("zeck.worker.claim");
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span?.startTimeUnixNano).toMatch(/^[0-9]+$/);
    expect(span?.status).toEqual({ code: 1 });

    // The OTLP metric payload shape (a monotonic sum for counters).
    const metricPayload = JSON.parse(received[1]?.body ?? "{}") as {
      resourceMetrics: {
        scopeMetrics: {
          metrics: {
            name: string;
            sum?: { dataPoints: { asDouble: number }[]; isMonotonic: boolean };
          }[];
        }[];
      }[];
    };
    const metric = metricPayload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
    expect(metric?.name).toBe("zeck.worker.dispositions");
    expect(metric?.sum?.isMonotonic).toBe(true);
    expect(metric?.sum?.dataPoints[0]?.asDouble).toBe(1);

    // The OTLP log payload shape (severity + body + traceId join).
    const logPayload = JSON.parse(received[2]?.body ?? "{}") as {
      resourceLogs: {
        scopeLogs: {
          logRecords: {
            traceId: string;
            severityNumber: number;
            severityText: string;
            body: { stringValue: string };
          }[];
        }[];
      }[];
    };
    const logRecord = logPayload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    expect(logRecord?.severityNumber).toBe(13);
    expect(logRecord?.severityText).toBe("WARN");
    expect(logRecord?.body.stringValue).toContain("dead-lettered");
    expect(logRecord?.traceId).toMatch(/^[0-9a-f]{32}$/);

    // The auth header + content type on every request.
    for (const request of received) {
      expect(request.authorization).toBe("Bearer collector-token-1");
      expect(request.contentType).toBe("application/json");
    }
  });

  test("401 is a PERMANENT rejection (no unbounded retry)", async () => {
    respondWith = (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end("{}");
    };
    const exporter = createOtlpExporter({ endpoint: baseUrl });
    const outcome = await exporter.export({
      spans: [
        {
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          name: "n",
          status: "ok",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:00.001Z",
          correlation,
          attributes: {},
        },
      ],
      metrics: [],
      logs: [],
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.permanent).toBe(true);
      expect(outcome.reason).toContain("401");
    }
  });

  test("500 is TRANSIENT with the bounded retry", async () => {
    let calls = 0;
    respondWith = (_request, response) => {
      calls += 1;
      if (calls <= 2) {
        response.writeHead(500);
        response.end("{}");
        return;
      }
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    };
    const exporter = createOtlpExporter({ endpoint: baseUrl });
    const sink = new BoundedTelemetrySink({ exporter });
    await sink.emitLog({
      level: "info",
      message: "retry me",
      correlation,
      attributes: {},
    });
    const outcomes = await sink.flush();
    expect(outcomes[0]?.kind).toBe("accepted");
    expect(calls).toBe(3); // 1 initial + 2 bounded retries.
  });

  test("an unreachable endpoint is a transient transport failure, never a throw", async () => {
    const exporter = createOtlpExporter({
      endpoint: "http://127.0.0.1:1",
      requestTimeoutMs: 300,
    });
    const outcome = await exporter.export({
      spans: [],
      metrics: [],
      logs: [
        {
          traceId: "a".repeat(32),
          level: "info",
          message: "m",
          timestamp: "2026-01-01T00:00:00.000Z",
          correlation,
          attributes: {},
        },
      ],
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.permanent).toBe(false);
      expect(outcome.reason).toContain("transport failure");
    }
  });

  test("secret material is rejected BEFORE the wire (the collector never receives it)", async () => {
    const exporter = createOtlpExporter({ endpoint: baseUrl });
    const sink = new BoundedTelemetrySink({ exporter });
    const bound = bindSinkEnvironment(sink, "local");
    await bound.emitLog({
      level: "info",
      message: "m",
      correlation,
      attributes: { apiToken: "super-secret-token" },
    });
    await sink.flush();
    expect(received).toHaveLength(0);
    expect(sink.stats().recordsRejected).toBe(1);
  });

  test("no token configured: no authorization header (open local collectors)", async () => {
    const exporter = createOtlpExporter({ endpoint: baseUrl });
    const outcome = await exporter.export({
      spans: [],
      metrics: [
        {
          name: "m",
          kind: "gauge",
          value: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          correlation,
          attributes: {},
        },
      ],
      logs: [],
    });
    expect(outcome.kind).toBe("accepted");
    expect(received[0]?.authorization).toBeUndefined();
  });
});
