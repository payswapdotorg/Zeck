/**
 * Discrimination tests — the Execution IR foundation protections
 * (WORK-049, HIGH_ASSURANCE; the worker-runbook rule: "For
 * HIGH_ASSURANCE and CRITICAL, add an explicit discrimination test
 * that proves a weakened protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-049 is
 * mutation-proven — the WEAKENED form is rejected by the gate that
 * owns it (the integration suites prove the same gates over real
 * PostgreSQL; these proofs pin the protections at the unit seam with
 * an in-memory DatabasePort double for the durable store):
 *
 *  - second-authority representations: a snapshot (or IR) claiming a
 *    plan identity its content does not have is rejected — the IR can
 *    only represent an actual governed plan;
 *  - duplicated execution/step identity is unrepresentable;
 *  - unattributed and unbounded cost claims are rejected;
 *  - vendor/provider semantics outside the closed neutral
 *    vocabularies (representation classes, constraint kinds,
 *    transformation bases) are rejected;
 *  - missing provenance (IR provenance, decision governing
 *    constraints) is rejected;
 *  - weakened hard constraints fail closed: an authority restriction
 *    declared soft is unrepresentable, and a decision violating a
 *    hard constraint is rejected before it exists;
 *  - decision records cannot be consulted for authorization: the
 *    store surface is append/read only (no admission vocabulary
 *    exists anywhere on the evidence path);
 *  - re-derivation drift is detected by the audit;
 *  - durable decision evidence outside the authoritative store (or
 *    tampered inside it) is rejected at read/audit time;
 *  - a lost append identity race converges against the durable winner
 *    (replay or typed conflict) — never a raw error, never a duplicate.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../src/modules/planning/adapters/ir-plan-source";
import {
  type BuildPlanInput,
  buildPlan,
  createNodeDigest,
} from "../../src/modules/planning/public";
import type { DatabasePort, Query, QueryResult, Transaction } from "../../src/platform/db/port";
import {
  auditDurableExecutionProvenance,
  auditExecutionProvenance,
} from "../../src/platform/execution-ir/audit";
import { canonicalJson } from "../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../src/platform/execution-ir/constraints";
import {
  ConstraintValidationError,
  enforceHardConstraints,
} from "../../src/platform/execution-ir/constraints";
import { CostModelError } from "../../src/platform/execution-ir/cost-model";
import {
  type BuildDecisionInput,
  buildOptimizationDecision,
  DecisionValidationError,
} from "../../src/platform/execution-ir/decision-record";
import {
  DecisionIdentityConflictError,
  SqlOptimizationDecisionStore,
} from "../../src/platform/execution-ir/decision-store";
import {
  deriveExecutionIr,
  IrValidationError,
  validateExecutionIr,
} from "../../src/platform/execution-ir/ir";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";

const PLAN_INPUT: BuildPlanInput = {
  revision: 1,
  strategyClass: "hybrid",
  steps: [
    { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
    {
      id: "generate",
      stepClass: "call-model",
      capabilityId: "text-generation",
      routeRef: { provider: "rail-a", model: "model-x" },
    },
    { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
  ],
  edges: [
    { from: "fetch", to: "generate" },
    { from: "generate", to: "verify" },
  ],
};

function governedPlan() {
  return buildPlan(PLAN_INPUT, digestValue);
}

function ir() {
  return deriveExecutionIr(planSource.toPlanSnapshot(governedPlan()), nodeDigest);
}

function constraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "policy-eligibility",
      kind: "policy",
      enforcement: "hard",
      source: { authority: "policy", policySetId: "ps-1" },
      payload: { providerModel: { allowedProviders: ["rail-a"] } },
    },
    {
      constraintId: "capability-satisfaction",
      kind: "capability",
      enforcement: "hard",
      source: { authority: "capability", catalogRevision: "r1" },
      payload: {
        satisfiedIds: ["document-retrieval", "text-generation"],
        unmetIds: [],
      },
    },
    {
      constraintId: "verification-anchor",
      kind: "verification",
      enforcement: "hard",
      source: { authority: "verification" },
      payload: { requiresVerificationAnchor: true },
    },
  ];
}

function candidates() {
  return [
    {
      candidateId: "base-model-route",
      representationClass: "sufficient-model" as const,
      claim: {
        expectedCostMicroUsd: "500000",
        expectedLatencyMs: 2000,
        expectedQuality: 0.93,
        expectedReliability: 0.9,
        basis: { basis: "estimated" as const, source: "planning.route-table" },
      },
    },
  ];
}

function buildInput(overrides: Record<string, unknown> = {}): BuildDecisionInput {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    ir: ir(),
    constraints: constraints(),
    candidates: candidates(),
    qualityThreshold: 0.9,
    selectedCandidateId: "base-model-route",
    transformationBasis: {
      code: "identity",
      detail: "The derived IR itself is the base representation.",
    },
    recordedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  } as BuildDecisionInput;
}

// ---------------------------------------------------------------------------
// An in-memory DatabasePort double for the decision-record store (the
// unit-seam discrimination; the REAL PostgreSQL gates are proven in
// tests/integration/postgres/execution-ir-decisions.test.ts).
// ---------------------------------------------------------------------------

interface StubRow {
  readonly application_id: string;
  readonly decision_id: string;
  readonly plan_id: string;
  readonly execution_id: string | null;
  readonly record_digest: string;
  readonly payload: unknown;
}

class StubDecisionDb implements DatabasePort {
  private readonly rows: StubRow[] = [];
  /** When set, INSERT reports a lost unique race (0 rows) like ON CONFLICT. */
  private loseInsertRace = false;

  /** Seed a durable row as if the store's own append had written it. */
  seed(row: StubRow): void {
    this.rows.push(row);
  }

  /** Simulate a concurrent winner of the identity race on the next append. */
  simulateInsertRace(): void {
    this.loseInsertRace = true;
  }

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    return this.run<T>(query);
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return work({
      execute: async <U = Record<string, unknown>>(query: Query) => this.run<U>(query),
    });
  }

  private async run<T>(query: Query): Promise<QueryResult<T>> {
    const sql = query.sql;
    const parameters = query.parameters ?? [];
    if (sql.includes("INSERT INTO execution_ir.optimization_decision_records")) {
      if (this.loseInsertRace) {
        // ON CONFLICT DO NOTHING with a concurrent winner: 0 rows.
        this.loseInsertRace = false;
        return { rows: [], rowCount: 0 };
      }
      // The real store's insert parameter order (id, application,
      // tenant, execution, decision, plan, ir, revision, selected,
      // threshold, basis, payload, digest).
      this.rows.push({
        application_id: parameters[1] as string,
        decision_id: parameters[4] as string,
        plan_id: parameters[5] as string,
        execution_id: (parameters[3] as string | null) ?? null,
        record_digest: parameters[12] as string,
        payload:
          typeof parameters[11] === "string"
            ? (JSON.parse(parameters[11] as string) as unknown)
            : parameters[11],
      });
      // RETURNING id: the insert reports exactly one row on success.
      return { rows: [{ id: parameters[0] as string } as T], rowCount: 1 };
    }
    if (sql.includes("FROM execution_ir.optimization_decision_records")) {
      let selected = this.rows;
      if (sql.includes("AND decision_id = $2")) {
        selected = this.rows.filter(
          (row) => row.application_id === parameters[0] && row.decision_id === parameters[1],
        );
      } else if (sql.includes("AND plan_id = $2")) {
        selected = this.rows.filter(
          (row) => row.application_id === parameters[0] && row.plan_id === parameters[1],
        );
      } else if (sql.includes("AND execution_id = $2")) {
        selected = this.rows.filter(
          (row) => row.application_id === parameters[0] && row.execution_id === parameters[1],
        );
      }
      const mapped = selected.map((row) => ({
        id: "00000000-0000-7000-8000-0000000000dd",
        application_id: row.application_id,
        tenant_id: TENANT_ID,
        execution_id: row.execution_id,
        decision_id: row.decision_id,
        plan_id: row.plan_id,
        ir_id: "0".repeat(64),
        record_digest: row.record_digest,
        payload:
          typeof row.payload === "string"
            ? (JSON.parse(row.payload as string) as unknown)
            : row.payload,
        recorded_at: new Date(),
      }));
      return { rows: mapped as T[], rowCount: mapped.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

function storeFor(rows: StubRow[] = []): SqlOptimizationDecisionStore {
  const db = new StubDecisionDb();
  for (const row of rows) {
    db.seed(row);
  }
  return new SqlOptimizationDecisionStore(
    db,
    nodeDigest,
    () => "00000000-0000-7000-8000-0000000000ee",
  );
}

/** The store plus its double, for identity-race simulation (D12). */
function storeWithDb(): { store: SqlOptimizationDecisionStore; db: StubDecisionDb } {
  const db = new StubDecisionDb();
  return {
    db,
    store: new SqlOptimizationDecisionStore(
      db,
      nodeDigest,
      () => "00000000-0000-7000-8000-0000000000ee",
    ),
  };
}

describe("execution-ir discrimination (WORK-049)", () => {
  test("D1 second-authority: a snapshot claiming an identity its content does not have is rejected", () => {
    const snapshot = planSource.toPlanSnapshot(governedPlan());
    // Weakening 1: forged planId.
    expect(() => deriveExecutionIr({ ...snapshot, planId: "f".repeat(64) }, nodeDigest)).toThrow(
      IrValidationError,
    );
    // Weakening 2: content drift under a REAL planId (extra semantic
    // field the governed plan does not carry).
    const drifted = {
      ...snapshot,
      steps: snapshot.steps.map((step) =>
        step.id === "fetch" ? { ...step, config: { injected: true } } : step,
      ),
    };
    try {
      deriveExecutionIr(drifted, nodeDigest);
      expect.unreachable("drifted snapshot must be rejected");
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("plan-identity-mismatch");
    }
  });

  test("D2 duplicated step identity is unrepresentable", () => {
    const snapshot = planSource.toPlanSnapshot(governedPlan());
    const first = snapshot.steps[0];
    if (first === undefined) {
      throw new Error("fixture");
    }
    expect(() =>
      deriveExecutionIr({ ...snapshot, steps: [...snapshot.steps, { ...first }] }, nodeDigest),
    ).toThrow(/unique/i);
  });

  test("D3 unattributed cost claims are rejected", () => {
    const claim = candidates()[0]?.claim;
    if (claim === undefined) {
      throw new Error("fixture");
    }
    // Weakening: no basis at all.
    const { basis, ...withoutBasis } = claim;
    void basis;
    try {
      buildOptimizationDecision(
        buildInput({
          candidates: [
            { candidateId: "x", representationClass: "sufficient-model", claim: withoutBasis },
          ],
          selectedCandidateId: "x",
        }),
        nodeDigest,
      );
      expect.unreachable("unattributed claim must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(CostModelError);
    }
    // Weakening: a basis outside the closed vocabulary.
    try {
      buildOptimizationDecision(
        buildInput({
          candidates: [
            {
              candidateId: "x",
              representationClass: "sufficient-model",
              claim: { ...claim, basis: { basis: "vibes", source: "someone" } },
            },
          ],
          selectedCandidateId: "x",
        }),
        nodeDigest,
      );
      expect.unreachable("out-of-vocabulary basis must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(CostModelError);
    }
  });

  test("D4 unbounded cost claims are rejected (money, latency, reliability)", () => {
    const base = candidates()[0];
    if (base === undefined) {
      throw new Error("fixture");
    }
    for (const weakening of [
      { expectedCostMicroUsd: "1000000000000000000" }, // beyond 10^18
      { expectedLatencyMs: Number.POSITIVE_INFINITY },
      { expectedQuality: Number.NaN },
      { expectedReliability: 0 }, // unbounded expected successful-resolution cost
      { expectedReliability: Number.NEGATIVE_INFINITY },
    ]) {
      try {
        buildOptimizationDecision(
          buildInput({
            candidates: [
              {
                candidateId: "x",
                representationClass: "sufficient-model",
                claim: { ...base.claim, ...weakening },
              },
            ],
            selectedCandidateId: "x",
          }),
          nodeDigest,
        );
        expect.unreachable(`unbounded claim ${JSON.stringify(weakening)} must be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(CostModelError);
      }
    }
  });

  test("D5 vendor/provider semantics outside the closed neutral vocabularies are rejected", () => {
    // Weakening: a vendor-named representation class.
    try {
      buildOptimizationDecision(
        buildInput({
          candidates: [
            {
              candidateId: "x",
              representationClass: "e2b-warm-sandbox",
              claim: candidates()[0]?.claim,
            },
          ],
          selectedCandidateId: "x",
        }),
        nodeDigest,
      );
      expect.unreachable("vendor representation class must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(CostModelError);
    }
    // Weakening: a vendor-named constraint kind.
    expect(() =>
      buildOptimizationDecision(
        buildInput({
          constraints: [
            {
              constraintId: "x",
              kind: "openrouter-preference",
              enforcement: "hard",
              source: { authority: "planning" },
              payload: {},
            },
          ],
        }),
        nodeDigest,
      ),
    ).toThrow(ConstraintValidationError);
    // Weakening: a WORK-050 compiler transformation basis (scope creep).
    try {
      buildOptimizationDecision(
        buildInput({
          transformationBasis: {
            code: "constant-folding",
            detail: "compiler scope creep into the foundation",
          },
        }),
        nodeDigest,
      );
      expect.unreachable("out-of-scope transformation basis must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionValidationError);
    }
    // The foundation's own sources carry no vendor vocabulary (source
    // scan — the architecture boundary test pins this tree-wide).
    const planeSources = [
      "src/platform/execution-ir/ir.ts",
      "src/platform/execution-ir/cost-model.ts",
      "src/platform/execution-ir/constraints.ts",
      "src/platform/execution-ir/decision-record.ts",
      "src/platform/execution-ir/decision-store.ts",
      "src/platform/execution-ir/audit.ts",
      "src/platform/execution-ir/seams.ts",
    ];
    for (const file of planeSources) {
      const content = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const word of ["openrouter", "e2b", "daytona", "modal", "anthropic", "vercel", "neon"]) {
        expect(content, `${file} must not carry vendor word "${word}"`).not.toContain(word);
      }
    }
  });

  test("D6 missing provenance is rejected (IR provenance + decision governing constraints)", () => {
    const valid = ir();
    // Weakening: an IR without provenance.
    const noProvenance = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    delete noProvenance.provenance;
    try {
      validateExecutionIr(noProvenance, nodeDigest);
      expect.unreachable("IR without provenance must be rejected");
    } catch (error) {
      expect((error as IrValidationError).invariant).toBe("provenance-missing");
    }
    // Weakening: a decision with no governing constraints.
    try {
      buildOptimizationDecision(buildInput({ constraints: [] }), nodeDigest);
      expect.unreachable("decision without constraints must be rejected");
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe("decision-provenance");
    }
  });

  test("D7 weakened hard constraints fail closed (soft authority restriction unrepresentable; violations reject decisions)", () => {
    // Weakening 1: a POLICY restriction declared soft.
    const [first, ...rest] = constraints();
    void first;
    try {
      buildOptimizationDecision(
        buildInput({
          constraints: [
            {
              constraintId: "soft-policy",
              kind: "policy",
              enforcement: "soft",
              source: { authority: "policy" },
              payload: { providerModel: {} },
            },
            ...rest,
          ],
        }),
        nodeDigest,
      );
      expect.unreachable("a soft policy restriction must be rejected");
    } catch (error) {
      expect((error as ConstraintValidationError).invariant).toBe("constraint-authority-mismatch");
    }

    // Weakening 2: a decision whose IR violates a hard constraint (a
    // forbidden provider route).
    const plan = buildPlan(PLAN_INPUT, digestValue);
    const snapshot = planSource.toPlanSnapshot(plan);
    const forbiddenPlan = buildPlan(
      {
        ...PLAN_INPUT,
        steps: PLAN_INPUT.steps.map((step) =>
          step.id === "generate"
            ? { ...step, routeRef: { provider: "rail-forbidden", model: "model-z" } }
            : step,
        ),
      },
      digestValue,
    );
    const forbiddenIr = deriveExecutionIr(planSource.toPlanSnapshot(forbiddenPlan), nodeDigest);
    try {
      buildOptimizationDecision(
        buildInput({
          ir: forbiddenIr,
          constraints: [
            {
              constraintId: "policy-eligibility",
              kind: "policy",
              enforcement: "hard",
              source: { authority: "policy" },
              payload: { providerModel: { allowedProviders: ["rail-a"] } },
            },
            ...constraints().slice(1),
          ],
        }),
        nodeDigest,
      );
      expect.unreachable("a decision violating a hard constraint must be rejected");
    } catch (error) {
      expect((error as DecisionValidationError).invariant).toBe(
        "decision-hard-constraint-violation",
      );
    }
    void snapshot;

    // The standalone enforcement gate returns the violation (fail
    // closed, evidence-shaped).
    const violations = enforceHardConstraints(forbiddenIr, candidates(), constraints());
    expect(violations.map((violation) => violation.code)).toContain("policy-forbidden-route");
  });

  test("D8 decision records cannot be consulted for authorization (boundary proof)", () => {
    const store = storeFor();
    // The store's surface is append/read ONLY: no admission,
    // authorization, allow/deny or reservation method exists.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter(
      (name) =>
        name !== "constructor" &&
        // Private append/read helpers, not contract surface.
        name !== "validateRow" &&
        name !== "selectForUpdate" &&
        name !== "convergeAgainstExisting",
    );
    expect(surface.sort()).toEqual(["append", "get", "listByExecution", "listByPlan"]);

    // The port contract carries no admission vocabulary (source scan).
    const storeSource = readFileSync(
      join(REPO_ROOT, "src/platform/execution-ir/decision-store.ts"),
      "utf8",
    );
    for (const word of [
      "authorize",
      "authorize",
      "admission",
      "allow",
      "deny",
      "reserve",
      "settle",
    ]) {
      expect(storeSource, `the store contract must not carry "${word}"`).not.toContain(
        `/** ${word}`,
      );
    }
    for (const name of surface) {
      expect(name).not.toMatch(/authorize|admit|allow|deny|reserve|settle/i);
    }

    // The record shape carries no authorization decision: a policy
    // admission input is a RestrictionSet (the policies authority's
    // vocabulary); the decision record's constraint payloads mirror it
    // but the RECORD itself exposes no decision a policy engine could
    // consume (no `allowed`/`decision`/`verdict` field).
    const record = buildOptimizationDecision(buildInput(), nodeDigest);
    for (const key of Object.keys(record)) {
      expect(key).not.toMatch(/^(allowed|verdict|approved|authorized|decision)$/i);
    }
  });

  test("D9 re-derivation drift is detected by the audit", () => {
    const snapshot = planSource.toPlanSnapshot(governedPlan());
    const valid = deriveExecutionIr(snapshot, nodeDigest);
    // The WEAKENED audit input: an IR whose derivation drifted.
    const driftedIr = deriveExecutionIr(
      planSource.toPlanSnapshot(buildPlan({ ...PLAN_INPUT, revision: 7 }, digestValue)),
      nodeDigest,
    );
    const result = auditExecutionProvenance({
      snapshot,
      ir: driftedIr,
      digest: nodeDigest,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain("re-derivation-drift");
    // The pristine audit passes.
    expect(auditExecutionProvenance({ snapshot, ir: valid, digest: nodeDigest }).ok).toBe(true);
  });

  test("D10 durable decision evidence outside the authoritative store is rejected", async () => {
    const record = buildOptimizationDecision(buildInput(), nodeDigest);

    // A decision id the authoritative store never recorded: foreign.
    const foreign = await auditDurableExecutionProvenance({
      applicationId: APPLICATION_ID,
      decisionId: "e".repeat(64),
      snapshot: planSource.toPlanSnapshot(governedPlan()),
      ir: ir(),
      store: storeFor(),
      digest: nodeDigest,
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.violations.map((violation) => violation.code)).toContain(
      "durable-record-foreign",
    );

    // A tampered durable row (valid shape, wrong record digest): the
    // read path rejects it instead of serving it.
    const tamperedRow = {
      application_id: APPLICATION_ID,
      decision_id: record.decisionId,
      plan_id: record.planId,
      execution_id: null,
      record_digest: "d".repeat(64),
      payload: JSON.parse(JSON.stringify(record)) as unknown,
    };
    const tamperedStore = storeFor([tamperedRow]);
    await expect(tamperedStore.get(APPLICATION_ID, record.decisionId)).rejects.toThrow(
      DecisionValidationError,
    );
    await expect(tamperedStore.listByPlan(APPLICATION_ID, record.planId)).rejects.toThrow(
      DecisionValidationError,
    );

    // A row whose payload is NOT a decision record at all: rejected.
    const garbageStore = storeFor([
      {
        ...tamperedRow,
        record_digest: record.recordDigest,
        payload: { not: "a decision" },
      },
    ]);
    await expect(garbageStore.get(APPLICATION_ID, record.decisionId)).rejects.toThrow(
      DecisionValidationError,
    );

    // The legitimate store: append → read → audit clean.
    const store = storeFor();
    const appended = await store.append(record);
    expect(appended.replayed).toBe(false);
    const audit = await auditDurableExecutionProvenance({
      applicationId: APPLICATION_ID,
      decisionId: record.decisionId,
      snapshot: planSource.toPlanSnapshot(governedPlan()),
      ir: ir(),
      store,
      digest: nodeDigest,
    });
    expect(audit.ok).toBe(true);

    // Identity conflict: the same decisionId under different content.
    const drifted = buildOptimizationDecision(
      { ...buildInput(), recordedAt: "2027-01-01T00:00:00.000Z" },
      nodeDigest,
    );
    await expect(store.append(drifted)).rejects.toBeInstanceOf(DecisionIdentityConflictError);
  });

  test("D11 soft constraints are recorded, never silently enforced (the inverse discrimination)", () => {
    // A task-derived soft latency preference the claims violate: NO
    // violation is produced — the soft constraint is recorded only.
    // (Proves the enforcement gate distinguishes hard from soft rather
    // than enforcing everything.)
    const valid = ir();
    const violations = enforceHardConstraints(valid, candidates(), [
      {
        constraintId: "task-latency-preference",
        kind: "latency",
        enforcement: "soft",
        source: { authority: "planning" },
        payload: { maxLatencyMs: 1 },
      },
    ]);
    expect(violations).toEqual([]);
    // And the same constraint declared HARD (planning-sourced task
    // bound) DOES fail closed.
    const hardViolations = enforceHardConstraints(valid, candidates(), [
      {
        constraintId: "task-latency-bound",
        kind: "latency",
        enforcement: "hard",
        source: { authority: "planning" },
        payload: { maxLatencyMs: 1 },
      },
    ]);
    expect(hardViolations.map((violation) => violation.code)).toEqual(["latency-ceiling"]);
  });

  test("D12 a lost append identity race converges against the durable winner (never a raw error, never a duplicate)", async () => {
    const record = buildOptimizationDecision(buildInput(), nodeDigest);

    // Race case 1: the concurrent winner wrote IDENTICAL content — the
    // loser's insert becomes a no-op and the append replays.
    const identical = storeWithDb();
    identical.db.seed({
      application_id: record.applicationId,
      decision_id: record.decisionId,
      plan_id: record.planId,
      execution_id: null,
      record_digest: record.recordDigest,
      payload: JSON.parse(JSON.stringify(record)) as unknown,
    });
    identical.db.simulateInsertRace();
    const replayed = await identical.store.append(record);
    expect(replayed).toMatchObject({ decisionId: record.decisionId, replayed: true });
    // One durable row, not two: the lost race never duplicates evidence.
    const listed = await identical.store.listByPlan(record.applicationId, record.planId);
    expect(listed).toHaveLength(1);

    // Race case 2: the concurrent winner wrote DIFFERENT content under the
    // same decision identity — the loser fails closed with the typed
    // conflict (never overwrites the winner).
    const driftedWinner = storeWithDb();
    driftedWinner.db.seed({
      application_id: record.applicationId,
      decision_id: record.decisionId,
      plan_id: record.planId,
      execution_id: null,
      record_digest: "d".repeat(64),
      payload: JSON.parse(JSON.stringify(record)) as unknown,
    });
    driftedWinner.db.simulateInsertRace();
    await expect(driftedWinner.store.append(record)).rejects.toBeInstanceOf(
      DecisionIdentityConflictError,
    );
  });
});
