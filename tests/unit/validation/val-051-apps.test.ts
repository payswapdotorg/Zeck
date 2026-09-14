/**
 * VAL-051 acceptance criteria (the app boundary + the configuration
 * consistency + the honest verdicts): the end-to-end production-pilot
 * application over the public SDK boundary.
 *
 *   * the corpus + configuration consistency: config.json mirrors the
 *     exported task slice exactly; the row ids unique; every row
 *     declares its window, shift schedule and recorded-input digests;
 *     every recorded-input digest reference is well-formed and
 *     resolvable (the VAL-050 journey rows + the VAL-049 audit
 *     anchors); the pinned pilot verdicts + drift classifications
 *     re-derive over the deterministic window feeds; every probe row
 *     declares the criterion it must FAIL (the seven issued probes
 *     1:1); the live gating is honest (exactly ONE live row, NOT RUN
 *     without the credential); the corpus input digest is stable; the
 *     config is secret-free;
 *   * the app over the honest fake world: every offline row lands ONE
 *     durable execution and settles its honest terminal (COMPLETED +
 *     PILOT-COMPLETED with the boundary criteria 8/8 for the honest
 *     rows); the task bodies carry REFERENCES ONLY;
 *   * the customer-boundary discriminations: a fabricated
 *     pass-with-fail FAILs the app-terminal-criteria-agreement; a
 *     terminal override FAILs the app-expected-terminal criterion; a
 *     rejected submission FAILs the submission-landed criterion
 *     honestly;
 *   * the adversarial probe rows over the app boundary: each of the
 *     seven settles FAILED with its NAMED criterion (the boundary
 *     re-derivation never trusting the platform's own claim); the
 *     corpus covers the issued observation-family vocabulary; the
 *     drift classification is carried in the pinned verdicts
 *     (within-bounds / drifting-named / regressing-reported).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  JOURNEY_STAGES,
  journeyRowById,
} from "../../../benchmarks/validation/apps/customer-journey/corpus";
import { auditRowById } from "../../../benchmarks/validation/apps/economic-audit/corpus";
import { economicDigestOf } from "../../../benchmarks/validation/apps/economic-baseline/driver";
import { runPilotApp } from "../../../benchmarks/validation/apps/production-pilot/application";
import {
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PILOT_CARRIED_AUDIT_ROW_IDS,
  PILOT_CORPUS,
  PILOT_CORPUS_VERSION,
  PILOT_CUSTOMER_APPLICATION_ID,
  PILOT_ROW_IDS,
  PILOT_TASK_KIND,
  PILOT_WORKLOAD_CLASSES,
  PROBE_CORPUS_ROWS,
  PROBE_FAILED_CRITERIA_OF,
  PROBE_MECHANISM_OF,
  pilotRowById,
  pilotRowResultFor,
  pinnedPilotInputDigest,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/production-pilot/corpus";
import {
  carriedBasisDigestOf,
  DRIFT_CLASSIFICATIONS,
  deriveShiftSchedule,
  deriveWindowDrift,
  drivePilotRow,
  LIVE_PILOT_PLAN,
  PILOT_OBSERVATION_FAMILIES,
  PILOT_VERDICT_KINDS,
} from "../../../benchmarks/validation/apps/production-pilot/driver";
import {
  createPilotFakeApiWorld,
  createTickClock,
  pilotWindowFeedFor,
} from "../../../benchmarks/validation/apps/production-pilot/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";

const baseConfig = {
  applicationId: PILOT_CUSTOMER_APPLICATION_ID,
  baseUrl: "https://fake.example.test",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "0123456789abcdef0123456789abcdef01234567",
  corpusRevision: "0123456789abcdef0123456789abcdef01234567",
  integrationSurface: "production-pilot:window",
  pollIntervalMs: 10,
  completionTimeoutMs: 5_000,
};

async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly clock?: ReturnType<typeof createTickClock>;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly env?: Record<string, string | undefined>;
}) {
  const clock = options.clock ?? createTickClock();
  const world = createPilotFakeApiWorld({
    clock,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runPilotApp({
    config: baseConfig,
    token: "test-token",
    transport: world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "bun test",
      toolchain: "bun",
      database: "none",
      configuration: { suite: "val-051-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
    env: options.env ?? {},
  });
  return { outcome, world };
}

const HONEST_ROW_IDS = [
  "pilot-window-full-recorded-portfolio",
  "pilot-shift-resume-exactly-once",
  "pilot-drift-drifting-named",
  "pilot-drift-regressing-reported",
  "pilot-incident-recorded-attributed",
  "pilot-budget-reservations-settled",
];
const PROBE_ROW_IDS = [
  "probe-pilot-cherry-picked-window",
  "probe-pilot-dropped-shift",
  "probe-pilot-double-driven-resume",
  "probe-pilot-drift-normalizing",
  "probe-pilot-incident-hiding",
  "probe-pilot-residual-hiding",
  "probe-pilot-boundary-leak",
];
const LIVE_ROW_ID = "live-pilot-real-window-slice";

/** The verbatim token each probe's failed criterion must NAME (the catch). */
const PROBE_NAMED_EVIDENCE_OF: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "probe-pilot-cherry-picked-window": ["omitted-shift:4..5", "cherry-picked-sub-window"],
  "probe-pilot-dropped-shift": ["missed-shift:3"],
  "probe-pilot-double-driven-resume": [
    "shift 3 daily-usage:attempts=3,declared=2",
    "double-driven-resume:shift 3 daily-usage",
  ],
  "probe-pilot-drift-normalizing": [
    "hidden-regression:shift 5 daily-usage",
    "claimed within-declared-bounds, derived regressing",
  ],
  "probe-pilot-incident-hiding": ["hidden-incident:shift 2 daily-usage"],
  "probe-pilot-residual-hiding": [
    "window-total-residual:reported 79800microUsd, observed Σ shifts 81000microUsd, residual -1200microUsd",
  ],
  "probe-pilot-boundary-leak": ["foreign-application:shift 4", "app-other-customer"],
});

// ---------------------------------------------------------------------------
// The corpus + configuration consistency
// ---------------------------------------------------------------------------

describe("VAL-051 corpus + configuration consistency", () => {
  test("config.json mirrors the exported task slice exactly", () => {
    const config = JSON.parse(
      readFileSync(
        join(process.cwd(), "benchmarks/validation/apps/production-pilot/config.json"),
        "utf8",
      ),
    ) as {
      readonly tokenEnvVar: string;
      readonly integrationSurface: string;
      readonly corpusVersion: string;
      readonly corpusInputDigest: string;
      readonly tasks: readonly {
        readonly kind: string;
        readonly rowId: string;
        readonly workloadClass: string;
        readonly window: {
          readonly declaredShifts: number;
          readonly driftTolerancePct: number;
          readonly declaredDivergences: readonly unknown[];
        };
        readonly shifts: readonly string[];
        readonly observationFamilies: readonly string[];
        readonly expectedVerdict: string;
        readonly expectedFailedCriteria: readonly string[];
        readonly expectedTerminal: string;
        readonly probe?: string;
        readonly liveGate?: readonly string[];
      }[];
    };
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("production-pilot:window");
    expect(config.corpusVersion).toBe(PILOT_CORPUS_VERSION);
    expect(config.corpusInputDigest).toBe(pinnedPilotInputDigest());
    expect(config.tasks.map((task) => task.rowId)).toEqual([...PILOT_ROW_IDS]);
    for (const [index, task] of config.tasks.entries()) {
      expect(task.kind, task.rowId).toBe(PILOT_TASK_KIND);
      const row = pilotRowById(task.rowId);
      expect(row, task.rowId).not.toBeNull();
      // The config task mirrors the corpus row exactly...
      expect(task.workloadClass, task.rowId).toBe(row?.workloadClass);
      expect(task.window.declaredShifts, task.rowId).toBe(row?.window.declaredShifts);
      expect(task.window.driftTolerancePct, task.rowId).toBe(row?.window.driftTolerancePct);
      expect(task.window.declaredDivergences, task.rowId).toEqual(row?.window.declaredDivergences);
      expect(task.shifts, task.rowId).toEqual(
        row?.schedule.shifts.map((shift) => shift.journeyRowId),
      );
      expect(task.observationFamilies, task.rowId).toEqual([...(row?.observationFamilies ?? [])]);
      expect(task.expectedVerdict, task.rowId).toBe(row?.expected.verdict);
      expect(task.expectedFailedCriteria, task.rowId).toEqual([
        ...(row?.expected.failedCriteria ?? []),
      ]);
      expect(task.expectedTerminal, task.rowId).toBe(row?.expected.terminal);
      expect(task.probe ?? undefined, task.rowId).toBe(row?.probe?.kind);
      expect(task.liveGate ?? undefined, task.rowId).toEqual(row?.liveGate?.envVars);
      // ...and the window/operating-profile declarations carry across.
      const schedule = row?.schedule;
      expect(task.window.declaredShifts, task.rowId).toBe(schedule?.shifts.length);
      for (const journeyRowId of task.shifts) {
        expect(journeyRowById(journeyRowId), `${task.rowId}/${journeyRowId}`).not.toBeNull();
      }
      expect(index).toBe(PILOT_ROW_IDS.indexOf(task.rowId));
    }
  });

  test("the row ids are unique and the corpus declares every window, shift schedule and recorded-input digest", () => {
    expect(new Set(PILOT_ROW_IDS).size).toBe(PILOT_ROW_IDS.length);
    expect(PILOT_ROW_IDS).toHaveLength(14);
    expect(PILOT_CORPUS_VERSION).toBe("val-051-production-pilot-v1");
    for (const row of PILOT_CORPUS) {
      // The verdict vocabulary is the declared vocabulary only.
      expect(PILOT_VERDICT_KINDS, row.rowId).toContain(row.expected.verdict);
      // The workload classes are the declared vocabulary only.
      expect(PILOT_WORKLOAD_CLASSES, row.rowId).toContain(row.workloadClass);
      // The observation families are the declared vocabulary only.
      expect(row.observationFamilies.length, row.rowId).toBeGreaterThan(0);
      for (const family of row.observationFamilies) {
        expect(PILOT_OBSERVATION_FAMILIES, row.rowId).toContain(family);
      }
      // The declared window matches the declared schedule.
      expect(row.window.declaredShifts, row.rowId).toBe(row.shiftDeclarations.length);
      expect(row.window.declaredShifts, row.rowId).toBe(row.schedule.shifts.length);
      expect(row.window.declaredSpan, row.rowId).toEqual({
        firstShift: 0,
        lastShift: row.window.declaredShifts - 1,
      });
      expect(row.window.driftTolerancePct, row.rowId).toBeGreaterThan(0);
      // The schedule digest is a payload-free FNV-1a and re-derives (PURE).
      expect(row.schedule.scheduleDigest, row.rowId).toMatch(/^[0-9a-f]{8}$/);
      const rederived = deriveShiftSchedule({ shifts: row.shiftDeclarations });
      expect(rederived.scheduleDigest, row.rowId).toBe(row.schedule.scheduleDigest);
      // Every shift's RECORDED workload reference resolves and every
      // recorded-input digest is a payload-free FNV-1a.
      expect(row.recordedInputReferences.length, row.rowId).toBe(row.schedule.shifts.length);
      for (const reference of row.recordedInputReferences) {
        expect(
          journeyRowById(reference.journeyRowId),
          `${row.rowId}/${reference.journeyRowId}`,
        ).not.toBeNull();
        expect(
          reference.recordedInputDigests.length,
          `${row.rowId}/${reference.shift}`,
        ).toBeGreaterThan(0);
        for (const digest of reference.recordedInputDigests) {
          expect(digest, `${row.rowId}/shift${reference.shift}`).toMatch(/^[0-9a-f]{8}$/);
        }
        expect(
          reference.basisAuditRowIds.length,
          `${row.rowId}/shift${reference.shift}`,
        ).toBeGreaterThan(0);
      }
    }
    for (const rowId of HONEST_ROW_IDS) {
      const row = pilotRowById(rowId);
      expect(row?.expected.verdict).toBe("PILOT-COMPLETED");
      expect(row?.expected.failedCriteria).toEqual([]);
      expect(row?.expected.terminal).toBe("COMPLETED");
      expect(row?.probe).toBeUndefined();
      expect(row?.needsDispatch).toBe(false);
    }
  });

  test("every recorded-input digest reference is well-formed and resolvable (the VAL-050 journey rows + the VAL-049 audit anchors)", () => {
    for (const row of PILOT_CORPUS) {
      for (const shift of row.schedule.shifts) {
        const journeyRow = journeyRowById(shift.journeyRowId);
        expect(journeyRow, `${row.rowId}/shift${shift.shift}`).not.toBeNull();
        if (journeyRow === null) {
          continue;
        }
        // The failure shape is the RECORDED one, never synthesized.
        expect(shift.failureStage, `${row.rowId}/shift${shift.shift}`).toBe(
          journeyRow.midJourneyFailureStage ?? null,
        );
        if (shift.failureStage !== null) {
          expect(JOURNEY_STAGES, `${row.rowId}/shift${shift.shift}`).toContain(shift.failureStage);
        }
        // The segments carry the journey row's OWN stage declarations
        // (the recorded input digests and the audited economics).
        expect(shift.segments.length, `${row.rowId}/shift${shift.shift}`).toBe(
          journeyRow.stages.length,
        );
        for (const [index, segment] of shift.segments.entries()) {
          const stage = journeyRow.stages[index];
          expect(segment.stage, `${row.rowId}/shift${shift.shift}/${index}`).toBe(stage?.stage);
          expect(segment.recordedInputDigests, `${row.rowId}/shift${shift.shift}/${index}`).toEqual(
            [...(stage?.recordedInputDigests ?? [])],
          );
          // The carried VAL-049 economics anchor re-derives through the
          // audit corpus's OWN resolver (the carried cost basis).
          expect(
            segment.economics.basisAuditRowId,
            `${row.rowId}/shift${shift.shift}/${index}`,
          ).toBe(stage?.economics.basisAuditRowId);
          expect(segment.economics.basisDigest, `${row.rowId}/shift${shift.shift}/${index}`).toBe(
            carriedBasisDigestOf(segment.economics.basisAuditRowId),
          );
          expect(segment.economics.basisDigest).toMatch(/^[0-9a-f]{8}$/);
        }
      }
    }
    // Every carried audit anchor resolves (a drifted corpus THROWS at
    // module load — here we assert the resolved surface directly).
    expect(PILOT_CARRIED_AUDIT_ROW_IDS.length).toBeGreaterThan(0);
    for (const auditRowId of PILOT_CARRIED_AUDIT_ROW_IDS) {
      expect(auditRowById(auditRowId), auditRowId).not.toBeNull();
      expect(carriedBasisDigestOf(auditRowId)).toMatch(/^[0-9a-f]{8}$/);
    }
    // An unknown anchor is unresolvable by construction.
    expect(auditRowById("no-such-audit-row")).toBeNull();
  });

  test("the pinned pilot verdicts + drift classifications re-derive over the deterministic window feeds", () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const feed = pilotWindowFeedFor(row);
      expect(feed, row.rowId).not.toBeNull();
      // The feed is deterministic (PURE — the same record derives twice).
      expect(pilotWindowFeedFor(row), row.rowId).toEqual(feed);
      const result = drivePilotRow({
        rowId: row.rowId,
        window: row.window,
        schedule: row.schedule,
        policy: row.operatingProfile,
        observation: feed,
      });
      expect(result.terminal, row.rowId).toBe(row.expected.verdict);
      expect([...result.failedCriteria].sort(), row.rowId).toEqual(
        [...row.expected.failedCriteria].sort(),
      );
      // The corpus's own result view agrees with the re-derivation.
      expect(pilotRowResultFor(row).terminal, row.rowId).toBe(result.terminal);
      // The honest rows' pinned drift findings re-derive over the feed.
      if (row.probe === undefined) {
        const findings = deriveWindowDrift({
          window: row.window,
          schedule: row.schedule,
          observation: feed,
        })
          .filter((drift) => drift.beyondTolerance)
          .map((drift) => ({
            shift: drift.shift,
            stage: drift.stage,
            classification: drift.classification,
            mechanism: drift.mechanism,
          }));
        expect(findings, row.rowId).toEqual(row.expected.driftFindings);
      }
    }
    // The ONE live row holds NO offline feed (its window record is
    // MEASURED at run time — an offline fabrication is banned) and the
    // corpus derives its honest NOT-RUN with the env var NAMED.
    const liveRow = LIVE_CORPUS_ROWS[0];
    if (liveRow === undefined) {
      throw new Error("the live slice is empty");
    }
    expect(pilotWindowFeedFor(liveRow)).toBeNull();
    const liveResult = pilotRowResultFor(liveRow);
    expect(liveResult.terminal).toBe("NOT-RUN");
    expect(liveResult.notRun).toBe(true);
    expect(liveResult.failedCriteria).toEqual([]);
    expect(liveResult.reason).toContain("OPENROUTER_API_KEY");
  });

  test("every probe row declares the criterion it must FAIL (the seven issued probes 1:1)", () => {
    expect(PROBE_CORPUS_ROWS.map((row) => row.rowId)).toEqual(PROBE_ROW_IDS);
    expect(new Set(PROBE_CORPUS_ROWS.map((row) => row.probe?.kind)).size).toBe(7);
    expect(Object.keys(PROBE_FAILED_CRITERIA_OF).sort()).toEqual(
      [
        "boundary-leak",
        "cherry-picked-window",
        "double-driven-resume",
        "drift-normalizing",
        "dropped-shift",
        "incident-hiding",
        "residual-hiding",
      ].sort(),
    );
    for (const row of PROBE_CORPUS_ROWS) {
      const kind = row.probe?.kind;
      expect(kind, row.rowId).toBeDefined();
      expect(row.expected.verdict, row.rowId).toBe("PILOT-FAILED");
      expect(row.expected.terminal, row.rowId).toBe("FAILED");
      // A FAILED verdict always NAMEs at least one failed criterion...
      expect(row.expected.failedCriteria.length, row.rowId).toBeGreaterThan(0);
      // ...exactly the pinned surface for its issued probe kind.
      expect(row.expected.failedCriteria, row.rowId).toEqual([
        ...(PROBE_FAILED_CRITERIA_OF[kind as keyof typeof PROBE_FAILED_CRITERIA_OF] ?? []),
      ]);
      // The mechanism is NAMED per the pinned vocabulary and cites at
      // least one of the row's FAILing criteria families.
      const mechanism = PROBE_MECHANISM_OF[kind as keyof typeof PROBE_MECHANISM_OF];
      expect(mechanism, row.rowId).toMatch(/^[a-z-]+:[a-z-]/);
      expect(
        row.expected.failedCriteria.some((criterion) => mechanism.includes(criterion)),
        `${row.rowId}: ${mechanism}`,
      ).toBe(true);
      // A probe row is offline (never live-gated, zero credentials).
      expect(row.liveGate, row.rowId).toBeUndefined();
      expect(row.needsDispatch, row.rowId).toBe(false);
      expect(row.expected.driftFindings, row.rowId).toEqual([]);
    }
  });

  test("the live gating is honest (exactly ONE live row, NOT RUN without the credential)", async () => {
    expect(LIVE_CORPUS_ROWS).toHaveLength(1);
    const liveRow = LIVE_CORPUS_ROWS[0];
    if (liveRow === undefined) {
      throw new Error("the live slice is empty");
    }
    expect(liveRow.rowId).toBe(LIVE_ROW_ID);
    expect(liveRow.needsDispatch).toBe(true);
    expect(liveRow.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveRow.expected.verdict).toBe("NOT-RUN");
    expect(liveRow.expected.terminal).toBe("COMPLETED");
    expect(LIVE_PILOT_PLAN.envVar).toBe("OPENROUTER_API_KEY");
    // The gate consults the env var honestly.
    expect(liveGateOpen(liveRow, {})).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "" })).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
    // The offline corpus stays drivable without any credential.
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(row.needsDispatch, row.rowId).toBe(false);
      expect(row.liveGate, row.rowId).toBeUndefined();
    }
    // Through the app boundary: NOT RUN with the env var NAMED and
    // ZERO submissions (never a fake success).
    const taskIndex = PILOT_ROW_IDS.indexOf(LIVE_ROW_ID);
    const { outcome, world } = await runAppOverFakeWorld({ taskIndex, env: {} });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.verdict).toBe("NOT-RUN");
    expect(outcome.notRunReason).toContain("OPENROUTER_API_KEY");
    expect(outcome.passed).toBe(true);
    expect(outcome.submission).toBeNull();
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.verificationStatuses).toEqual([]);
    expect(outcome.usage).toBeNull();
    expect(outcome.appCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "app-live-gate-honest",
    ]);
    expect(outcome.appCriteria[0]?.status).toBe("PASS");
    expect(outcome.appCriteria[0]?.evidence.join(" ")).toContain("NOT RUN");
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    // The offline fake world refuses the live rail outright — even a
    // spoofed credential meets the typed refusal (a live pilot window
    // is never fabricated offline).
    const spoofed = await runAppOverFakeWorld({
      taskIndex,
      env: { OPENROUTER_API_KEY: "spoofed-credential" },
    });
    expect(spoofed.world.createdExecutions).toBe(0);
    expect(spoofed.outcome.verdict).toBe("PILOT-FAILED");
    expect(spoofed.outcome.passed).toBe(false);
    expect(spoofed.outcome.observedTerminal).toBeNull();
    expect(spoofed.outcome.appCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "submission-landed",
    ]);
    expect(spoofed.outcome.appCriteria[0]?.status).toBe("FAIL");
  });

  test("the corpus input digest is stable and the row lookup resolves", () => {
    expect(pinnedPilotInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedPilotInputDigest()).toBe(pinnedPilotInputDigest());
    // The digest is the FNV-1a over the pinned corpus vocabulary (the
    // imported convention — never re-implemented).
    expect(pinnedPilotInputDigest()).toBe(
      economicDigestOf({
        version: PILOT_CORPUS_VERSION,
        rows: [...PILOT_ROW_IDS],
        customer: PILOT_CUSTOMER_APPLICATION_ID,
      }),
    );
    for (const rowId of PILOT_ROW_IDS) {
      expect(pilotRowById(rowId)?.rowId).toBe(rowId);
    }
    expect(pilotRowById("no-such-pilot-row")).toBeNull();
  });

  test("the config is secret-free (the anchored scan)", () => {
    const raw = readFileSync(
      join(process.cwd(), "benchmarks/validation/apps/production-pilot/config.json"),
      "utf8",
    );
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(raw).not.toMatch(/Bearer /i);
    expect(raw).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(raw).not.toMatch(/(?:api[_-]?key|secret|password|credential)\s*["']?\s*[:=]/i);
    // The credential env var appears ONLY as the live gate's declared
    // name — never as an assigned value.
    expect(raw).not.toMatch(/OPENROUTER_API_KEY\s*[:=]\s*["'][^"'\s]+/);
    const values: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        values.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          collect(item);
        }
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          collect((value as Record<string, unknown>)[key]);
        }
      }
    };
    collect(JSON.parse(raw));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      // No opaque credential-shaped value anywhere in the config (a
      // classic base64 or hex token — the declared identifiers are
      // hyphenated words and never match these shapes).
      expect(value, JSON.stringify(value)).not.toMatch(/^[A-Za-z0-9+/]{32,}={0,2}$/);
      expect(value, JSON.stringify(value)).not.toMatch(/^[0-9a-f]{32,}$/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-051 the app over the honest fake world", () => {
  test("every offline row lands ONE durable execution and settles its honest terminal", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const taskIndex = PILOT_ROW_IDS.indexOf(row.rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      // ONE durable execution, fresh (never a replay).
      expect(world.createdExecutions, row.rowId).toBe(1);
      expect(outcome.submission?.executionId, row.rowId).not.toBe("");
      expect(outcome.submission?.replayed, row.rowId).toBe(false);
      // The honest terminal + verdict settle exactly as pinned.
      expect(outcome.observedTerminal, row.rowId).toBe(row.expected.terminal);
      expect(outcome.verdict, row.rowId).toBe(row.expected.verdict);
      expect(outcome.passed, row.rowId).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence), row.rowId).toEqual([]);
      const failedApp = outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedApp, `${row.rowId}: ${JSON.stringify(failedApp)}`).toEqual([]);
      // The usage is honestly none-reported offline (the shifts replay
      // recorded workloads — the economics are the recorded basis).
      expect(outcome.usage, row.rowId).toBeNull();
      expect(outcome.notRunReason, row.rowId).toBeNull();
      expect(outcome.submissionLatencyMs, row.rowId).toBeGreaterThanOrEqual(0);
    }
    // The honest rows: COMPLETED + PILOT-COMPLETED with the boundary
    // criteria 8/8 (every observation family PASSes at the boundary).
    for (const rowId of HONEST_ROW_IDS) {
      const taskIndex = PILOT_ROW_IDS.indexOf(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.observedTerminal, rowId).toBe("COMPLETED");
      expect(outcome.verdict, rowId).toBe("PILOT-COMPLETED");
      expect(
        outcome.pilotCriteria.map((criterion) => criterion.criterionId),
        rowId,
      ).toEqual([...PILOT_OBSERVATION_FAMILIES]);
      const failedPilot = outcome.pilotCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedPilot, `${rowId}: ${JSON.stringify(failedPilot)}`).toEqual([]);
    }
  });

  test("the task bodies carry references only (never prices, never recorded-result copies)", () => {
    for (const row of PILOT_CORPUS) {
      const body = JSON.stringify(taskBodyFor({ row }));
      expect(body, row.rowId).not.toMatch(/microUsd|amount|token[s]?[,:"]/i);
      expect(body, row.rowId).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(body, row.rowId).not.toMatch(/[0-9a-f]{8,}["']?:["'][0-9]/);
      expect(body, row.rowId).toContain(row.rowId);
      expect(body, row.rowId).toContain(PILOT_TASK_KIND);
      expect(body, row.rowId).toContain(row.workloadClass);
      // The recorded inputs are referenced by COUNT only — the digests
      // themselves never ride the task body.
      const parsed = taskBodyFor({ row }) as {
        readonly pilot: { readonly recordedInputDigests: readonly number[] };
      };
      for (const count of parsed.pilot.recordedInputDigests) {
        expect(count, row.rowId).toBeGreaterThan(0);
      }
      expect(JSON.stringify(parsed.pilot.recordedInputDigests), row.rowId).not.toMatch(/[a-f]/);
    }
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations (the controlled fakes)
// ---------------------------------------------------------------------------

describe("VAL-051 customer-boundary discriminations", () => {
  const honestIndex = PILOT_ROW_IDS.indexOf("pilot-window-full-recorded-portfolio");

  test("a fabricated pass-with-fail FAILs the app-terminal-criteria-agreement", async () => {
    const taskIndex = PILOT_ROW_IDS.indexOf("probe-pilot-dropped-shift");
    const { outcome } = await runAppOverFakeWorld({ taskIndex, fabricatePassWithFail: true });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.appCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
    expect(agreement?.evidence.join(" ")).toContain("DISAGREED");
  });

  test("a terminal override FAILs the app-expected-terminal criterion", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: honestIndex, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.appCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
    expect(expected?.evidence.join(" ")).toContain("expected:COMPLETED");
    expect(expected?.evidence.join(" ")).toContain("observed:FAILED");
  });

  test("a rejected submission FAILs the submission-landed criterion honestly", async () => {
    const clock = createTickClock();
    // Reject every POST at the transport level (the boundary refusal).
    const rejectingTransport = async () =>
      new Response(JSON.stringify({ code: "CAPABILITY_UNAVAILABLE", message: "no" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    const outcome = await runPilotApp({
      config: baseConfig,
      token: "test-token",
      transport: rejectingTransport,
      now: clock.now,
      sleep: async () => {},
      environment: {
        runtime: "bun test",
        toolchain: "bun",
        database: "none",
        configuration: { suite: "val-051-apps" },
      },
      runSuffix: "unit",
      taskIndex: 0,
      env: {},
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.verdict).toBe("PILOT-FAILED");
    // An honest app failure with NO pilot window to reconcile (never a
    // fabricated completion).
    expect(outcome.appCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "submission-landed",
    ]);
    expect(outcome.appCriteria[0]?.status).toBe("FAIL");
    expect(outcome.appCriteria[0]?.evidence.join(" ")).toContain(
      "rejection:the submission never landed a durable execution",
    );
    expect(outcome.pilotCriteria).toEqual([]);
    expect(outcome.submission?.rejection?.code).toBe("CAPABILITY_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// The adversarial probe rows over the app boundary
// ---------------------------------------------------------------------------

describe("VAL-051 the adversarial probe rows over the app boundary", () => {
  test("each of the seven adversarial probe rows settles FAILED with its NAMED criterion", async () => {
    for (const rowId of PROBE_ROW_IDS) {
      const row = pilotRowById(rowId);
      const taskIndex = PILOT_ROW_IDS.indexOf(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("FAILED");
      expect(outcome.verdict, rowId).toBe("PILOT-FAILED");
      expect(outcome.passed, rowId).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence), rowId).toEqual([]);
      // The app honestly confirms the expected FAILED verdict and its
      // NAMED criteria (never trusting the platform's own claim).
      const verdict = outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-pilot-verdict",
      );
      expect(verdict?.status, rowId).toBe("PASS");
      const named = outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-failed-criteria-named",
      );
      expect(named?.status, rowId).toBe("PASS");
      // The boundary re-derivation FAILs exactly the row's pinned
      // NAMED criteria...
      const failed = outcome.pilotCriteria
        .filter((criterion) => criterion.status === "FAIL")
        .map((criterion) => criterion.criterionId)
        .sort();
      expect(failed, rowId).toEqual([...(row?.expected.failedCriteria ?? [])].sort());
      // ...and each failed criterion's evidence NAMES the offender
      // verbatim (the house pattern).
      const namedTokens = PROBE_NAMED_EVIDENCE_OF[rowId] ?? [];
      expect(namedTokens.length, rowId).toBeGreaterThan(0);
      for (const token of namedTokens) {
        expect(
          outcome.pilotCriteria
            .filter((candidate) => candidate.status === "FAIL")
            .some((candidate) => candidate.evidence.some((line) => line.includes(token))),
          `${rowId}/${token}`,
        ).toBe(true);
      }
    }
  });

  test("the corpus covers the issued observation-family vocabulary (each of the 8 criteria exercised by ≥1 honest row)", () => {
    expect([...PILOT_OBSERVATION_FAMILIES]).toEqual([
      "window-honesty",
      "schedule-completeness",
      "continuation-exactly-once",
      "drift-classification-honesty",
      "incident-honesty",
      "budget-policy-envelope",
      "end-of-window-reconciliation",
      "customer-boundary-integrity",
    ]);
    const honestRows = OFFLINE_CORPUS_ROWS.filter((row) => row.probe === undefined);
    expect(honestRows.map((row) => row.rowId)).toEqual(HONEST_ROW_IDS);
    for (const family of PILOT_OBSERVATION_FAMILIES) {
      const covered = honestRows.filter((row) => row.observationFamilies.includes(family));
      expect(covered.length, family).toBeGreaterThan(0);
      // The canonical full-window row exercises ALL eight families.
      expect(pilotRowById("pilot-window-full-recorded-portfolio")?.observationFamilies).toEqual([
        ...PILOT_OBSERVATION_FAMILIES,
      ]);
    }
    // The engine derives exactly the eight criteria (one per issued
    // family, in the issued order).
    const canonical = pilotRowResultFor(pilotRowById("pilot-window-full-recorded-portfolio"));
    expect(canonical.criteria.map((criterion) => criterion.criterionId)).toEqual([
      ...PILOT_OBSERVATION_FAMILIES,
    ]);
  });

  test("the drift classification is carried in the pinned verdicts (within-bounds / drifting-named / regressing-reported)", async () => {
    // The three-way vocabulary (never two-way).
    expect([...DRIFT_CLASSIFICATIONS]).toEqual([
      "within-declared-bounds",
      "drifting",
      "regressing",
    ]);
    // The within-bounds row pins NO drift finding.
    const full = pilotRowById("pilot-window-full-recorded-portfolio");
    expect(full?.expected.driftFindings).toEqual([]);
    // The drifting row pins its finding with the mechanism NAMED.
    const drifting = pilotRowById("pilot-drift-drifting-named");
    expect(drifting?.expected.driftFindings).toEqual([
      {
        shift: 4,
        stage: "daily-usage",
        classification: "drifting",
        mechanism: "load-shaping cohort mix",
      },
    ]);
    // The regressing row pins its finding reported AS regressing (the
    // mechanism honestly null — never normalized, never hidden).
    const regressing = pilotRowById("pilot-drift-regressing-reported");
    expect(regressing?.expected.driftFindings).toEqual([
      { shift: 5, stage: "daily-usage", classification: "regressing", mechanism: null },
    ]);
    // All three honest rows still COMPLETE — the honest finding IS the
    // verified outcome — with the classification carried at the app
    // boundary in the criteria's own evidence.
    const fullIndex = PILOT_ROW_IDS.indexOf("pilot-window-full-recorded-portfolio");
    const fullRun = await runAppOverFakeWorld({ taskIndex: fullIndex });
    expect(fullRun.outcome.verdict).toBe("PILOT-COMPLETED");
    const fullDrift = fullRun.outcome.pilotCriteria.find(
      (criterion) => criterion.criterionId === "drift-classification-honesty",
    );
    expect(fullDrift?.status).toBe("PASS");
    expect(fullDrift?.evidence.join(" ")).not.toContain("→ drifting");
    expect(fullDrift?.evidence.join(" ")).not.toContain("→ regressing");
    const driftingIndex = PILOT_ROW_IDS.indexOf("pilot-drift-drifting-named");
    const driftingRun = await runAppOverFakeWorld({ taskIndex: driftingIndex });
    expect(driftingRun.outcome.verdict).toBe("PILOT-COMPLETED");
    const driftingEvidence = driftingRun.outcome.pilotCriteria
      .find((criterion) => criterion.criterionId === "drift-classification-honesty")
      ?.evidence.join(" ");
    expect(driftingEvidence).toContain("drifting via load-shaping cohort mix");
    const regressingIndex = PILOT_ROW_IDS.indexOf("pilot-drift-regressing-reported");
    const regressingRun = await runAppOverFakeWorld({ taskIndex: regressingIndex });
    expect(regressingRun.outcome.verdict).toBe("PILOT-COMPLETED");
    const regressingEvidence = regressingRun.outcome.pilotCriteria
      .find((criterion) => criterion.criterionId === "drift-classification-honesty")
      ?.evidence.join(" ");
    expect(regressingEvidence).toContain("shift 5 daily-usage → regressing");
  });
});
