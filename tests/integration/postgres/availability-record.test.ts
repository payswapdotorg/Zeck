/**
 * Integration — the control-plane availability record over REAL
 * PostgreSQL (WORK-060 / D-08, AVA-001; checkpoints RELEASE-IDENTITY,
 * IDENTITY-IDEMPOTENCY, OBSERVABILITY-BOUNDARY evidence).
 *
 * WHAT THIS PROVES over the real database (migration 0029, schema
 * release_control):
 *
 *   A1 The availability window RECORDS as exact-revision gate evidence
 *      through the REAL SqlReleaseControlStore: the gate result carries
 *      the computed record, the release id (content-addressed over the
 *      exact git revision + manifest digest) and the deterministic
 *      evidence digest.
 *
 *   A2 IDENTITY-IDEMPOTENCY: re-computing the same window from the same
 *      observations produces the byte-identical record; re-recording
 *      appends a new attempt with the SAME digest (convergent evidence,
 *      never a rewrite).
 *
 *   A3 The alert-state integration: the recorded record parses back
 *      typed (latestAvailabilityRecord), a below-target window raises
 *      the CRITICAL availability alert and a semantics-violated window
 *      raises the critical correctness alert.
 *
 *   A4 FAIL-CLOSED SEMANTICS FROM REAL OBSERVATIONS: the readiness
 *      evaluation derives the availability outcome from a REAL probe —
 *      the live test server probes ready (served), a REAL dead endpoint
 *      (connection refused on an unused local port) probes the
 *      authoritative dependency unavailable → overall "down" → the
 *      outcome is refused-fail-closed (CORRECT behavior, measured as
 *      such); the real typed DatabaseUnavailableError of the dead
 *      endpoint is the control plane's refusal class.
 *
 *   A5 evaluateAlerts surfaces the availability alert of the active
 *      release's recorded window through the real alert plane (the
 *      promotion-blocking guardrail input).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, test } from "vitest";
import { evaluateAlerts, latestAvailabilityRecord } from "../../../deploy/release";
import { parseConnectionConfig } from "../../../src/platform/db/connection";
import { DatabaseUnavailableError } from "../../../src/platform/db/errors";
import { PgDatabasePort } from "../../../src/platform/db/pg-database-port";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import { evaluateReadiness } from "../../../src/platform/deployment/readiness";
import {
  type AvailabilityInterval,
  availabilityAlertOf,
  availabilityOutcomeOfReadiness,
  computeAvailabilityWindow,
} from "../../../src/platform/observability/availability";
import {
  evidenceDigestOf,
  releaseIdentityId,
  SqlReleaseControlStore,
} from "../../../src/platform/release";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadRealManifest() {
  return loadDeploymentManifest((file) =>
    readFileSync(resolve(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

const MANIFEST = loadRealManifest();

function uniqueRevision(): string {
  return `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** A real probe of one PostgreSQL endpoint (the smoke surface's form). */
async function probeRelationalState(url: string): Promise<"ready" | "unavailable"> {
  const config = parseConnectionConfig(url, { max: 1, connectionTimeoutMillis: 1500 });
  const port = new PgDatabasePort(config);
  try {
    await port.execute({ sql: "SELECT 1" });
    return "ready";
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return "unavailable";
    }
    throw error;
  } finally {
    await port.close();
  }
}

/** Find a genuinely dead local port (nothing listens there). */
async function deadLocalPort(): Promise<number> {
  for (let port = 55900; port <= 55999; port += 1) {
    const probe = new Client({
      connectionString: `postgres://127.0.0.1:${port}/postgres`,
      connectionTimeoutMillis: 400,
    });
    try {
      await probe.connect();
      await probe.end();
    } catch {
      return port; // connection refused — genuinely dead
    }
  }
  throw new Error("no dead local port found in the probe range");
}

definePgSuite("the control-plane availability record (WORK-060 D-08)", (ctx) => {
  test("A1 the availability window records as exact-revision gate evidence over the real ledger", async () => {
    const store = new SqlReleaseControlStore({
      db: ctx.port,
      now: () => new Date(),
      generateId: createUuidv7Generator(),
    });
    const revision = uniqueRevision();
    const manifestDigest = "a".repeat(64);
    const releaseId = releaseIdentityId(revision, manifestDigest);
    await store.recordRelease({ gitRevision: revision, manifestDigest, actor: "test" });

    const intervals: readonly AvailabilityInterval[] = [
      { startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-30T00:00:00Z", outcome: "served" },
    ];
    const record = computeAvailabilityWindow({
      environment: "local",
      window: "2026-09",
      revision: { releaseId, gitRevision: revision, manifestDigest },
      intervals,
      targetPct: 99.0,
    });

    const gate = await store.recordGateResult({
      releaseId,
      environment: "local",
      gateKind: "availability",
      status:
        record.withinTarget && record.failClosedSemantics === "preserved" ? "passed" : "failed",
      evidenceDigest: record.evidenceDigest,
      evidenceDetail: JSON.stringify(record),
      source: "tool-run",
      actor: "test",
    });

    // RELEASE-IDENTITY: the evidence is bound to the exact revision.
    expect(gate.releaseId).toBe(releaseId);
    expect(gate.evidenceDigest).toBe(record.evidenceDigest);
    expect(gate.evidenceDigest).not.toBe(evidenceDigestOf("something-else"));
    expect(gate.status).toBe("passed");
    expect(record.gitRevision).toBe(revision);
    expect(record.releaseId).toBe(releaseId);
  });

  test("A2 IDENTITY-IDEMPOTENCY: re-computation is byte-identical; re-recording converges with the same digest", async () => {
    const store = new SqlReleaseControlStore({
      db: ctx.port,
      now: () => new Date(),
      generateId: createUuidv7Generator(),
    });
    const revision = uniqueRevision();
    const manifestDigest = "b".repeat(64);
    const releaseId = releaseIdentityId(revision, manifestDigest);
    await store.recordRelease({ gitRevision: revision, manifestDigest, actor: "test" });

    const input = {
      environment: "local",
      window: "2026-09",
      revision: { releaseId, gitRevision: revision, manifestDigest },
      intervals: [
        { startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-29T00:00:00Z", outcome: "served" },
        {
          startedAt: "2026-09-29T00:00:00Z",
          endedAt: "2026-09-30T00:00:00Z",
          outcome: "refused-fail-closed",
        },
      ] satisfies readonly AvailabilityInterval[],
      targetPct: 99.0,
    };
    const first = computeAvailabilityWindow(input);
    const second = computeAvailabilityWindow(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const gate1 = await store.recordGateResult({
      releaseId,
      environment: "local",
      gateKind: "availability",
      status: "passed",
      evidenceDigest: first.evidenceDigest,
      evidenceDetail: JSON.stringify(first),
      source: "tool-run",
      actor: "test",
    });
    const gate2 = await store.recordGateResult({
      releaseId,
      environment: "local",
      gateKind: "availability",
      status: "failed",
      evidenceDigest: second.evidenceDigest,
      evidenceDetail: JSON.stringify(second),
      source: "tool-run",
      actor: "test",
    });
    // Append-only evidence: a new attempt, never a rewrite; the digest
    // converges (the deterministic computation is the same evidence).
    expect(gate2.attempt).toBe(gate1.attempt + 1);
    expect(gate2.evidenceDigest).toBe(gate1.evidenceDigest);
    const effective = await store.effectiveGateResults(releaseId, "local");
    expect(effective.filter((gate) => gate.gateKind === "availability")).toHaveLength(1);
  });

  test("A3 the alert-state integration: the recorded record parses back typed and raises the right alert", async () => {
    const store = new SqlReleaseControlStore({
      db: ctx.port,
      now: () => new Date(),
      generateId: createUuidv7Generator(),
    });
    const revision = uniqueRevision();
    const manifestDigest = "c".repeat(64);
    const releaseId = releaseIdentityId(revision, manifestDigest);
    await store.recordRelease({ gitRevision: revision, manifestDigest, actor: "test" });
    // Activate the release so latestAvailabilityRecord can resolve the
    // active deployment (the alert integration reads the ACTIVE release).
    await store.recordEnvironmentDeployment({
      releaseId,
      environment: "local",
      deploymentIdentityId: "d".repeat(64),
      resourceDigest: "e".repeat(64),
      actor: "test",
    });
    await store.recordPromotionDecision({
      releaseId,
      fromPhase: "none",
      toPhase: "local",
      decision: "promoted",
      reason: "test activation",
      actor: "test",
    });
    await store.activate({
      environment: "local",
      releaseId,
      requiredGates: [],
      actor: "test",
    });

    // A BELOW-TARGET window: refused-fail-closed time is honest
    // unavailability (never counted as serving) but CORRECT behavior.
    const belowTarget = computeAvailabilityWindow({
      environment: "local",
      window: "2026-09",
      revision: { releaseId, gitRevision: revision, manifestDigest },
      intervals: [
        { startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-28T00:00:00Z", outcome: "served" },
        {
          startedAt: "2026-09-28T00:00:00Z",
          endedAt: "2026-09-30T00:00:00Z",
          outcome: "refused-fail-closed",
        },
      ],
      targetPct: 99.0,
    });
    expect(belowTarget.withinTarget).toBe(false);
    expect(belowTarget.failClosedSemantics).toBe("preserved");
    await store.recordGateResult({
      releaseId,
      environment: "local",
      gateKind: "availability",
      status: "failed",
      evidenceDigest: belowTarget.evidenceDigest,
      evidenceDetail: JSON.stringify(belowTarget),
      source: "tool-run",
      actor: "test",
    });

    const parsed = await latestAvailabilityRecord(store, "local");
    expect(parsed).not.toBeNull();
    expect(parsed?.window).toBe("2026-09");
    expect(parsed?.availabilityPct).toBe(belowTarget.availabilityPct);
    const alert = availabilityAlertOf(parsed as NonNullable<typeof parsed>);
    expect(alert?.kind).toBe("availability");
    expect(alert?.severity).toBe("critical");
    expect(alert?.detail).toContain("CORRECT behavior, not counted as serving");

    // A SEMANTICS-VIOLATED window raises the critical correctness alert.
    const violated = computeAvailabilityWindow({
      environment: "local",
      window: "2026-08",
      revision: { releaseId, gitRevision: revision, manifestDigest },
      intervals: [
        { startedAt: "2026-08-01T00:00:00Z", endedAt: "2026-08-30T00:00:00Z", outcome: "served" },
        {
          startedAt: "2026-08-30T00:00:00Z",
          endedAt: "2026-08-31T00:00:00Z",
          outcome: "served-against-dead-authority",
        },
      ],
      targetPct: 99.0,
    });
    const violationAlert = availabilityAlertOf(violated);
    expect(violationAlert?.severity).toBe("critical");
    expect(violationAlert?.detail).toContain("SERVING against a dead authority");
  });

  test("A4 fail-closed semantics from REAL observations: live authority → served; dead endpoint → refused-fail-closed (correct)", async () => {
    // The live test server: a REAL probe against the REAL authority.
    const liveStatus = await probeRelationalState(ctx.adminUrl.replace(/\/[^/]*$/, "/postgres"));
    expect(liveStatus).toBe("ready");
    const liveReport = evaluateReadiness(MANIFEST, {
      controlPlaneAvailable: true,
      probes: [{ concern: "relational-state", status: liveStatus }],
    });
    expect(liveReport.overall).toBe("ready");
    expect(availabilityOutcomeOfReadiness(liveReport.overall)).toBe("served");

    // A REAL dead endpoint (connection refused on a genuinely unused
    // port): the authoritative dependency is unreachable → the plane is
    // DOWN → the availability outcome is refused-fail-closed — CORRECT
    // behavior, measured as such (never "served", never a violation).
    const deadPort = await deadLocalPort();
    const deadUrl = `postgres://127.0.0.1:${deadPort}/postgres`;
    const deadStatus = await probeRelationalState(deadUrl);
    expect(deadStatus).toBe("unavailable");
    const deadReport = evaluateReadiness(MANIFEST, {
      controlPlaneAvailable: true,
      probes: [{ concern: "relational-state", status: deadStatus }],
    });
    expect(deadReport.overall).toBe("down");
    const outcome = availabilityOutcomeOfReadiness(deadReport.overall);
    expect(outcome).toBe("refused-fail-closed");

    // The window that includes the fail-closed interval classifies the
    // semantics as PRESERVED and the availability number drops honestly.
    const record = computeAvailabilityWindow({
      environment: "local",
      window: "2026-09",
      revision: {
        releaseId: releaseIdentityId(uniqueRevision(), "f".repeat(64)),
        gitRevision: uniqueRevision(),
        manifestDigest: "f".repeat(64),
      },
      intervals: [
        { startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-29T00:00:00Z", outcome: "served" },
        { startedAt: "2026-09-29T00:00:00Z", endedAt: "2026-09-30T00:00:00Z", outcome },
      ],
      targetPct: 99.0,
    });
    expect(record.failClosedSemantics).toBe("preserved");
    expect(record.withinTarget).toBe(false);
    expect(record.refusedFailClosedMs).toBe(86_400_000);
  });

  test("A5 evaluateAlerts surfaces the availability alert of the active release's recorded window", async () => {
    const store = new SqlReleaseControlStore({
      db: ctx.port,
      now: () => new Date(),
      generateId: createUuidv7Generator(),
    });
    const revision = uniqueRevision();
    const manifestDigest = "1".repeat(64);
    const releaseId = releaseIdentityId(revision, manifestDigest);
    await store.recordRelease({ gitRevision: revision, manifestDigest, actor: "test" });
    await store.recordEnvironmentDeployment({
      releaseId,
      environment: "local",
      deploymentIdentityId: "2".repeat(64),
      resourceDigest: "3".repeat(64),
      actor: "test",
    });
    await store.recordPromotionDecision({
      releaseId,
      fromPhase: "none",
      toPhase: "local",
      decision: "promoted",
      reason: "test activation",
      actor: "test",
    });
    await store.activate({ environment: "local", releaseId, requiredGates: [], actor: "test" });

    const breached = computeAvailabilityWindow({
      environment: "local",
      window: "2026-09",
      revision: { releaseId, gitRevision: revision, manifestDigest },
      intervals: [
        { startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-25T00:00:00Z", outcome: "served" },
        {
          startedAt: "2026-09-25T00:00:00Z",
          endedAt: "2026-09-30T00:00:00Z",
          outcome: "refused-fail-closed",
        },
      ],
      targetPct: 99.0,
    });
    await store.recordGateResult({
      releaseId,
      environment: "local",
      gateKind: "availability",
      status: "failed",
      evidenceDigest: breached.evidenceDigest,
      evidenceDetail: JSON.stringify(breached),
      source: "tool-run",
      actor: "test",
    });

    // The real alert evaluation (the promotion-blocking guardrail input)
    // includes the availability alert through the store integration.
    const alerts = await evaluateAlerts(ctx.port, "local", { store });
    const availabilityAlerts = alerts.filter((alert) => alert.kind === "availability");
    expect(availabilityAlerts).toHaveLength(1);
    expect(availabilityAlerts[0]?.severity).toBe("critical");
    expect(availabilityAlerts[0]?.subject).toContain("control-plane-availability@local:2026-09");
  });
});
