/**
 * The OTLP/HTTP-JSON telemetry exporter adapter (WORK-047 / D-06).
 *
 * Speaks the documented OpenTelemetry protocol OTLP/HTTP JSON shapes
 * over PLAIN fetch — zero new SDKs (the repository SDK boundary
 * stays fastify + pg, the D-05 B7 convention). The OTLP protocol is
 * a transport standard like HTTP itself: any OTLP-compatible
 * collector (self-hosted or managed) accepts these payloads — the
 * SELF-HOSTING-BOUNDARY checkpoint: observability export never
 * locks Zeck to a vendor control plane, and an unconfigured endpoint
 * degrades to the explicit logs-only mode.
 *
 * CLASSIFICATION (fail-closed semantics, never thrown):
 * - 200/202  → accepted;
 * - 401/403/404 → PERMANENT rejection (misconfiguration; retried
 *   only by operator action, never by the loop);
 * - 429/5xx/network/timeout → TRANSIENT rejection (the sink's
 *   bounded retry policy applies);
 * - the auth token NEVER appears in any diagnostic.
 */

import type { ExportOutcome, TelemetryBatch, TelemetryExporter } from "./port";

export interface OtlpExporterOptions {
  /** The collector base URL (e.g. https://collector.example.org). */
  readonly endpoint: string;
  /** Bearer token (resolved through the secret store; never logged). */
  readonly token?: string;
  readonly requestTimeoutMs?: number;
  /** Fetch seam (tests inject a controllable transport). */
  readonly fetchImpl?: typeof fetch;
}

const OTLP_TIMEOUT_DEFAULT_MS = 5000;
const OTLP_TIMEOUT_MAX_MS = 120000;

/** Nanoseconds since epoch for an ISO timestamp. */
function unixNanoOf(iso: string): string {
  const millis = Date.parse(iso);
  const safe = Number.isNaN(millis) ? 0 : millis;
  return `${safe}000000`;
}

function otlpAttributes(
  attributes: Readonly<Record<string, string>>,
): readonly { readonly key: string; readonly value: { readonly stringValue: string } }[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

function otlpSpanOf(span: TelemetryBatch["spans"][number]): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1, // INTERNAL
    startTimeUnixNano: unixNanoOf(span.startedAt),
    endTimeUnixNano: unixNanoOf(span.endedAt),
    status: { code: span.status === "error" ? 2 : span.status === "ok" ? 1 : 0 },
    attributes: otlpAttributes(span.attributes),
  };
}

function otlpMetricOf(metric: TelemetryBatch["metrics"][number]): Record<string, unknown> {
  const dataPoint = {
    asDouble: metric.value,
    timeUnixNano: unixNanoOf(metric.timestamp),
    attributes: otlpAttributes(metric.attributes),
  };
  const instrument =
    metric.kind === "counter"
      ? { sum: { dataPoints: [dataPoint], isMonotonic: true, aggregationTemporality: 2 } }
      : { gauge: { dataPoints: [dataPoint] } };
  return {
    name: metric.name,
    ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
    ...instrument,
  };
}

function otlpLogOf(log: TelemetryBatch["logs"][number]): Record<string, unknown> {
  const severityNumber =
    log.level === "error" ? 17 : log.level === "warn" ? 13 : log.level === "info" ? 9 : 5;
  return {
    traceId: log.traceId,
    timeUnixNano: unixNanoOf(log.timestamp),
    severityNumber,
    severityText: log.level.toUpperCase(),
    body: { stringValue: log.message },
    attributes: otlpAttributes(log.attributes),
  };
}

function resourceAttributesOf(
  correlation: { readonly environment: string } | undefined,
): readonly unknown[] {
  const entries = [
    { key: "service.name", value: { stringValue: "zeck" } },
    {
      key: "zeck.environment",
      value: { stringValue: correlation?.environment ?? "unknown" },
    },
  ];
  return entries;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function classifyStatus(status: number): ExportOutcome {
  if (status >= 200 && status < 300) {
    return { kind: "accepted", accepted: status };
  }
  if (status === 401 || status === 403 || status === 404) {
    return {
      kind: "rejected",
      reason: `otlp endpoint answered ${status} (permanent misconfiguration)`,
      permanent: true,
    };
  }
  return {
    kind: "rejected",
    reason: `otlp endpoint answered ${status} (transient)`,
    permanent: false,
  };
}

/**
 * The OTLP/HTTP-JSON exporter over plain fetch. Never throws — all
 * failures are classified outcomes.
 */
export function createOtlpExporter(options: OtlpExporterOptions): TelemetryExporter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.min(
    options.requestTimeoutMs ?? OTLP_TIMEOUT_DEFAULT_MS,
    OTLP_TIMEOUT_MAX_MS,
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.token !== undefined && options.token.length > 0
      ? { authorization: `Bearer ${options.token}` }
      : {}),
  };
  const resource = { attributes: resourceAttributesOf(undefined) };

  async function post(path: string, body: string): Promise<ExportOutcome> {
    try {
      const response = await fetchImpl(joinUrl(options.endpoint, path), {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return classifyStatus(response.status);
    } catch (error) {
      return {
        kind: "rejected",
        reason: `otlp transport failure: ${(error as Error).message.slice(0, 120)}`,
        permanent: false,
      };
    }
  }

  return {
    export: async (batch: TelemetryBatch): Promise<ExportOutcome> => {
      const failures: string[] = [];
      let acceptedTotal = 0;
      if (batch.spans.length > 0) {
        const payload = JSON.stringify({
          resourceSpans: [
            {
              resource,
              scopeSpans: [
                { scope: { name: "zeck.platform" }, spans: batch.spans.map(otlpSpanOf) },
              ],
            },
          ],
        });
        const outcome = await post("/v1/traces", payload);
        if (outcome.kind === "accepted") {
          acceptedTotal += batch.spans.length;
        } else {
          failures.push(outcome.reason);
          if (outcome.permanent) {
            return outcome;
          }
        }
      }
      if (batch.metrics.length > 0) {
        const payload = JSON.stringify({
          resourceMetrics: [
            {
              resource,
              scopeMetrics: [
                { scope: { name: "zeck.platform" }, metrics: batch.metrics.map(otlpMetricOf) },
              ],
            },
          ],
        });
        const outcome = await post("/v1/metrics", payload);
        if (outcome.kind === "accepted") {
          acceptedTotal += batch.metrics.length;
        } else {
          failures.push(outcome.reason);
          if (outcome.permanent) {
            return outcome;
          }
        }
      }
      if (batch.logs.length > 0) {
        const payload = JSON.stringify({
          resourceLogs: [
            {
              resource,
              scopeLogs: [
                {
                  scope: { name: "zeck.platform" },
                  logRecords: batch.logs.map(otlpLogOf),
                },
              ],
            },
          ],
        });
        const outcome = await post("/v1/logs", payload);
        if (outcome.kind === "accepted") {
          acceptedTotal += batch.logs.length;
        } else {
          failures.push(outcome.reason);
          if (outcome.permanent) {
            return outcome;
          }
        }
      }
      if (failures.length > 0) {
        return {
          kind: "rejected",
          reason: failures.join("; ").slice(0, 200),
          permanent: false,
        };
      }
      return { kind: "accepted", accepted: acceptedTotal };
    },
  };
}
