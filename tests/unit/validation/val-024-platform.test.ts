/**
 * VAL-024 acceptance criteria 1, 2, 4, 5: the tenant-isolation
 * platform slice against controlled fakes — the probe taxonomy and
 * the PURE probe plans (each corpus row's declared rejection matches
 * the plan's expectations), the typed-rejection matcher, the
 * foreign-content evidence scan, the row-count invariant derivations,
 * the pre-effect probe-task validation and the execution driver over
 * every offline corpus row (the fake isolation world replays the REAL
 * locked-row semantics: TENANT_SCOPE_VIOLATION for the locked-row
 * probes, scope-checked misses for the reads, the accounted journal
 * writes and the untouched foreign world).
 */

import { describe, expect, test } from "vitest";
import {
  type IsolationCorpusRow,
  TENANT_ISOLATION_CORPUS,
} from "../../../benchmarks/validation/apps/tenant-isolation/corpus";
import {
  createFakeIsolationWorld,
  createFakeLifecycle,
  type FakeWorldMutations,
  FOREIGN_ACTOR_ID,
  FOREIGN_APPLICATION_ID,
  FOREIGN_CONTENT_MARKERS,
  FOREIGN_ENVIRONMENT_ID,
  FOREIGN_TASK_CANARY,
  FOREIGN_TENANT_ID,
  fixedForeignRefs,
  OWN_ACTOR_ID,
  OWN_APPLICATION_ID,
  OWN_TENANT_ID,
} from "../../../benchmarks/validation/apps/tenant-isolation/fixtures";
import {
  deriveIsolationCriteria,
  deriveRowCountViolations,
  driveTenantIsolationExecution,
  ISOLATION_PROBES,
  type IsolationProbeOutcomeRecord,
  isolationDigestOf,
  matchProbeObservation,
  planIsolationProbes,
  rejectionSummaryOfOutcome,
  scanEvidenceForForeignContent,
  validateIsolationProbeTask,
} from "../../../benchmarks/validation/platform/tenant-isolation";
// The REAL platform modules (the typed-rejection semantics are
// pre-dispatch — driven here against the REAL execution service over
// the platform's own in-memory store, which faithfully implements
// the SQL adapter's application-scoped locked-row discipline).
import { createInMemoryExecutions, type InMemoryExecutionStore } from "../executions/fakes";

const pinnedClock = () => new Date(1_000);

// ---------------------------------------------------------------------------
// The probe taxonomy and the PURE plans
// ---------------------------------------------------------------------------

describe("VAL-024 probe taxonomy and plans", () => {
  test("every probe kind has a non-empty plan with unique probe ids", () => {
    for (const kind of ISOLATION_PROBES) {
      const plan = planIsolationProbes(kind);
      expect(plan.length, `${kind} plan`).toBeGreaterThan(0);
      const ids = plan.map((planned) => planned.probeId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("every corpus row's declared rejection matches its plan's expectations (AC1)", () => {
    for (const row of TENANT_ISOLATION_CORPUS) {
      const plan = planIsolationProbes(row.probe);
      const serviceSummaries = plan
        .filter((planned) => planned.surface === "service")
        .map((planned) => rejectionSummaryOfOutcome(planned.expected));
      const wireSummaries = plan
        .filter((planned) => planned.surface === "wire")
        .map((planned) => rejectionSummaryOfOutcome(planned.expected));
      if (row.expectedRejection.service === "NOT_APPLICABLE") {
        expect(serviceSummaries.length, `${row.rowId} service plan`).toBe(0);
      } else {
        expect(serviceSummaries.length, `${row.rowId} service plan`).toBeGreaterThan(0);
        expect(serviceSummaries.every((summary) => summary === row.expectedRejection.service)).toBe(
          true,
        );
      }
      if (row.expectedRejection.wire === "NOT_APPLICABLE") {
        expect(wireSummaries.length, `${row.rowId} wire plan`).toBe(0);
      } else {
        expect(wireSummaries.length, `${row.rowId} wire plan`).toBeGreaterThan(0);
        expect(wireSummaries.every((summary) => summary === row.expectedRejection.wire)).toBe(true);
      }
    }
  });

  test("the locked-row families pin TENANT_SCOPE_VIOLATION; the read families pin the scope-checked miss; the control admits own data", () => {
    for (const row of TENANT_ISOLATION_CORPUS) {
      if (row.rowId.startsWith("control")) {
        expect(row.expectedRejection.service).toBe("OWN_SCOPE_DATA");
        continue;
      }
      const isLockedRowFamily = [
        "cross-tenant:create-application",
        "cross-tenant:create-environment",
        "cross-tenant:transition",
        "cross-tenant:step-event",
        "cross-tenant:planning-decision",
      ].includes(row.probe);
      if (isLockedRowFamily) {
        expect(row.expectedRejection.service).toBe("TENANT_SCOPE_VIOLATION");
      }
    }
    expect(
      planIsolationProbes("cross-tenant:read").some(
        (planned) => planned.expected.kind === "zero-rows",
      ),
    ).toBe(true);
    expect(
      planIsolationProbes("cross-tenant:forged-scope").every(
        (planned) =>
          planned.expected.kind === "typed-error" &&
          planned.expected.code === "AUTHORIZATION_DENIED" &&
          planned.expected.httpStatus === 403,
      ),
    ).toBe(true);
  });

  test("the control plan carries no typed rejection — the control never expects a denial", () => {
    for (const planned of planIsolationProbes("control:healthy")) {
      expect(planned.expected.kind).toBe("own-scope-data");
    }
  });

  test("the probe-task validation rejects malformed shapes pre-effect", () => {
    expect(
      validateIsolationProbeTask({
        kind: "isolation-probe",
        scenario: "x",
        probe: "cross-tenant:read",
      }),
    ).toEqual({ valid: true });
    expect(validateIsolationProbeTask(null)).toEqual({
      valid: false,
      reason: "task must be an object",
    });
    expect(validateIsolationProbeTask({ kind: "summarize", scenario: "x" }).valid).toBe(false);
    expect(
      validateIsolationProbeTask({
        kind: "isolation-probe",
        scenario: "",
        probe: "cross-tenant:read",
      }).valid,
    ).toBe(false);
    expect(
      validateIsolationProbeTask({ kind: "isolation-probe", scenario: "x", probe: "not-a-probe" })
        .valid,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The typed-rejection matcher (PURE)
// ---------------------------------------------------------------------------

describe("VAL-024 typed-rejection matcher", () => {
  test("an expected typed error matches only the same code (and the pinned wire status)", () => {
    expect(
      matchProbeObservation(
        { kind: "typed-error", code: "TENANT_SCOPE_VIOLATION", httpStatus: 403 },
        {
          kind: "typed-error",
          code: "TENANT_SCOPE_VIOLATION",
          httpStatus: 403,
          message: "boundary",
        },
      ),
    ).toBe(true);
    expect(
      matchProbeObservation(
        { kind: "typed-error", code: "TENANT_SCOPE_VIOLATION", httpStatus: null },
        {
          kind: "typed-error",
          code: "TENANT_SCOPE_VIOLATION",
          httpStatus: null,
          message: "boundary",
        },
      ),
    ).toBe(true);
    // The wrong code is a mismatch (never status-only matching).
    expect(
      matchProbeObservation(
        { kind: "typed-error", code: "TENANT_SCOPE_VIOLATION", httpStatus: null },
        { kind: "typed-error", code: "AUTHORIZATION_DENIED", httpStatus: 403, message: "boundary" },
      ),
    ).toBe(false);
    // The wrong wire status is a mismatch.
    expect(
      matchProbeObservation(
        { kind: "typed-error", code: "AUTHORIZATION_DENIED", httpStatus: 403 },
        { kind: "typed-error", code: "AUTHORIZATION_DENIED", httpStatus: 404, message: "boundary" },
      ),
    ).toBe(false);
    // An admission is a mismatch.
    expect(
      matchProbeObservation(
        { kind: "typed-error", code: "TENANT_SCOPE_VIOLATION", httpStatus: null },
        { kind: "unexpected-success", code: null, httpStatus: null, message: "admitted" },
      ),
    ).toBe(false);
  });

  test("an expected scope-checked miss matches only zero rows", () => {
    expect(
      matchProbeObservation(
        { kind: "zero-rows" },
        { kind: "zero-rows", code: null, httpStatus: null, message: "" },
      ),
    ).toBe(true);
    expect(
      matchProbeObservation(
        { kind: "zero-rows" },
        { kind: "unexpected-success", code: null, httpStatus: null, message: "data returned" },
      ),
    ).toBe(false);
    expect(
      matchProbeObservation(
        { kind: "zero-rows" },
        { kind: "typed-error", code: "TENANT_SCOPE_VIOLATION", httpStatus: null, message: "x" },
      ),
    ).toBe(false);
  });

  test("an expected own-scope admission matches only own-scope data", () => {
    expect(
      matchProbeObservation(
        { kind: "own-scope-data" },
        { kind: "own-scope-data", code: null, httpStatus: null, message: "own data" },
      ),
    ).toBe(true);
    expect(
      matchProbeObservation(
        { kind: "own-scope-data" },
        { kind: "zero-rows", code: null, httpStatus: null, message: "" },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The foreign-content evidence scan (PURE)
// ---------------------------------------------------------------------------

describe("VAL-024 foreign-content evidence scan", () => {
  test("clean evidence passes; planted foreign content is caught without echoing the material", () => {
    const clean = scanEvidenceForForeignContent(
      { message: "execution not found in this application", code: "TENANT_SCOPE_VIOLATION" },
      FOREIGN_CONTENT_MARKERS,
    );
    expect(clean.clean).toBe(true);
    const leaked = scanEvidenceForForeignContent(
      { message: `the other tenant's task is ${FOREIGN_TASK_CANARY}` },
      FOREIGN_CONTENT_MARKERS,
    );
    expect(leaked.clean).toBe(false);
    expect(leaked.findings.length).toBe(1);
    // The finding carries the LABEL and digest — never the material.
    expect(leaked.findings[0]).toContain("foreign-task-canary");
    expect(JSON.stringify(leaked)).not.toContain(FOREIGN_TASK_CANARY);
  });

  test("the markers are synthetic, distinct and digest-carrying", () => {
    const materials = FOREIGN_CONTENT_MARKERS.map((marker) => marker.material);
    expect(new Set(materials).size).toBe(FOREIGN_CONTENT_MARKERS.length);
    for (const marker of FOREIGN_CONTENT_MARKERS) {
      expect(marker.material).toContain("VAL024");
      expect(marker.digest).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// The row-count invariants (PURE)
// ---------------------------------------------------------------------------

const counts = (
  over: Partial<
    Record<"executions" | "executionEvents" | "verificationResults" | "idempotencyRecords", number>
  >,
) => ({
  executions: 0,
  executionEvents: 0,
  verificationResults: 0,
  idempotencyRecords: 0,
  ...over,
});

describe("VAL-024 row-count invariants", () => {
  const before = {
    ownApplication: counts({ executions: 3, executionEvents: 10, idempotencyRecords: 10 }),
    foreignApplication: counts({ executions: 1, executionEvents: 2, idempotencyRecords: 2 }),
  };

  test("an accounted journal-only battery passes", () => {
    const after = {
      ownApplication: counts({ executions: 3, executionEvents: 13, idempotencyRecords: 13 }),
      foreignApplication: counts({ executions: 1, executionEvents: 2, idempotencyRecords: 2 }),
    };
    expect(
      deriveRowCountViolations({
        before,
        after,
        accounted: { executionEvents: 3, idempotencyRecords: 3 },
      }),
    ).toEqual([]);
  });

  test("any foreign row change is a violation (zero foreign effects)", () => {
    const after = {
      ownApplication: counts({ executions: 3, executionEvents: 13, idempotencyRecords: 13 }),
      foreignApplication: counts({ executions: 1, executionEvents: 3, idempotencyRecords: 2 }),
    };
    const violations = deriveRowCountViolations({
      before,
      after,
      accounted: { executionEvents: 3, idempotencyRecords: 3 },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("foreign-application executionEvents");
  });

  test("an unaccounted own write is a violation (a silent probe write surfaces)", () => {
    const after = {
      ownApplication: counts({ executions: 3, executionEvents: 14, idempotencyRecords: 13 }),
      foreignApplication: counts({ executions: 1, executionEvents: 2, idempotencyRecords: 2 }),
    };
    const violations = deriveRowCountViolations({
      before,
      after,
      accounted: { executionEvents: 3, idempotencyRecords: 3 },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("own-application executionEvents delta 4");
  });

  test("a probe-created execution is a violation (no probe may create an execution)", () => {
    const after = {
      ownApplication: counts({ executions: 4, executionEvents: 13, idempotencyRecords: 13 }),
      foreignApplication: counts({ executions: 1, executionEvents: 2, idempotencyRecords: 2 }),
    };
    const violations = deriveRowCountViolations({
      before,
      after,
      accounted: { executionEvents: 3, idempotencyRecords: 3 },
    });
    expect(violations.some((violation) => violation.startsWith("own-application executions"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Digest determinism
// ---------------------------------------------------------------------------

describe("VAL-024 evidence digests", () => {
  test("identical probe requests produce identical digests; different references diverge", () => {
    const a = isolationDigestOf({
      probe: "svc-read-foreign-execution",
      reference: "foreign-execution",
    });
    expect(a).toBe(
      isolationDigestOf({ probe: "svc-read-foreign-execution", reference: "foreign-execution" }),
    );
    expect(a).not.toBe(
      isolationDigestOf({
        probe: "svc-read-reverse-foreign-scope",
        reference: "reverse-foreign-scope",
      }),
    );
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// The driver over every corpus row (the fake isolation world)
// ---------------------------------------------------------------------------

interface DrivenRow {
  readonly result: Awaited<ReturnType<typeof driveTenantIsolationExecution>>;
  readonly journal: readonly string[];
  readonly world: ReturnType<typeof createFakeIsolationWorld>;
}

async function driveRow(
  row: IsolationCorpusRow,
  mutations?: FakeWorldMutations,
): Promise<DrivenRow> {
  const world = createFakeIsolationWorld(mutations === undefined ? undefined : { mutations });
  const carrierId = world.seedCarrier();
  const { lifecycle, journal } = createFakeLifecycle(world);
  const result = await driveTenantIsolationExecution({
    executionId: carrierId,
    task: { kind: "isolation-probe", scenario: row.rowId, probe: row.probe },
    probe: row.probe,
    lifecycle,
    executions: world.executions,
    wire: world.wire,
    counts: world.counts,
    foreign: fixedForeignRefs(),
    own: { applicationId: OWN_APPLICATION_ID, tenantId: OWN_TENANT_ID, actorId: OWN_ACTOR_ID },
    now: pinnedClock,
    idempotencyPrefix: "val-024-unit",
  });
  return { result, journal: journal.probeIds, world };
}

describe("VAL-024 driver over every offline corpus row", () => {
  test("every row proves the isolation: denied, clean, zero effects, journaled exactly once", async () => {
    for (const row of TENANT_ISOLATION_CORPUS) {
      const { result, journal, world } = await driveRow(row);
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedCriteria, `${row.rowId} criteria: ${JSON.stringify(failedCriteria)}`).toEqual(
        [],
      );
      expect(result.deniedProbes).toBe(result.totalProbes);
      expect(result.leakedProbes).toBe(0);
      expect(result.rowCountViolations).toEqual([]);
      expect(result.usage).toContain("pre-dispatch scope checks");
      // The isolation journal: each probe exactly once, in plan order.
      const plan = planIsolationProbes(row.probe);
      expect([...journal]).toEqual(plan.map((planned) => planned.probeId));
      expect(result.journaledProbes).toBe(plan.length);
      // The foreign world is untouched (zero foreign effects).
      expect(world.state.foreignWrites.raw).toEqual([]);
      expect(world.state.foreignExecutionTouched).toBe(false);
    }
  }, 60_000);

  test("the service probes observe the pinned TENANT_SCOPE_VIOLATION codes; the reads observe zero rows", async () => {
    const transitionRow = TENANT_ISOLATION_CORPUS.find(
      (row) => row.rowId === "cross-tenant-transition",
    );
    if (transitionRow === undefined) throw new Error("missing transition row");
    const { result } = await driveRow(transitionRow);
    const typed = result.probes.filter(
      (record: IsolationProbeOutcomeRecord) => record.expectedKind === "typed-error",
    );
    expect(typed.length).toBeGreaterThan(0);
    for (const record of typed) {
      // Every typed probe observed EXACTLY its expected typed code —
      // the locked-row probes surface TENANT_SCOPE_VIOLATION, the
      // wire probes surface the pinned public codes.
      expect(record.observedCode, `${record.probeId}`).toBe(record.expectedCode);
      expect(record.observedKind).toBe("typed-error");
      expect(record.denied).toBe(true);
    }
    const serviceTyped = typed.filter((record) => record.surface === "service");
    expect(serviceTyped.length).toBeGreaterThan(0);
    for (const record of serviceTyped) {
      expect(record.observedCode).toBe("TENANT_SCOPE_VIOLATION");
    }

    const readRow = TENANT_ISOLATION_CORPUS.find((row) => row.rowId === "cross-tenant-read");
    if (readRow === undefined) throw new Error("missing read row");
    const readResult = await driveRow(readRow);
    const reads = readResult.result.probes.filter((record) => record.expectedKind === "zero-rows");
    expect(reads.length).toBeGreaterThan(0);
    for (const record of reads) {
      expect(record.observedKind).toBe("zero-rows");
    }
  });

  test("the control row's legitimate reads admit own-scope data (the false-positive control)", async () => {
    const controlRow = TENANT_ISOLATION_CORPUS.find(
      (row) => row.rowId === "control-tenant-healthy",
    );
    if (controlRow === undefined) throw new Error("missing control row");
    const { result } = await driveRow(controlRow);
    expect(result.terminal).toBe("COMPLETED");
    for (const record of result.probes) {
      expect(record.observedKind).toBe("own-scope-data");
      expect(record.expectedKind).toBe("own-scope-data");
    }
  });

  test("the driver runs the canonical lifecycle order with the planning decision before the battery", async () => {
    const world = createFakeIsolationWorld();
    world.seedCarrier();
    const { lifecycle, journal } = createFakeLifecycle(world);
    await driveTenantIsolationExecution({
      executionId: "carrier-execution",
      task: { kind: "isolation-probe", scenario: "cross-tenant-read", probe: "cross-tenant:read" },
      probe: "cross-tenant:read",
      lifecycle,
      executions: world.executions,
      wire: world.wire,
      counts: world.counts,
      foreign: fixedForeignRefs(),
      own: { applicationId: OWN_APPLICATION_ID, tenantId: OWN_TENANT_ID, actorId: OWN_ACTOR_ID },
      now: pinnedClock,
      idempotencyPrefix: "val-024-unit",
    });
    expect([...journal.transitions].slice(0, 5)).toEqual([
      "authorize",
      "plan",
      "queue",
      "start",
      "verify",
    ]);
  });

  test("a malformed probe task is rejected BEFORE any probe effect (the battery never runs)", async () => {
    const world = createFakeIsolationWorld();
    world.seedCarrier();
    const { lifecycle, journal } = createFakeLifecycle(world);
    const result = await driveTenantIsolationExecution({
      executionId: "carrier-execution",
      task: { kind: "summarize", scenario: "not-a-probe" },
      probe: "cross-tenant:read",
      lifecycle,
      executions: world.executions,
      wire: world.wire,
      counts: world.counts,
      foreign: fixedForeignRefs(),
      own: { applicationId: OWN_APPLICATION_ID, tenantId: OWN_TENANT_ID, actorId: OWN_ACTOR_ID },
      now: pinnedClock,
      idempotencyPrefix: "val-024-unit",
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.totalProbes).toBe(0);
    expect(journal.probeIds.length).toBe(0);
    expect(
      result.criteria.some(
        (criterion) =>
          criterion.criterionId === "typed-rejection-observed" && criterion.status === "FAIL",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The criteria derivation against synthetic violations
// ---------------------------------------------------------------------------

describe("VAL-024 criteria derivation against synthetic violations", () => {
  const baseProbes: IsolationProbeOutcomeRecord[] = [
    {
      probeId: "svc-read-foreign-execution",
      surface: "service",
      operation: "getExecution",
      reference: "foreign-execution",
      expectedCode: "SCOPE_CHECKED_MISS",
      expectedKind: "zero-rows",
      observedKind: "zero-rows",
      observedCode: null,
      httpStatus: null,
      denied: true,
      dataLeak: false,
      latencyMs: 1,
      requestDigest: "abcd1234",
      message: "",
    },
  ];
  const baseInput = {
    probe: "cross-tenant:read" as const,
    validation: { valid: true } as const,
    probes: baseProbes,
    journaledProbes: 1,
    deniedProbes: 1,
    leakedProbes: 0,
    rowCountViolations: [] as readonly string[],
    totalProbeLatencyMs: 5,
  };

  test("the clean battery passes every criterion", () => {
    const criteria = deriveIsolationCriteria(baseInput);
    expect(criteria.length).toBe(8);
    expect(criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a leaked probe FAILS zero-data-disclosure", () => {
    const criteria = deriveIsolationCriteria({
      ...baseInput,
      probes: [{ ...(baseProbes[0] as IsolationProbeOutcomeRecord), dataLeak: true }],
      leakedProbes: 1,
    });
    const criterion = criteria.find(
      (candidate) => candidate.criterionId === "zero-data-disclosure",
    );
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join("|")).toContain("leak:svc-read-foreign-execution");
  });

  test("a foreign row change FAILS zero-foreign-effects; an unaccounted own write FAILS own-writes-accounted", () => {
    const foreignCriteria = deriveIsolationCriteria({
      ...baseInput,
      rowCountViolations: [
        "foreign-application executionEvents changed: 2 -> 3 (zero foreign effects required)",
      ],
    });
    expect(
      foreignCriteria.find((candidate) => candidate.criterionId === "zero-foreign-effects")?.status,
    ).toBe("FAIL");
    expect(
      foreignCriteria.find((candidate) => candidate.criterionId === "own-writes-accounted")?.status,
    ).toBe("PASS");

    const ownCriteria = deriveIsolationCriteria({
      ...baseInput,
      rowCountViolations: ["own-application executionEvents delta 2 != accounted 1"],
    });
    expect(
      ownCriteria.find((candidate) => candidate.criterionId === "own-writes-accounted")?.status,
    ).toBe("FAIL");
    expect(
      ownCriteria.find((candidate) => candidate.criterionId === "zero-foreign-effects")?.status,
    ).toBe("PASS");
  });

  test("a journal mismatch FAILS journal-exactly-once; an empty battery FAILS typed-rejection", () => {
    const duplicated = deriveIsolationCriteria({ ...baseInput, journaledProbes: 2 });
    expect(
      duplicated.find((candidate) => candidate.criterionId === "journal-exactly-once-per-probe")
        ?.status,
    ).toBe("FAIL");
    const empty = deriveIsolationCriteria({
      ...baseInput,
      probes: [],
      journaledProbes: 0,
      deniedProbes: 0,
    });
    expect(
      empty.find((candidate) => candidate.criterionId === "typed-rejection-observed")?.status,
    ).toBe("FAIL");
  });

  test("a non-digest request reference FAILS evidence-digest-only", () => {
    const criteria = deriveIsolationCriteria({
      ...baseInput,
      probes: [
        { ...(baseProbes[0] as IsolationProbeOutcomeRecord), requestDigest: "not-a-digest" },
      ],
    });
    expect(
      criteria.find((candidate) => candidate.criterionId === "evidence-digest-only")?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The REAL platform modules (the typed rejections driven against the
// REAL execution service; the in-memory store faithfully implements
// the SQL adapter's application-scoped locked-row discipline)
// ---------------------------------------------------------------------------

describe("VAL-024 REAL execution service: the pinned typed rejections (pre-dispatch)", () => {
  interface RealWorld {
    readonly store: InMemoryExecutionStore;
    readonly service: ReturnType<typeof createInMemoryExecutions>["service"];
    readonly carrierId: string;
    readonly foreignExecutionId: string;
    readonly ownActor: { readonly actorId: string; readonly tenantId: string };
    readonly foreignActor: { readonly actorId: string; readonly tenantId: string };
  }

  async function createRealWorld(): Promise<RealWorld> {
    const world = createInMemoryExecutions();
    // The own and the foreign applications + the foreign environment.
    world.store.seedApplication(OWN_APPLICATION_ID, OWN_TENANT_ID);
    world.store.seedApplication(FOREIGN_APPLICATION_ID, FOREIGN_TENANT_ID);
    world.store.seedEnvironment(FOREIGN_ENVIRONMENT_ID, FOREIGN_APPLICATION_ID);
    const ownActor = { actorId: OWN_ACTOR_ID, tenantId: OWN_TENANT_ID };
    const foreignActor = { actorId: FOREIGN_ACTOR_ID, tenantId: FOREIGN_TENANT_ID };
    // The foreign execution (the seeded canary material) and the own carrier.
    const foreign = await world.service.createExecution(
      {
        applicationId: FOREIGN_APPLICATION_ID,
        task: { kind: "foreign-workload", input: FOREIGN_TASK_CANARY },
        metadata: { classification: "TENANT-B-CLASSIFICATION-VAL024-7723" },
      },
      "val-024-real-foreign",
      foreignActor,
    );
    const carrier = await world.service.createExecution(
      { applicationId: OWN_APPLICATION_ID, task: { kind: "isolation-probe", scenario: "real" } },
      "val-024-real-carrier",
      ownActor,
    );
    return {
      store: world.store,
      service: world.service,
      carrierId: carrier.executionId,
      foreignExecutionId: foreign.executionId,
      ownActor,
      foreignActor,
    };
  }

  test("the create-path checks: a foreign application and a foreign environment both raise TENANT_SCOPE_VIOLATION", async () => {
    const real = await createRealWorld();
    await expect(
      real.service.createExecution(
        { applicationId: FOREIGN_APPLICATION_ID, task: { kind: "probe" } },
        "val-024-real-app",
        real.ownActor,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      real.service.createExecution(
        {
          applicationId: OWN_APPLICATION_ID,
          environmentId: FOREIGN_ENVIRONMENT_ID,
          task: { kind: "probe" },
        },
        "val-024-real-env",
        real.ownActor,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("the locked-row transition checks: a foreign execution and a tenant mismatch both raise TENANT_SCOPE_VIOLATION", async () => {
    const real = await createRealWorld();
    await expect(
      real.service.transition(
        {
          command: "cancel",
          applicationId: OWN_APPLICATION_ID,
          tenantId: OWN_TENANT_ID,
          executionId: real.foreignExecutionId,
          actorId: OWN_ACTOR_ID,
        },
        "val-024-real-tr-foreign",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      real.service.transition(
        {
          command: "cancel",
          applicationId: OWN_APPLICATION_ID,
          tenantId: FOREIGN_TENANT_ID,
          executionId: real.carrierId,
          actorId: FOREIGN_ACTOR_ID,
        },
        "val-024-real-tr-mismatch",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("the step-event and planning-decision locked-row checks raise TENANT_SCOPE_VIOLATION", async () => {
    const real = await createRealWorld();
    await expect(
      real.service.recordStepEvent(
        {
          applicationId: OWN_APPLICATION_ID,
          executionId: real.foreignExecutionId,
          actor: real.ownActor,
          command: "agent-action-recorded",
          payload: {},
        },
        "val-024-real-se-foreign",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      real.service.recordStepEvent(
        {
          applicationId: OWN_APPLICATION_ID,
          executionId: real.carrierId,
          actor: real.foreignActor,
          command: "agent-action-recorded",
          payload: {},
        },
        "val-024-real-se-mismatch",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      real.service.recordPlanningDecision(
        {
          applicationId: OWN_APPLICATION_ID,
          executionId: real.foreignExecutionId,
          tenantId: OWN_TENANT_ID,
          actorId: OWN_ACTOR_ID,
          decisionId: "val-024-real-decision",
          planId: "val-024-real-plan",
          payload: { probe: "cross-tenant-planning" },
        },
        "val-024-real-pd-foreign",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      real.service.recordPlanningDecision(
        {
          applicationId: OWN_APPLICATION_ID,
          executionId: real.carrierId,
          tenantId: FOREIGN_TENANT_ID,
          actorId: FOREIGN_ACTOR_ID,
          decisionId: "val-024-real-decision-2",
          planId: "val-024-real-plan-2",
          payload: { probe: "tenant-mismatch-planning" },
        },
        "val-024-real-pd-mismatch",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("the read seams are scope-checked misses: zero rows, never data", async () => {
    const real = await createRealWorld();
    await expect(
      real.service.getExecution(OWN_APPLICATION_ID, real.foreignExecutionId),
    ).resolves.toBeNull();
    await expect(
      real.service.listEvents(OWN_APPLICATION_ID, real.foreignExecutionId),
    ).resolves.toEqual([]);
    await expect(
      real.service.listVerificationResults(OWN_APPLICATION_ID, real.foreignExecutionId),
    ).resolves.toEqual([]);
  });

  test("the denied probes write NOTHING (the REAL rollback semantics: zero durable effects)", async () => {
    const real = await createRealWorld();
    const executionsBefore = real.store.executions.size;
    const eventsBefore = real.store.events.length;
    await expect(
      real.service.createExecution(
        { applicationId: FOREIGN_APPLICATION_ID, task: { kind: "probe" } },
        "val-024-real-zero-1",
        real.ownActor,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      real.service.transition(
        {
          command: "cancel",
          applicationId: OWN_APPLICATION_ID,
          tenantId: OWN_TENANT_ID,
          executionId: real.foreignExecutionId,
          actorId: OWN_ACTOR_ID,
        },
        "val-024-real-zero-2",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      real.service.recordStepEvent(
        {
          applicationId: OWN_APPLICATION_ID,
          executionId: real.carrierId,
          actor: real.foreignActor,
          command: "agent-action-recorded",
          payload: {},
        },
        "val-024-real-zero-3",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    // The store is untouched: no execution rows, no event rows (the
    // work threw before any commit — the REAL rollback semantics).
    expect(real.store.executions.size).toBe(executionsBefore);
    expect(real.store.events.length).toBe(eventsBefore);
    // No idempotency residue: retrying the SAME denied create with
    // the SAME key throws the SAME typed violation (a persisted
    // record would replay a phantom outcome instead).
    await expect(
      real.service.createExecution(
        { applicationId: FOREIGN_APPLICATION_ID, task: { kind: "probe" } },
        "val-024-real-zero-1",
        real.ownActor,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });
});
