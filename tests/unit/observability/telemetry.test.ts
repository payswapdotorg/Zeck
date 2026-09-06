/**
 * Unit — the bounded telemetry sink (WORK-047 / D-06; OBSERVABILITY-
 * BOUNDARY: boundedness, secret-free admission, deterministic
 * correlation).
 */

import { describe, expect, test } from "vitest";
import { TELEMETRY_BOUNDS } from "../../../src/platform/observability/port";
import {
  BoundedTelemetrySink,
  bindSinkEnvironment,
  createInMemoryExporter,
  traceIdOf,
} from "../../../src/platform/observability/telemetry";

const ENV = { environment: "local" as const };

describe("the bounded telemetry sink (WORK-047 D-06)", () => {
  test("the trace id is deterministic from the stable correlation identity", () => {
    const a = traceIdOf({ environment: "local", executionId: "exec-1" });
    const b = traceIdOf({ environment: "local", executionId: "exec-1" });
    const c = traceIdOf({ environment: "local", executionId: "exec-2" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    // The same execution correlates across records that carry
    // different secondary fields: the execution id is the primary.
    const d = traceIdOf({
      environment: "local",
      executionId: "exec-1",
      correlationKey: "execution-dispatch:exec-1",
      claimId: "claim-9",
    });
    expect(d).toBe(a);
  });

  test("emission and export: spans/metrics/logs flow to the exporter in bounded batches", async () => {
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    await sink.emitSpan({
      name: "zeck.worker.claim",
      status: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.010Z",
      correlation: ENV,
      attributes: { claimEpoch: "1" },
    });
    await sink.emitMetric({
      name: "zeck.worker.dispositions",
      kind: "counter",
      value: 1,
      correlation: ENV,
      attributes: { disposition: "settled" },
    });
    await sink.emitLog({
      level: "warn",
      message: "dead-lettered",
      correlation: ENV,
      attributes: { reason: "governed-rejection" },
    });
    const outcomes = await sink.flush();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe("accepted");
    expect(collector.batches).toHaveLength(1);
    const batch = collector.batches[0];
    expect(batch?.spans).toHaveLength(1);
    expect(batch?.metrics).toHaveLength(1);
    expect(batch?.logs).toHaveLength(1);
    expect(batch?.spans[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(batch?.spans[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(sink.stats().spansEmitted).toBe(1);
    expect(sink.stats().exportsAccepted).toBe(3);
    // A second flush of the empty buffer is a no-op.
    expect(await sink.flush()).toHaveLength(0);
  });

  test("records without an environment binding are rejected fail-closed", async () => {
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    await sink.emitSpan({
      name: "zeck.worker.claim",
      status: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.010Z",
      correlation: {},
      attributes: {},
    });
    expect(sink.stats().recordsRejected).toBe(1);
    expect(sink.buffered().spans).toHaveLength(0);
  });

  test("bindSinkEnvironment fills the environment and preserves already-bound records", async () => {
    const collector = createInMemoryExporter();
    const base = new BoundedTelemetrySink({ exporter: collector.exporter });
    const bound = bindSinkEnvironment(base, "ci");
    await bound.emitLog({ level: "info", message: "m", correlation: {}, attributes: {} });
    await bound.emitLog({
      level: "info",
      message: "m2",
      correlation: { environment: "local" },
      attributes: {},
    });
    await bound.emitMetric({
      name: "zeck.api.requests",
      kind: "counter",
      value: 1,
      correlation: { requestId: "req-1" },
      attributes: {},
    });
    await base.flush();
    const logs = collector.batches[0]?.logs ?? [];
    expect(logs[0]?.correlation.environment).toBe("ci");
    expect(logs[1]?.correlation.environment).toBe("local");
    const metrics = collector.batches[0]?.metrics ?? [];
    expect(metrics[0]?.correlation.environment).toBe("ci");
    expect(metrics[0]?.correlation.requestId).toBe("req-1");
  });

  test("secret-shaped attributes are rejected before buffering; credential values are redacted", async () => {
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    // KEY rejection: the record is dropped and counted.
    await sink.emitLog({
      level: "info",
      message: "m",
      correlation: ENV,
      attributes: { apiToken: "value" },
    });
    expect(sink.stats().recordsRejected).toBe(1);
    // VALUE redaction: the record is admitted with the redaction counted.
    await sink.emitLog({
      level: "info",
      message: "connected to postgres://user:secretpw@host/db",
      correlation: ENV,
      attributes: { detail: "postgres://user:secretpw@host/db" },
    });
    expect(sink.stats().recordsRejected).toBe(1);
    expect(sink.stats().attributesRedacted).toBeGreaterThanOrEqual(1);
    await sink.flush();
    const logs = collector.batches[0]?.logs ?? [];
    expect(logs[0]?.message).not.toContain("secretpw");
    expect(logs[0]?.message).toContain("[redacted]");
    expect(logs[0]?.attributes.detail).not.toContain("secretpw");
  });

  test("buffers are bounded: overflow is dropped and counted, never unbounded", async () => {
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    for (let index = 0; index < TELEMETRY_BOUNDS.maxBufferedLogs + 25; index += 1) {
      await sink.emitLog({ level: "info", message: `m${index}`, correlation: ENV, attributes: {} });
    }
    expect(sink.stats().logsEmitted).toBe(TELEMETRY_BOUNDS.maxBufferedLogs);
    expect(sink.stats().logsDropped).toBe(25);
    expect(sink.buffered().logs).toHaveLength(TELEMETRY_BOUNDS.maxBufferedLogs);
  });

  test("export batches are bounded by maxExportBatch", async () => {
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    const total = TELEMETRY_BOUNDS.maxExportBatch + 10;
    for (let index = 0; index < total; index += 1) {
      await sink.emitLog({ level: "info", message: `m${index}`, correlation: ENV, attributes: {} });
    }
    await sink.flush();
    const sizes = collector.batches.map(
      (batch) => batch.logs.length + batch.spans.length + batch.metrics.length,
    );
    expect(Math.max(...sizes)).toBeLessThanOrEqual(TELEMETRY_BOUNDS.maxExportBatch);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(total);
  });

  test("transient export failures retry boundedly and count; permanent failures drop the batch", async () => {
    const collector = createInMemoryExporter();
    collector.failWith = { kind: "rejected", reason: "boom 503", permanent: false };
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    await sink.emitLog({ level: "info", message: "m", correlation: ENV, attributes: {} });
    const outcomes = await sink.flush();
    // 1 initial + 2 bounded retries = 3 attempts, all rejected.
    expect(collector.batches).toHaveLength(0);
    expect(outcomes.every((outcome) => outcome.kind === "rejected")).toBe(true);
    expect(sink.stats().exportsRejected).toBe(1);

    collector.failWith = { kind: "rejected", reason: "401", permanent: true };
    await sink.emitLog({ level: "info", message: "m2", correlation: ENV, attributes: {} });
    const outcomes2 = await sink.flush();
    expect(outcomes2).toHaveLength(1);
    expect(outcomes2[0]?.kind).toBe("rejected");
    expect((outcomes2[0] as { permanent: boolean }).permanent).toBe(true);
  });

  test("an exporter that throws is classified, never propagated", async () => {
    const sink = new BoundedTelemetrySink({
      exporter: {
        export: async () => {
          throw new Error("collector exploded");
        },
      },
    });
    await sink.emitLog({ level: "info", message: "m", correlation: ENV, attributes: {} });
    const outcomes = await sink.flush();
    expect(outcomes[0]?.kind).toBe("rejected");
    expect(sink.stats().exportsRejected).toBe(1);
  });

  test("oversized names and invalid levels are rejected", async () => {
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    await sink.emitMetric({
      name: "x".repeat(TELEMETRY_BOUNDS.maxNameLength + 1),
      kind: "counter",
      value: 1,
      correlation: ENV,
      attributes: {},
    });
    await sink.emitLog({
      level: "trace" as "debug",
      message: "m",
      correlation: ENV,
      attributes: {},
    });
    expect(sink.stats().recordsRejected).toBe(2);
  });
});
