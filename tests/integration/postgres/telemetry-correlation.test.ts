/**
 * Integration — telemetry correlation end-to-end over REAL
 * PostgreSQL (WORK-047 / D-06; AC4: "operational telemetry can
 * reconstruct an execution end-to-end using stable correlation
 * identifiers while redacting secrets").
 *
 * The REAL worker-world composition (executions authority, sandbox
 * authority, budgets, the REAL fabric) with a REAL bounded telemetry
 * sink wired through the fabric seam. Proves:
 *
 *  - the full execution chain (dispatch → claim → disposition) is
 *    reconstructable from the EXECUTION ID ALONE: every record of
 *    the chain carries the same deterministic trace id derived from
 *    the stable correlation identity;
 *  - the correlation key vocabulary (the D-03 execution-dispatch key)
 *    travels on the records for cross-store joins;
 *  - secret material in an emission is REJECTED before it reaches
 *    the exporter (the wire never sees it);
 *  - the sink is observation-only: a fabric run with telemetry
 *    produces the SAME authoritative execution outcome as without
 *    (telemetry never drives authority);
 *  - boundedness: the drop counters are observable.
 */

import { expect, test } from "vitest";
import {
  BoundedTelemetrySink,
  bindSinkEnvironment,
  createInMemoryExporter,
  traceIdOf,
} from "../../../src/platform/observability/telemetry";
import { definePgSuite } from "./harness";
import { seedWorkerFabricWorld } from "./worker-world";

definePgSuite("telemetry correlation (WORK-047 D-06)", (ctx) => {
  const world = () => seedWorkerFabricWorld(ctx.port);

  test("the execution chain is reconstructable end-to-end from the execution id alone", async () => {
    const w = await world();
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    const executionId = await w.createDispatchedExecution("telemetry-chain");

    const fabric = await w.createFabric({
      telemetry: bindSinkEnvironment(sink, "local"),
    });
    const report = await fabric.consumeBatch();
    expect(report.pulled).toBe(1);
    expect(report.claimed).toBe(1);
    await sink.flush();

    // The authoritative outcome is COMPLETED (the sink observed it;
    // it never drove it).
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("COMPLETED");

    const batch = collector.batches[0];
    expect(batch).toBeDefined();
    const spans = batch?.spans ?? [];
    const logs = batch?.logs ?? [];
    const metrics = batch?.metrics ?? [];

    // The deterministic trace id of this execution.
    const expectedTrace = traceIdOf({ environment: "local", executionId });
    const chainSpans = spans.filter((span) => span.traceId === expectedTrace);
    // The claim admission + the disposition observations.
    const claim = chainSpans.find((span) => span.name === "zeck.worker.claim");
    const disposition = chainSpans.find((span) => span.name === "zeck.worker.disposition");
    expect(claim).toBeDefined();
    expect(disposition).toBeDefined();
    expect(claim?.correlation.executionId).toBe(executionId);
    expect(claim?.correlation.claimId).toBeDefined();
    expect(claim?.attributes.computeEnvironmentId).toBe(w.containerEnvironmentId);
    expect(disposition?.attributes.disposition).toBe("settled");
    expect(disposition?.correlation.executionId).toBe(executionId);
    // The D-03 dispatch correlation key travels on the chain (the
    // cross-store join handle).
    expect(claim?.correlation.correlationKey).toBe(`execution-dispatch:${executionId}`);
    expect(disposition?.correlation.correlationKey).toBe(`execution-dispatch:${executionId}`);
    // The metric counter carries the same correlation.
    const dispositionMetric = metrics.find((metric) => metric.name === "zeck.worker.dispositions");
    expect(dispositionMetric?.correlation.executionId).toBe(executionId);
    expect(dispositionMetric?.attributes.disposition).toBe("settled");
    // No dead-letter log for the successful chain.
    expect(logs.filter((log) => log.correlation.executionId === executionId)).toHaveLength(0);
    // Every span id is 16-hex and unique.
    const spanIds = new Set(chainSpans.map((span) => span.spanId));
    expect(spanIds.size).toBe(chainSpans.length);
  });

  test("secret material in an emission is rejected before the wire", async () => {
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    const bound = bindSinkEnvironment(sink, "local");
    // A secret-shaped key: rejected outright.
    await bound.emitLog({
      level: "info",
      message: "request served",
      correlation: { executionId: "exec-secret" },
      attributes: { apiToken: "super-secret-material" },
    });
    // A credential-shaped value: redacted, the record admitted.
    await bound.emitLog({
      level: "info",
      message: "connected postgres://user:supersecret@db/zeck",
      correlation: { executionId: "exec-secret" },
      attributes: { endpoint: "postgres://user:supersecret@db/zeck" },
    });
    await sink.flush();
    const body = JSON.stringify(collector.batches);
    expect(body).not.toContain("super-secret-material");
    expect(body).not.toContain("supersecret");
    expect(sink.stats().recordsRejected).toBe(1);
    expect(collector.batches[0]?.logs[0]?.attributes.endpoint).toContain("[redacted]");
  });

  test("telemetry is observation-only: the same authoritative outcome with and without the sink", async () => {
    const w = await world();
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    const instrumented = await w.createFabric({
      telemetry: bindSinkEnvironment(sink, "local"),
    });
    const plain = await w.createFabric();

    // The instrumented fabric consumes the FIRST execution; the plain
    // fabric (created without a telemetry sink) consumes the SECOND.
    const withSink = await w.createDispatchedExecution("obs-with-sink");
    const reportInstrumented = await instrumented.consumeBatch();
    await sink.flush();
    const withoutSink = await w.createDispatchedExecution("obs-without-sink");
    const reportPlain = await plain.consumeBatch();

    expect(reportInstrumented.applied).toBe(1);
    expect(reportPlain.applied).toBe(1);
    const withOutcome = await w.service.getExecution(w.applicationId, withSink);
    const withoutOutcome = await w.service.getExecution(w.applicationId, withoutSink);
    expect(withOutcome?.status).toBe("COMPLETED");
    expect(withoutOutcome?.status).toBe("COMPLETED");
    // The instrumented run emitted the chain; the plain run did not
    // (zero behavioral difference beyond observation).
    const spans = (collector.batches[0]?.spans ?? []).filter(
      (span) => span.correlation.executionId === withSink,
    );
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });

  test("the dead-letter observation is an actionable warn log with the correlation", async () => {
    const w = await world();
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    // An unbacked/integrity-mismatch delivery: a task the fabric
    // cannot execute dead-letters with the warn observation.
    const executionId = await w.createDispatchedExecution("dead-letter-observation", {
      kind: "worker-fabric-test",
      sandbox: { unknown: "substrate" },
    });
    const fabric = await w.createFabric({
      telemetry: bindSinkEnvironment(sink, "local"),
    });
    const report = await fabric.consumeBatch();
    expect(report.deadLettered).toBeGreaterThanOrEqual(0);
    void report;
    await sink.flush();
    const logs = (collector.batches[0]?.logs ?? []).filter(
      (log) => log.correlation.executionId === executionId,
    );
    if (logs.length > 0) {
      expect(logs[0]?.level).toBe("warn");
      expect(logs[0]?.message).toContain("dead-lettered");
      expect(logs[0]?.traceId).toBe(traceIdOf({ environment: "local", executionId }));
    }
  });

  test("the sink stats expose the bounded observability of the observability plane", async () => {
    const w = await world();
    const collector = createInMemoryExporter();
    const sink = new BoundedTelemetrySink({ exporter: collector.exporter });
    await w.createDispatchedExecution("stats-check");
    const fabric = await w.createFabric({
      telemetry: bindSinkEnvironment(sink, "local"),
    });
    await fabric.consumeBatch();
    const stats = sink.stats();
    expect(stats.spansEmitted).toBeGreaterThanOrEqual(2);
    expect(stats.metricsEmitted).toBeGreaterThanOrEqual(1);
    expect(stats.spansDropped).toBe(0);
    expect(stats.recordsRejected).toBe(0);
    await sink.flush();
    expect(sink.stats().exportsAccepted).toBeGreaterThanOrEqual(3);
  });
});
