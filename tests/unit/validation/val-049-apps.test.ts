/**
 * VAL-049 acceptance criteria 1, 2 and 5 (the app boundary + the
 * configuration consistency): the reproducibility and anti-gaming
 * audit application over the public SDK boundary.
 *
 *   * the corpus + configuration consistency: config.json mirrors the
 *     exported task slice exactly; the row ids unique; every audited
 *     work order VAL-041..048 covered by the reproducibility arm; every
 *     evidence digest reference well-formed and resolvable; the live
 *     gating honest (exactly ONE live row, NOT RUN without the
 *     credential); the pinned audit verdicts re-derive mechanically;
 *   * the app over the honest fake world: every offline row lands ONE
 *     durable execution and settles its honest terminal (COMPLETED for
 *     the honest audit rows — the replays, the boundaries, the bounds
 *     checks and the gaming detections alike; FAILED for the four
 *     adversarial audit probes whose dishonest audit shapes FAIL their
 *     named criteria) with the task bodies carrying REFERENCES ONLY;
 *   * the customer-boundary discriminations: a fabricated
 *     pass-with-fail FAILs the app-terminal-criteria-agreement; a
 *     terminal override FAILs the app-expected-terminal; a rejected
 *     submission FAILs the submission-landed criterion honestly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runAuditApp } from "../../../benchmarks/validation/apps/economic-audit/application";
import {
  AUDIT_CORPUS,
  AUDIT_CORPUS_VERSION,
  AUDIT_ROW_IDS,
  AUDIT_TASK_KIND,
  AUDITED_WORK_ORDERS,
  auditRowById,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  pinnedAuditInputDigest,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-audit/corpus";
import {
  deriveAuditVerdict,
  replayRecordedEvidenceOf,
} from "../../../benchmarks/validation/apps/economic-audit/driver";
import {
  createAuditFakeApiWorld,
  createTickClock,
  gamingProbesFor,
} from "../../../benchmarks/validation/apps/economic-audit/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "https://fake.example.test",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "0123456789abcdef0123456789abcdef01234567",
  corpusRevision: "0123456789abcdef0123456789abcdef01234567",
  integrationSurface: "audit:recorded-evidence-replay",
  pollIntervalMs: 10,
  completionTimeoutMs: 5_000,
};

async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly clock?: ReturnType<typeof createTickClock>;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
}) {
  const clock = options.clock ?? createTickClock();
  const world = createAuditFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runAuditApp({
    config: baseConfig,
    token: "test-token",
    transport: world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-049-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return { outcome, world };
}

// ---------------------------------------------------------------------------
// The corpus + configuration consistency
// ---------------------------------------------------------------------------

describe("VAL-049 corpus + configuration consistency", () => {
  test("config.json mirrors the exported task slice exactly", () => {
    const config = JSON.parse(
      readFileSync(
        join(process.cwd(), "benchmarks/validation/apps/economic-audit/config.json"),
        "utf8",
      ),
    ) as {
      readonly tokenEnvVar: string;
      readonly integrationSurface: string;
      readonly tasks: readonly { readonly kind: string; readonly rowId: string }[];
    };
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("audit:recorded-evidence-replay");
    expect(config.tasks.map((task) => task.rowId)).toEqual([...AUDIT_ROW_IDS]);
    for (const task of config.tasks) {
      expect(task.kind).toBe(AUDIT_TASK_KIND);
    }
    expect(JSON.stringify(config)).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(JSON.stringify(config)).not.toContain("Bearer ");
  });

  test("the row ids are unique and the corpus declares every audited work order", () => {
    expect(new Set(AUDIT_ROW_IDS).size).toBe(AUDIT_ROW_IDS.length);
    expect(AUDIT_CORPUS_VERSION).toBe("val-049-economic-audit-v1");
    // Every audited work order VAL-041..048 is covered by the
    // reproducibility arm's declared scope.
    const covered = new Set(OFFLINE_CORPUS_ROWS.flatMap((row) => row.auditedWorkOrders));
    for (const workOrder of AUDITED_WORK_ORDERS) {
      expect(covered, workOrder).toContain(workOrder);
    }
    // The arms and verdicts are the declared vocabulary only.
    for (const row of AUDIT_CORPUS) {
      expect(["REPRODUCIBILITY", "ANTI-GAMING", "BOUNDS"]).toContain(row.arm);
      expect(
        [
          "REPRODUCIBLE-VERIFIED",
          "BOUNDS-HELD",
          "GAMING-DETECTED",
          "NOT-AUDITABLE",
          "adversarial-failed",
        ],
        row.rowId,
      ).toContain(row.expected.verdict);
    }
  });

  test("every evidence digest reference is well-formed and resolvable", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      for (const reference of row.evidence) {
        expect(reference.recordedDigest, `${row.rowId}/${reference.corpusRowId}`).toMatch(
          /^[0-9a-f]{8}$/,
        );
        expect(reference.recordedVerdict.length, row.rowId).toBeGreaterThan(0);
        const replay = replayRecordedEvidenceOf(reference);
        expect(replay.resolvable, `${row.rowId}/${reference.corpusRowId}`).toBe(true);
      }
    }
    // The audited digests never leak payload bytes (digests only) and
    // never a credential shape (the scan matches provider-key shapes,
    // not honest hyphenated words like "accepted-risk").
    for (const row of OFFLINE_CORPUS_ROWS) {
      const body = JSON.stringify(taskBodyFor({ row }));
      expect(body, row.rowId).not.toMatch(/microUsd|amount|token[s]?[,:"]/);
      expect(body, row.rowId).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    }
  });

  test("the pinned audit verdicts re-derive over the recorded evidence", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const replays = row.evidence.map((reference) => replayRecordedEvidenceOf(reference));
      const probes = gamingProbesFor(row);
      const derived = deriveAuditVerdict({ row, replays, probes });
      expect(derived.verdict, row.rowId).toBe(row.expected.verdict);
      expect(derived.mechanism ?? "none", row.rowId).toBe(row.expected.mechanism ?? "none");
      expect(derived.reason ?? "none", row.rowId).toBe(row.expected.reason ?? "none");
    }
  });

  test("every anti-gaming row's probe is caught with the mechanism NAMED", () => {
    const antiGaming = OFFLINE_CORPUS_ROWS.filter((row) => row.arm === "ANTI-GAMING");
    expect(antiGaming.length).toBeGreaterThanOrEqual(14);
    for (const row of antiGaming) {
      const probes = gamingProbesFor(row);
      for (const probe of probes) {
        expect(probe.caught, `${row.rowId}/${probe.vectors.join("+")}`).toBe(true);
        expect(probe.mechanisms.length, row.rowId).toBe(probe.vectors.length);
      }
    }
  });

  test("the live gating is honest (exactly ONE live row, NOT RUN without the credential)", () => {
    const liveRows = AUDIT_CORPUS.filter((row) => row.needsDispatch);
    expect(liveRows).toHaveLength(1);
    for (const row of liveRows) {
      expect(row.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
      expect(liveGateOpen(row, process.env) || process.env.OPENROUTER_API_KEY === undefined).toBe(
        true,
      );
      expect(liveGateOpen(row, {})).toBe(false);
      expect(liveGateOpen(row, { OPENROUTER_API_KEY: "" })).toBe(false);
    }
    // The offline corpus stays drivable without any credential.
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(row.needsDispatch, row.rowId).toBe(false);
    }
  });

  test("the corpus input digest is stable and the row lookup resolves", () => {
    expect(pinnedAuditInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedAuditInputDigest()).toBe(pinnedAuditInputDigest());
    for (const rowId of AUDIT_ROW_IDS) {
      expect(auditRowById(rowId)?.rowId).toBe(rowId);
    }
    expect(auditRowById("no-such-row")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-049 the app over the honest fake world", () => {
  test("every offline row lands ONE durable execution and settles its honest terminal", async () => {
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, row.rowId).toBe(1);
      expect(outcome.observedTerminal, row.rowId).toBe(row.expected.terminal);
      expect(outcome.passed, row.rowId).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence), row.rowId).toEqual([]);
      const failed = outcome.auditCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(outcome.submissionLatencyMs).toHaveLength(1);
    }
  });

  test("the task bodies carry references only (never prices, never result copies)", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const body = taskBodyFor({ row }) as { auditedEvidence: readonly unknown[] };
      expect(body.auditedEvidence, row.rowId).toHaveLength(row.evidence.length);
    }
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations
// ---------------------------------------------------------------------------

describe("VAL-049 customer-boundary discriminations", () => {
  test("a fabricated pass-with-fail FAILs the app-terminal-criteria-agreement", async () => {
    const taskIndex = AUDIT_CORPUS.findIndex(
      (candidate) => candidate.rowId === "probe-audit-rubber-stamp",
    );
    const { outcome } = await runAppOverFakeWorld({ taskIndex, fabricatePassWithFail: true });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.auditCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a terminal override FAILs the app-expected-terminal criterion", async () => {
    const taskIndex = AUDIT_CORPUS.findIndex(
      (candidate) => candidate.rowId === "replay-controls-recorded-arms",
    );
    const { outcome } = await runAppOverFakeWorld({ taskIndex, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.auditCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a rejected submission FAILs the submission-landed criterion honestly", async () => {
    const clock = createTickClock();
    // Reject every POST at the transport level (the boundary refusal).
    const rejectingTransport = async () =>
      new Response(JSON.stringify({ code: "CAPABILITY_UNAVAILABLE", message: "no" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    const outcome = await runAuditApp({
      config: baseConfig,
      token: "test-token",
      transport: rejectingTransport,
      now: clock.now,
      sleep: async () => {},
      environment: {
        runtime: "node test",
        toolchain: "vitest",
        database: "none",
        configuration: { suite: "val-049-apps" },
      },
      runSuffix: "unit",
      taskIndex: 0,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.auditCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "submission-landed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The adversarial audit-probe rows over the app boundary
// ---------------------------------------------------------------------------

describe("VAL-049 the adversarial audit-probe rows over the app boundary", () => {
  test("each adversarial audit-probe row settles FAILED (the app observes the honest failure)", async () => {
    const probes = OFFLINE_CORPUS_ROWS.filter((row) => row.adversarial !== undefined);
    expect(probes).toHaveLength(4);
    expect(new Set(probes.map((row) => row.adversarial)).size).toBe(4);
    for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
      if (row.adversarial === undefined) {
        continue;
      }
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.observedTerminal, row.rowId).toBe("FAILED");
      expect(outcome.passed, row.rowId).toBe(true);
    }
  });
});
