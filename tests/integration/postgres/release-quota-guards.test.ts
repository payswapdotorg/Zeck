/**
 * Integration — the cost/quota guards over REAL PostgreSQL (WORK-047
 * / D-06; the COST-QUOTA-GUARDS checkpoint).
 *
 * Proves over the real database with the REAL governed stores (the
 * worker-world fixture: real executions, real claim admission, real
 * correlation envelopes):
 *
 *  - the quota snapshot collection reads the AUTHORITATIVE stores
 *    (compute_plane live claims vs environment quotas, queue backlog,
 *    dead letters, terminal-failed executions, database size);
 *  - the alert evaluation fires warnings BEFORE exhaustion and
 *    criticals at the edge (the repository thresholds);
 *  - the D-05 hard cap remains the overage guard: the claim beyond
 *    the quota is refused fail-closed (no uncontrolled paid overage);
 *  - the release-gate-failures operational counter reads the
 *    release_control ledger.
 */

import { expect, test } from "vitest";
import {
  collectOperationalSnapshots,
  collectQuotaSnapshots,
  evaluateAlerts,
} from "../../../deploy/release";
import { hasCriticalAlert } from "../../../src/platform/observability/alerts";
import { payloadDigestOf } from "../../../src/platform/queue/correlation";
import { evidenceDigestOf, SqlReleaseControlStore } from "../../../src/platform/release";
import { definePgSuite } from "./harness";
import { generateId, seedWorkerFabricWorld } from "./worker-world";

definePgSuite("release quota guards (WORK-047 D-06)", (ctx) => {
  const world = () => seedWorkerFabricWorld(ctx.port);

  test("the compute-claims snapshot reads live claims vs the environment quota", async () => {
    const w = await world();
    await w.store.setEnvironmentQuota(w.containerEnvironmentId, 4);
    const snapshots = await collectQuotaSnapshots(ctx.port, "local");
    const compute = snapshots.find(
      (snapshot) =>
        snapshot.guard === "compute-claims" &&
        snapshot.environment === `local:${w.containerEnvironmentId}`,
    );
    expect(compute).toBeDefined();
    expect(compute?.limit).toBe(4);
    expect(compute?.used).toBe(0);

    // Two REAL live claims through the governed admission path.
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 8 },
      new Date().toISOString(),
    );
    for (const suffix of ["q1", "q2"]) {
      const executionId = await w.createDispatchedExecution(suffix);
      const outcome = await w.store.acquireClaim(
        {
          workerId,
          executionId,
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          environmentId: w.environmentId,
          computeEnvironmentId: w.containerEnvironmentId,
        },
        new Date().toISOString(),
      );
      expect(outcome.outcome).toBe("admitted");
    }
    const after = await collectQuotaSnapshots(ctx.port, "local");
    const computeAfter = after.find(
      (snapshot) =>
        snapshot.guard === "compute-claims" &&
        snapshot.environment === `local:${w.containerEnvironmentId}`,
    );
    expect(computeAfter?.used).toBe(2);
    expect(computeAfter?.limit).toBe(4);
  });

  test("warnings fire BEFORE exhaustion and criticals at the edge (the repository thresholds)", async () => {
    const w = await world();
    // Quota 4 with the repository thresholds (warn 80% / critical 95%):
    // 4 live claims / 4 = 100% → critical; 3/4 = 75% → quiet; but the
    // quota bound [1,512] allows quota 5: 4/5 = 80% → warning.
    await w.store.setEnvironmentQuota(w.containerEnvironmentId, 5);
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 8 },
      new Date().toISOString(),
    );
    for (let index = 0; index < 4; index += 1) {
      const executionId = await w.createDispatchedExecution(`warn-${index}`);
      const outcome = await w.store.acquireClaim(
        {
          workerId,
          executionId,
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          environmentId: w.environmentId,
          computeEnvironmentId: w.containerEnvironmentId,
        },
        new Date().toISOString(),
      );
      expect(outcome.outcome).toBe("admitted");
    }
    const warning = await evaluateAlerts(ctx.port, "local");
    const computeWarning = warning.find(
      (alert) => alert.subject === `compute-claims@local:${w.containerEnvironmentId}`,
    );
    expect(computeWarning?.severity).toBe("warning");
    expect(computeWarning?.action).toContain("raise the quota");
    expect(hasCriticalAlert(warning.filter((alert) => alert.severity !== "warning"))).toBe(false);

    // The 5th claim: 5/5 = 100% → critical (alert BEFORE the operator
    // loses capacity; the hard cap already refuses the 6th).
    const fifth = await w.createDispatchedExecution("critical-5");
    const fifthOutcome = await w.store.acquireClaim(
      {
        workerId,
        executionId: fifth,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: w.containerEnvironmentId,
      },
      new Date().toISOString(),
    );
    expect(fifthOutcome.outcome).toBe("admitted");
    const critical = await evaluateAlerts(ctx.port, "local");
    const computeCritical = critical.find(
      (alert) => alert.subject === `compute-claims@local:${w.containerEnvironmentId}`,
    );
    expect(computeCritical?.severity).toBe("critical");
    expect(hasCriticalAlert(critical)).toBe(true);
  });

  test("the D-05 hard cap stays the overage guard (the claim beyond the quota is refused typed)", async () => {
    const w = await world();
    await w.store.setEnvironmentQuota(w.containerEnvironmentId, 1);
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 8 },
      new Date().toISOString(),
    );
    const first = await w.createDispatchedExecution("cap-1");
    expect(
      (
        await w.store.acquireClaim(
          {
            workerId,
            executionId: first,
            applicationId: w.applicationId,
            tenantId: w.tenantId,
            environmentId: w.environmentId,
            computeEnvironmentId: w.containerEnvironmentId,
          },
          new Date().toISOString(),
        )
      ).outcome,
    ).toBe("admitted");
    const second = await w.createDispatchedExecution("cap-2");
    const refusal = await w.store.acquireClaim(
      {
        workerId,
        executionId: second,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: w.containerEnvironmentId,
      },
      new Date().toISOString(),
    );
    expect(refusal.outcome).toBe("refused");
    if (refusal.outcome === "refused") {
      expect(refusal.reason.kind).toBe("quota-saturated");
    }
    // The guard state the alert evaluates stays consistent with the cap.
    const snapshots = await collectQuotaSnapshots(ctx.port, "local");
    const compute = snapshots.find(
      (snapshot) =>
        snapshot.guard === "compute-claims" &&
        snapshot.environment === `local:${w.containerEnvironmentId}`,
    );
    expect(compute?.used).toBe(1);
    expect(compute?.limit).toBe(1);
  });

  test("operational snapshots read the authoritative error counters (dead letters + gate failures)", async () => {
    const w = await world();
    const before = await collectOperationalSnapshots(ctx.port);
    const metricsBefore = new Map(before.map((snapshot) => [snapshot.metric, snapshot.value]));
    expect(metricsBefore.get("queue-dead-letters")).toBe(0);

    // A REAL dead letter through the correlation store.
    const executionId = await w.createDispatchedExecution("dead-letter-seed");
    const payload = { seeded: true };
    const { envelope } = await w.correlation.recordIntent({
      id: generateId(),
      executionId,
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      correlationKey: `execution-dispatch:${executionId}`,
      purpose: "execution-dispatch",
      payload,
      payloadDigest: payloadDigestOf(payload),
      replayOf: null,
    });
    await w.correlation.deadLetter(envelope.id, "governed-rejection", 1, "quota-test seed");

    // A failed release-gate attempt through the REAL store.
    const store = new SqlReleaseControlStore({
      db: ctx.port,
      now: () => new Date(),
      generateId: () => `id-${Math.random().toString(16).slice(2, 10)}`,
    });
    const revision = `${generateId().replaceAll("-", "")}${generateId()
      .replaceAll("-", "")
      .slice(0, 8)}`;
    const release = await store.recordRelease({
      gitRevision: revision,
      manifestDigest: "a".repeat(64),
      actor: "quota-test",
    });
    await store.recordGateResult({
      releaseId: release.releaseId,
      environment: "ci",
      gateKind: "typecheck",
      status: "failed",
      evidenceDigest: evidenceDigestOf("failure"),
      evidenceDetail: "exit 1 (seeded failure)",
      source: "tool-run",
      actor: "quota-test",
    });

    const after = await collectOperationalSnapshots(ctx.port);
    const metricsAfter = new Map(after.map((snapshot) => [snapshot.metric, snapshot.value]));
    expect(metricsAfter.get("queue-dead-letters")).toBe(1);
    expect(metricsAfter.get("release-gate-failures")).toBe(1);
  });
});
