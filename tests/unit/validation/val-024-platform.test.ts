/**
 * VAL-024 acceptance criteria 1, 2, 4, 5: the tenant-isolation
 * platform slice against controlled fakes — the typed-rejection
 * taxonomy derivations (the platform + wire classifier matrix), the
 * zero-data-disclosure scan and redaction discipline, and the
 * execution driver (canonical lifecycle order, planning decision
 * BEFORE the first probe, journal exactly-once-per-probe, denied
 * probes never retried, the disclosure breach terminating the battery
 * immediately, the honest terminal inversion — a verified boundary
 * COMPLETES, a disclosed or violated boundary FAILS — and the
 * criteria derivation against synthetic violations).
 */

import { describe, expect, test } from "vitest";
import { ISOLATION_CORPUS } from "../../../benchmarks/validation/apps/tenant-isolation/corpus";
import {
  createHonestFakeSeam,
  createLeakyFakeSeam,
  createOverDenyingFakeSeam,
  FIXTURE_WORLD_FACTS,
} from "../../../benchmarks/validation/apps/tenant-isolation/fixtures";
import {
  type AppProbeObservation,
  classifyPlatformRejection,
  classifySdkRejection,
  deriveIsolationCriteria,
  driveIsolationExecution,
  type ExpectedObservation,
  ISOLATION_PROBE_FAMILIES,
  type IsolationLifecyclePort,
  type IsolationProbeRecord,
  type IsolationProbeSeam,
  isolationDigestOf,
  REJECTION_HTTP_STATUS,
  redactForeignMarkers,
  scanForForeignContent,
  TYPED_REJECTIONS,
  verifyIsolationContract,
} from "../../../benchmarks/validation/platform/tenant-isolation";

// ---------------------------------------------------------------------------
// Fake lifecycle + helpers
// ---------------------------------------------------------------------------

interface FakeLifecycle extends IsolationLifecyclePort {
  readonly transitions: string[];
  readonly decisions: { provider: string; model: string; strategyClass: string }[];
  readonly probeRecords: IsolationProbeRecord[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
}

function createFakeLifecycle(): FakeLifecycle {
  const transitions: string[] = [];
  const decisions: { provider: string; model: string; strategyClass: string }[] = [];
  const probeRecords: IsolationProbeRecord[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  const port: IsolationLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
    },
    async recordPlanningDecision({ route }) {
      decisions.push({ ...route });
    },
    async recordProbe({ record }) {
      probeRecords.push(record);
    },
    async complete({ verdict, criteria }) {
      completions.push({
        verdict,
        criteria: criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: criterion.status,
        })),
      });
    },
  };
  return Object.assign(port, { transitions, decisions, probeRecords, completions });
}

/** Drive one corpus row through the fake stack with an injectable seam. */
async function driveRow(options: {
  readonly row: (typeof ISOLATION_CORPUS)[number];
  readonly seam: IsolationProbeSeam;
}): Promise<{
  result: Awaited<ReturnType<typeof driveIsolationExecution>>;
  lifecycle: FakeLifecycle;
}> {
  const lifecycle = createFakeLifecycle();
  const result = await driveIsolationExecution({
    executionId: `exec-${options.row.rowId}`,
    task: {
      kind: "isolation-probe",
      input: {
        rowId: options.row.rowId,
        family: options.row.family,
        targetRole: options.row.targetRole,
      },
    },
    groundTruth: options.row,
    platformProbes: options.row.platformProbes,
    lifecycle,
    probe: options.seam,
    worldFacts: () => FIXTURE_WORLD_FACTS,
    now: () => new Date(1_000),
  });
  return { result, lifecycle };
}

// ---------------------------------------------------------------------------
// The typed-rejection taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

describe("VAL-024 tenant-isolation taxonomy (pure derivations)", () => {
  test("the family vocabulary covers the four work-order families + the AC6 discrimination families + the control", () => {
    expect(ISOLATION_PROBE_FAMILIES).toContain("cross-tenant-read");
    expect(ISOLATION_PROBE_FAMILIES).toContain("cross-tenant-transition");
    expect(ISOLATION_PROBE_FAMILIES).toContain("cross-tenant-artifact-fetch");
    expect(ISOLATION_PROBE_FAMILIES).toContain("cross-application-state");
    expect(ISOLATION_PROBE_FAMILIES).toContain("cross-tenant-create");
    expect(ISOLATION_PROBE_FAMILIES).toContain("cross-tenant-environment");
    expect(ISOLATION_PROBE_FAMILIES).toContain("forged-scope-header");
    expect(ISOLATION_PROBE_FAMILIES).toContain("own-tenant-control");
    expect(new Set(ISOLATION_PROBE_FAMILIES).size).toBe(ISOLATION_PROBE_FAMILIES.length);
  });

  test("the typed-rejection vocabulary and its HTTP statuses are exactly pinned", () => {
    expect(TYPED_REJECTIONS).toEqual([
      "TENANT_SCOPE_VIOLATION",
      "AUTHORIZATION_DENIED",
      "SCOPE_CHECKED_MISS",
    ]);
    expect(REJECTION_HTTP_STATUS.TENANT_SCOPE_VIOLATION).toBe(403);
    expect(REJECTION_HTTP_STATUS.AUTHORIZATION_DENIED).toBe(403);
    expect(REJECTION_HTTP_STATUS.SCOPE_CHECKED_MISS).toBe(404);
  });

  test("the platform classifier maps the authorities' own codes; unknown codes are honestly null", () => {
    expect(classifyPlatformRejection("TENANT_SCOPE_VIOLATION")).toBe("TENANT_SCOPE_VIOLATION");
    expect(classifyPlatformRejection("AUTHORIZATION_DENIED")).toBe("AUTHORIZATION_DENIED");
    expect(classifyPlatformRejection("POLICY_DENIED")).toBeNull();
    expect(classifyPlatformRejection("INVALID_STATE_TRANSITION")).toBeNull();
  });

  test("the wire classifier maps the public error codes + statuses; unexpected shapes are honestly null", () => {
    // the scope-checked miss: the wire's 404 indistinguishable miss
    expect(classifySdkRejection({ status: 404, code: "CAPABILITY_UNAVAILABLE" })).toBe(
      "SCOPE_CHECKED_MISS",
    );
    expect(classifySdkRejection({ status: 403, code: "TENANT_SCOPE_VIOLATION" })).toBe(
      "TENANT_SCOPE_VIOLATION",
    );
    expect(classifySdkRejection({ status: 403, code: "AUTHORIZATION_DENIED" })).toBe(
      "AUTHORIZATION_DENIED",
    );
    // the discriminations: right code with the wrong status is NOT a match
    expect(classifySdkRejection({ status: 404, code: "TENANT_SCOPE_VIOLATION" })).toBeNull();
    expect(classifySdkRejection({ status: 403, code: "CAPABILITY_UNAVAILABLE" })).toBeNull();
    expect(classifySdkRejection({ status: 500, code: "PROVIDER_ERROR" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The zero-data-disclosure scan + redaction (PURE derivations)
// ---------------------------------------------------------------------------

describe("VAL-024 zero-data-disclosure discipline", () => {
  const markers = [
    { label: "foreign-execution-canary", marker: "TENANT-FX-CANARY-EXEC-7c31d9" },
    { label: "foreign-artifact-canary", marker: "TENANT-FX-CANARY-ARTIFACT-2e84a1" },
  ];

  test("a clean boundary message scans clean", () => {
    expect(
      scanForForeignContent("environment does not belong to the target application", markers),
    ).toEqual([]);
  });

  test("a leaky message is detected by LABEL — the finding never carries the content", () => {
    const findings = scanForForeignContent(
      `error: ${"TENANT-FX-CANARY-EXEC-7c31d9"} leaked into a message`,
      markers,
    );
    expect(findings).toEqual(["foreign-execution-canary"]);
    expect(JSON.stringify(findings)).not.toContain("TENANT-FX-CANARY-EXEC-7c31d9");
  });

  test("redaction replaces the foreign content with the boundary labels", () => {
    const redacted = redactForeignMarkers(
      `the other tenant said ${"TENANT-FX-CANARY-ARTIFACT-2e84a1"} out loud`,
      markers,
    );
    expect(redacted).not.toContain("TENANT-FX-CANARY-ARTIFACT-2e84a1");
    expect(redacted).toContain("foreign-artifact-canary");
    expect(redacted).toContain("[REDACTED:");
  });

  test("messages are length-capped", () => {
    const redacted = redactForeignMarkers("x".repeat(500), markers);
    expect(redacted.length).toBeLessThanOrEqual(241);
  });
});

// ---------------------------------------------------------------------------
// The execution driver over the fake seams
// ---------------------------------------------------------------------------

describe("VAL-024 isolation driver (fake seams)", () => {
  test("every corpus row drives its declared probes, COMPLETES, and journals exactly once per probe", async () => {
    for (const row of ISOLATION_CORPUS) {
      const { probe: seam } = createHonestFakeSeam();
      const { result, lifecycle } = await driveRow({ row, seam });
      expect(result.terminal, `${row.rowId} terminal`).toBe("COMPLETED");
      expect(result.disclosed, `${row.rowId} disclosed`).toBe(false);
      expect(result.totalProbes, `${row.rowId} probe count`).toBe(row.platformProbes.length);
      expect(result.journaledProbes, `${row.rowId} journal`).toBe(result.totalProbes);
      expect(lifecycle.probeRecords.length, `${row.rowId} ledger journal`).toBe(
        row.platformProbes.length,
      );
      const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedCriteria, `${row.rowId} criteria: ${JSON.stringify(failedCriteria)}`).toEqual(
        [],
      );
      expect(lifecycle.completions[0]?.verdict).toBe("pass");
    }
  });

  test("the canonical lifecycle order: authorize → plan → decision BEFORE any probe → queue → start → verify", async () => {
    const row = ISOLATION_CORPUS[0];
    if (row === undefined) throw new Error("missing corpus row");
    const { probe: seam, calls } = createHonestFakeSeam();
    const { lifecycle } = await driveRow({ row, seam });
    expect(lifecycle.transitions).toEqual(["authorize", "plan", "queue", "start", "verify"]);
    // The planning decision is durable BEFORE the first probe.
    expect(lifecycle.decisions).toEqual([
      {
        provider: "platform-scope-authorities",
        model: "pre-dispatch-scope-checks",
        strategyClass: "tenant-isolation-probe",
      },
    ]);
    // every declared probe actually hit the seam
    expect(calls.length).toBe(row.platformProbes.length);
  });

  test("the probe journal records carry digest references only — never payload bytes", async () => {
    const row = ISOLATION_CORPUS.find((candidate) => candidate.rowId === "cross-tenant-transition");
    if (row === undefined) throw new Error("missing transition row");
    const { probe: seam } = createHonestFakeSeam();
    const { lifecycle } = await driveRow({ row, seam });
    const record = lifecycle.probeRecords[0];
    if (record === undefined) throw new Error("missing journal record");
    expect(record.probe).toBe(1);
    expect(record.operation).toBe("svc-transition-foreign-execution");
    expect(record.rejection).toBe("TENANT_SCOPE_VIOLATION");
    expect(record.targetDigest).toMatch(/^[0-9a-f]{8}$/);
    // The journal reference carries the boundary — never a foreign id
    // payload, never foreign content.
    expect(JSON.stringify(lifecycle.probeRecords)).not.toContain("exec-fixture-foreign");
  });

  test("a denied probe is NEVER retried (deterministic pre-dispatch scope checks)", async () => {
    const row = ISOLATION_CORPUS.find((candidate) => candidate.rowId === "cross-tenant-planning");
    if (row === undefined) throw new Error("missing planning row");
    const { probe: seam, calls } = createHonestFakeSeam();
    const { result } = await driveRow({ row, seam });
    expect(result.totalProbes).toBe(1);
    expect(calls.length).toBe(1);
  });

  test("a DISCLOSURE terminates the battery immediately and FAILS the run honestly", async () => {
    // cross-tenant-read declared a single probe; the leaky seam
    // discloses on it — the run FAILS with the breach journaled once.
    const row = ISOLATION_CORPUS.find((candidate) => candidate.rowId === "cross-tenant-read");
    if (row === undefined) throw new Error("missing read row");
    const leaky = createLeakyFakeSeam();
    const lifecycle = createFakeLifecycle();
    const result = await driveIsolationExecution({
      executionId: "exec-breach",
      task: {
        kind: "isolation-probe",
        input: { rowId: row.rowId, family: row.family, targetRole: row.targetRole },
      },
      groundTruth: row,
      platformProbes: ["svc-read-foreign-execution", "svc-events-foreign-execution"],
      lifecycle,
      probe: leaky,
      worldFacts: () => FIXTURE_WORLD_FACTS,
      now: () => new Date(1_000),
    });
    expect(result.disclosed).toBe(true);
    expect(result.terminal).toBe("FAILED");
    // the breach was journaled exactly once and the battery stopped
    expect(result.totalProbes).toBe(1);
    expect(result.journaledProbes).toBe(1);
    expect(lifecycle.completions[0]?.verdict).toBe("fail");
    const disclosureCriterion = result.criteria.find(
      (criterion) => criterion.criterionId === "zero-data-disclosure",
    );
    expect(disclosureCriterion?.status).toBe("FAIL");
    const outcomeCriterion = result.criteria.find(
      (criterion) => criterion.criterionId === "outcome-contract",
    );
    expect(outcomeCriterion?.status).toBe("FAIL");
  });

  test("the over-denying boundary FAILS the control row (the boundary must not over-deny)", async () => {
    const row = ISOLATION_CORPUS.find((candidate) => candidate.rowId === "own-tenant-control");
    if (row === undefined) throw new Error("missing control row");
    const overDenying = createOverDenyingFakeSeam();
    const lifecycle = createFakeLifecycle();
    const result = await driveIsolationExecution({
      executionId: "exec-overdeny",
      task: {
        kind: "isolation-probe",
        input: { rowId: row.rowId, family: row.family, targetRole: row.targetRole },
      },
      groundTruth: row,
      platformProbes: row.platformProbes,
      lifecycle,
      probe: overDenying,
      worldFacts: () => FIXTURE_WORLD_FACTS,
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("FAILED");
    const sequenceCriterion = result.criteria.find(
      (criterion) => criterion.criterionId === "observation-sequence",
    );
    expect(sequenceCriterion?.status).toBe("FAIL");
  });

  test("an out-of-vocabulary family is a platform rejection BEFORE any probe (zero probes, zero effects)", async () => {
    const row = ISOLATION_CORPUS[0];
    if (row === undefined) throw new Error("missing corpus row");
    const { probe: seam, calls } = createHonestFakeSeam();
    const lifecycle = createFakeLifecycle();
    const result = await driveIsolationExecution({
      executionId: "exec-oov",
      task: { kind: "isolation-probe", input: { rowId: "oov", family: "not-a-family" } },
      groundTruth: row,
      platformProbes: row.platformProbes,
      lifecycle,
      probe: seam,
      worldFacts: () => FIXTURE_WORLD_FACTS,
      now: () => new Date(1_000),
    });
    expect(result.totalProbes).toBe(0);
    expect(result.journaledProbes).toBe(0);
    expect(calls.length).toBe(0);
    expect(result.terminal).toBe("FAILED");
    const vocabularyCriterion = result.criteria.find(
      (criterion) => criterion.criterionId === "probe-family-vocabulary",
    );
    expect(vocabularyCriterion?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Mechanical verification against synthetic violations
// ---------------------------------------------------------------------------

describe("VAL-024 criteria derivation (synthetic violations)", () => {
  const row = ISOLATION_CORPUS.find((candidate) => candidate.rowId === "cross-tenant-transition");
  if (row === undefined) throw new Error("missing transition row");
  const baseProbe: IsolationProbeRecord = {
    probe: 1,
    operation: "svc-transition-foreign-execution",
    kind: "denied",
    rejection: "TENANT_SCOPE_VIOLATION",
    latencyMs: 2,
    targetDigest: isolationDigestOf("foreign-execution"),
    httpStatus: null,
    rowsReturned: null,
    foreignMarkerLabels: [],
    message: "execution not found in this application (missing or owned by another application)",
  };
  const criteriaOf = (input: {
    readonly probes?: readonly IsolationProbeRecord[];
    readonly journaled?: number;
    readonly baseline?: typeof FIXTURE_WORLD_FACTS;
    readonly final?: typeof FIXTURE_WORLD_FACTS;
  }) =>
    deriveIsolationCriteria({
      groundTruth: row,
      probes: input.probes ?? [baseProbe],
      journaledProbes: input.journaled ?? (input.probes ?? [baseProbe]).length,
      baseline: input.baseline ?? FIXTURE_WORLD_FACTS,
      finalFacts: input.final ?? FIXTURE_WORLD_FACTS,
      totalProbeLatencyMs: 2,
      familyInVocabulary: true,
    });

  test("the honest denial passes every criterion", () => {
    const criteria = criteriaOf({});
    expect(criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });

  test("a wrong typed rejection code FAILS the typed-rejection criterion", () => {
    const criteria = criteriaOf({
      probes: [{ ...baseProbe, rejection: "AUTHORIZATION_DENIED" }],
    });
    expect(criteria.find((criterion) => criterion.criterionId === "typed-rejection")?.status).toBe(
      "FAIL",
    );
  });

  test("a foreign marker in the run's own records FAILS zero-data-disclosure", () => {
    const criteria = criteriaOf({
      probes: [{ ...baseProbe, foreignMarkerLabels: ["foreign-execution-canary"] }],
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "zero-data-disclosure")?.status,
    ).toBe("FAIL");
  });

  test("a leaky DENIED message is caught exactly like a disclosed payload (labels on any kind)", async () => {
    // The discrimination for the marker-label discipline: a boundary
    // that denies the probe but ECHOES the other tenant's content in
    // its rejection message must FAIL zero-data-disclosure — the
    // labels ride the denied observation too, never only disclosures.
    const row = ISOLATION_CORPUS.find((candidate) => candidate.rowId === "cross-tenant-planning");
    if (row === undefined) throw new Error("missing planning row");
    const leakyMessageSeam: IsolationProbeSeam = async () => ({
      kind: "denied",
      rejection: "TENANT_SCOPE_VIOLATION",
      message:
        "denied, but the foreign content TENANT-FX-CANARY-EXEC-7c31d9 leaked into the message",
      latencyMs: 1,
      targetDigest: isolationDigestOf("foreign-execution"),
      httpStatus: null,
      foreignMarkerLabels: ["foreign-execution-canary"],
    });
    const lifecycle = createFakeLifecycle();
    const result = await driveIsolationExecution({
      executionId: "exec-leaky-denial",
      task: {
        kind: "isolation-probe",
        input: { rowId: row.rowId, family: row.family, targetRole: row.targetRole },
      },
      groundTruth: row,
      platformProbes: row.platformProbes,
      lifecycle,
      probe: leakyMessageSeam,
      worldFacts: () => FIXTURE_WORLD_FACTS,
      foreignMarkers: [
        { label: "foreign-execution-canary", marker: "TENANT-FX-CANARY-EXEC-7c31d9" },
      ],
      now: () => new Date(1_000),
    });
    expect(result.terminal).toBe("FAILED");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "zero-data-disclosure")?.status,
    ).toBe("FAIL");
    // the journal record itself carries the LABEL only — never the marker content
    const journalText = JSON.stringify(lifecycle.probeRecords);
    expect(journalText).not.toContain("TENANT-FX-CANARY-EXEC-7c31d9");
    expect(journalText).toContain("foreign-execution-canary");
  });

  test("a duplicate journal record FAILS journal-exactly-once", () => {
    const criteria = criteriaOf({ journaled: 2 });
    expect(
      criteria.find((criterion) => criterion.criterionId === "journal-exactly-once-per-probe")
        ?.status,
    ).toBe("FAIL");
  });

  test("a changed foreign namespace FAILS the row-count invariants", () => {
    const criteria = criteriaOf({
      final: { ...FIXTURE_WORLD_FACTS, foreignEventCount: 2 },
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "foreign-namespace-invariants")
        ?.status,
    ).toBe("FAIL");
    const statusCriteria = criteriaOf({
      final: { ...FIXTURE_WORLD_FACTS, foreignExecutionStatus: "CANCELLED" },
    });
    expect(
      statusCriteria.find((criterion) => criterion.criterionId === "foreign-namespace-invariants")
        ?.status,
    ).toBe("FAIL");
  });

  test("a disclosed probe FAILS the outcome contract (the derived terminal is FAILED)", () => {
    const criteria = criteriaOf({
      probes: [
        {
          ...baseProbe,
          kind: "disclosed",
          rejection: null,
          foreignMarkerLabels: ["foreign-execution-canary"],
        },
      ],
    });
    expect(criteria.find((criterion) => criterion.criterionId === "outcome-contract")?.status).toBe(
      "FAIL",
    );
  });

  test("foreign rows returned FAIL zero-foreign-rows", () => {
    const readRow = ISOLATION_CORPUS.find((candidate) => candidate.rowId === "cross-tenant-read");
    if (readRow === undefined) throw new Error("missing read row");
    const criteria = deriveIsolationCriteria({
      groundTruth: readRow,
      probes: [
        {
          ...baseProbe,
          operation: "svc-read-foreign-execution",
          kind: "miss",
          rejection: "SCOPE_CHECKED_MISS",
          rowsReturned: 1,
        },
      ],
      journaledProbes: 1,
      baseline: FIXTURE_WORLD_FACTS,
      finalFacts: FIXTURE_WORLD_FACTS,
      totalProbeLatencyMs: 1,
      familyInVocabulary: true,
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "zero-foreign-rows")?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The app-side isolation contract (PURE verification)
// ---------------------------------------------------------------------------

describe("VAL-024 app-side isolation contract", () => {
  const denied: ExpectedObservation = { kind: "denied", rejection: "TENANT_SCOPE_VIOLATION" };
  const observation = (overrides: Partial<AppProbeObservation>): AppProbeObservation => ({
    probe: 1,
    operation: "sdk-create-foreign-environment",
    kind: "denied",
    rejection: "TENANT_SCOPE_VIOLATION",
    httpStatus: 403,
    message: "environment does not belong to the target application",
    latencyMs: 1,
    targetDigest: isolationDigestOf("foreign-environment"),
    foreignMarkerLabels: [],
    dataDigest: null,
    ...overrides,
  });

  test("the matching denial passes every app criterion", () => {
    const criteria = verifyIsolationContract({
      expected: [denied],
      observations: [observation({})],
    });
    expect(criteria.filter((criterion) => criterion.status === "FAIL")).toEqual([]);
  });

  test("a wire miss that answers 404 satisfies the miss-indistinguishability discipline", () => {
    const criteria = verifyIsolationContract({
      expected: [{ kind: "denied", rejection: "SCOPE_CHECKED_MISS" }],
      observations: [
        observation({
          rejection: "SCOPE_CHECKED_MISS",
          httpStatus: 404,
          message: "execution not found",
        }),
      ],
    });
    expect(criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a miss answering anything but 404 FAILS the miss-indistinguishability discipline", () => {
    const criteria = verifyIsolationContract({
      expected: [{ kind: "denied", rejection: "SCOPE_CHECKED_MISS" }],
      observations: [
        observation({ rejection: "SCOPE_CHECKED_MISS", httpStatus: 200, message: "leaked shape" }),
      ],
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "miss-indistinguishability")?.status,
    ).toBe("FAIL");
  });

  test("an unexpected observation FAILS the sequence contract (never a fabricated verdict)", () => {
    const criteria = verifyIsolationContract({
      expected: [denied],
      observations: [observation({ kind: "unexpected", rejection: null, httpStatus: null })],
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "app-observation-sequence")?.status,
    ).toBe("FAIL");
  });

  test("a disclosed app observation FAILS both the sequence and the zero-disclosure criteria", () => {
    const criteria = verifyIsolationContract({
      expected: [denied],
      observations: [
        observation({
          kind: "disclosed",
          rejection: null,
          httpStatus: 200,
          foreignMarkerLabels: ["foreign-execution-canary"],
        }),
      ],
    });
    expect(
      criteria.find((criterion) => criterion.criterionId === "app-observation-sequence")?.status,
    ).toBe("FAIL");
    expect(
      criteria.find((criterion) => criterion.criterionId === "app-zero-data-disclosure")?.status,
    ).toBe("FAIL");
  });

  test("a granted control observation matches its granted expectation", () => {
    const criteria = verifyIsolationContract({
      expected: [{ kind: "granted", rejection: null }],
      observations: [
        observation({ kind: "granted", rejection: null, httpStatus: 200, dataDigest: "abcd1234" }),
      ],
    });
    expect(criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });
});
