/**
 * Observation seam observer unit tests (WORK-059 / SEC-004).
 *
 * Proves over fakes (the durable proofs run over real PostgreSQL in
 * the integration suites):
 *
 *  - the executions observer delegates to the authority, returns its
 *    outcome verbatim and appends the audit records (create +
 *    transition) with full provenance;
 *  - idempotent replay converges: a retried transition records the
 *    SAME evidence (bounded no-op) because the outcome is the stored
 *    durable outcome and identity excludes the volatile replay flag;
 *  - a projection failure after a committed authority action fails
 *    CLOSED (typed error), and the retry converges to one record;
 *  - the admission observer passes the verdict through VERBATIM
 *    (deny stays deny, allow stays allow) while recording the
 *    decision with policy provenance;
 *  - the decision-store observer records decision evidence keyed by
 *    the decision's own content identity (structural seam typing —
 *    no platform execution-ir import).
 */

import { describe, expect, test } from "vitest";
import { InMemoryAuditStore } from "../../../src/modules/audit/adapters/in-memory-audit-store";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import { createObservingAdmission } from "../../../src/modules/audit/adapters/observing-authorization";
import { createObservingDecisionStore } from "../../../src/modules/audit/adapters/observing-decision-store";
import { createObservingExecutionService } from "../../../src/modules/audit/adapters/observing-execution-service";
import type { AuditRecordStore, AuditSubmission } from "../../../src/modules/audit/public";
import { AuditProjectionError } from "../../../src/modules/audit/public";

const digest = createAuditNodeDigest();
const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";
const NOW = () => new Date("2026-09-20T12:00:00.000Z");

function baseStore() {
  return new InMemoryAuditStore(digest, NOW);
}

describe("the executions seam observer (WORK-059)", () => {
  function fakeAuthority() {
    const state = { created: 0, transitions: 0 };
    const authority = {
      async createExecution(
        input: { task: { kind: string } },
        key: string,
        actor: { actorId: string },
      ) {
        state.created += 1;
        void key;
        void actor;
        return {
          executionId: EXECUTION_ID,
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          environmentId: null,
          status: "CREATED",
          lastEventSequence: 1,
          verificationRefs: [] as string[],
          createdAt: "2026-09-20T12:00:00.000Z",
          terminalAt: null,
          replayed: false,
          // biome-ignore lint/suspicious/noExplicitAny: structural fake
          task: input.task as any,
        };
      },
      async transition(command: { command: string }, key: string) {
        state.transitions += 1;
        void key;
        void command;
        return {
          execution: { id: EXECUTION_ID },
          applied: { from: "CREATED", to: "AUTHORIZED", sequence: 2 },
          replayed: false,
        };
      },
      state,
    };
    return authority;
  }

  test("create and transition append audit records with full provenance (delegation verbatim)", async () => {
    const store = baseStore();
    const authority = fakeAuthority();
    const observing = createObservingExecutionService({
      // biome-ignore lint/suspicious/noExplicitAny: structural fake of the public contract
      inner: authority as any,
      store,
      environment: "production",
      now: NOW,
    });
    await observing.createExecution(
      { applicationId: APPLICATION_ID, task: { kind: "summarize", input: "artifact-1" } },
      "create-key-1",
      { actorId: "actor-1", tenantId: TENANT_ID },
    );
    await observing.transition(
      {
        actorId: "actor-1",
        tenantId: TENANT_ID,
        applicationId: APPLICATION_ID,
        executionId: EXECUTION_ID,
        command: "authorize",
      } as Parameters<typeof observing.transition>[0],
      "transition-key-1",
    );
    const records = await store.listRecords(APPLICATION_ID);
    expect(records.map((record) => record.action.kind)).toEqual([
      "execution.created",
      "execution.transitioned",
    ]);
    const created = records[0]!;
    expect(created.actor).toEqual({ actorId: "actor-1", actorKind: "service-principal" });
    expect(created.target).toEqual({ kind: "execution", id: EXECUTION_ID });
    expect(created.provenance.seam).toBe("executions.create");
    expect(created.action.operationKey).toBe("create-key-1");
    expect(created.rationale.why).toContain("summarize");
    expect(authority.state.created).toBe(1);
    expect(authority.state.transitions).toBe(1);
  });

  test("a retried transition (idempotent replay) converges to ONE audit record", async () => {
    const store = baseStore();
    const authority = fakeAuthority();
    const observing = createObservingExecutionService({
      // biome-ignore lint/suspicious/noExplicitAny: structural fake of the public contract
      inner: authority as any,
      store,
      environment: "production",
      now: NOW,
    });
    const transition = {
      actorId: "actor-1",
      tenantId: TENANT_ID,
      applicationId: APPLICATION_ID,
      executionId: EXECUTION_ID,
      command: "authorize",
    } as Parameters<typeof observing.transition>[0];
    await observing.transition(transition, "key-1");
    // The authority's idempotent replay returns the SAME stored
    // outcome (from/to/sequence identical; replayed=true — the flag
    // is metadata, excluded from audit identity).
    authority.transition = async () => ({
      execution: { id: EXECUTION_ID },
      applied: { from: "CREATED", to: "AUTHORIZED", sequence: 2 },
      replayed: true,
    });
    const outcome = await observing.transition(transition, "key-1");
    expect(outcome.replayed).toBe(true);
    const records = await store.listRecords(APPLICATION_ID);
    expect(records).toHaveLength(1);
    expect(records[0]?.actionDetail).toEqual({
      from: "CREATED",
      to: "AUTHORIZED",
      sequence: 2,
    });
  });

  test("a projection failure after the authority committed fails closed; the retry converges", async () => {
    const store = baseStore();
    const authority = fakeAuthority();
    // A store double that fails the FIRST append then recovers (the
    // crash-resume shape at unit level; the integration suite proves
    // the real transactional rollback).
    let failures = 0;
    const failingStore: AuditRecordStore = {
      async appendRecord(submission: AuditSubmission) {
        if (failures === 0) {
          failures += 1;
          throw new Error("projection unavailable");
        }
        return store.appendRecord(submission);
      },
      async getRecord(applicationId: string, recordId: string) {
        return store.getRecord(applicationId, recordId);
      },
      async listRecords(applicationId: string, options) {
        return store.listRecords(applicationId, options);
      },
      async chainHead(applicationId: string) {
        return store.chainHead(applicationId);
      },
      async purgeExpiredRecords(input) {
        return store.purgeExpiredRecords(input);
      },
      async listPurgeManifests(applicationId: string, window) {
        return store.listPurgeManifests(applicationId, window);
      },
    };
    const observing = createObservingExecutionService({
      // biome-ignore lint/suspicious/noExplicitAny: structural fake of the public contract
      inner: authority as any,
      store: failingStore,
      environment: "production",
      now: NOW,
    });
    const transition = {
      actorId: "actor-1",
      tenantId: TENANT_ID,
      applicationId: APPLICATION_ID,
      executionId: EXECUTION_ID,
      command: "authorize",
    } as Parameters<typeof observing.transition>[0];
    // First attempt: the authority commits, the projection fails →
    // the caller sees the typed failure (never a silent unaudited
    // success).
    await expect(observing.transition(transition, "key-1")).rejects.toBeInstanceOf(
      AuditProjectionError,
    );
    expect(authority.state.transitions).toBe(1);
    // Retry: the authority replays (same outcome), the projection
    // converges to the single evidence record.
    authority.transition = async () => ({
      execution: { id: EXECUTION_ID },
      applied: { from: "CREATED", to: "AUTHORIZED", sequence: 2 },
      replayed: true,
    });
    await observing.transition(transition, "key-1");
    const records = await store.listRecords(APPLICATION_ID);
    expect(records).toHaveLength(1);
    expect(records[0]?.action.command).toBe("authorize");
  });
});

describe("the policy admission seam observer (WORK-059)", () => {
  const request = {
    execution: {
      id: EXECUTION_ID,
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      status: "CREATED",
    },
    actorId: "actor-1",
  };

  test("an ALLOW verdict passes through verbatim and is recorded with policy provenance", async () => {
    const store = baseStore();
    const decision = {
      allowed: true,
      evidence: {
        policySetId: "ps-1",
        policySetVersion: 3,
        policyContentHash: "a".repeat(64),
        restrictionSetDigest: "b".repeat(64),
      },
    };
    const observing = createObservingAdmission({
      inner: { evaluate: async () => decision },
      store,
      environment: "production",
      command: "authorize",
      now: NOW,
    });
    const verdict = await observing.evaluate(request);
    expect(verdict).toEqual(decision);
    const records = await store.listRecords(APPLICATION_ID);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.action.kind).toBe("policy.decision");
    expect(record.rationale.policyContext).toEqual(decision.evidence);
    expect(record.actionDetail).toEqual({ allowed: true, executionStatus: "CREATED" });
  });

  test("a DENY verdict passes through verbatim (the observer never changes a decision)", async () => {
    const store = baseStore();
    const decision = { allowed: false, reason: "provider not permitted by policy" };
    const observing = createObservingAdmission({
      inner: { evaluate: async () => decision },
      store,
      environment: "production",
      command: "authorize",
      now: NOW,
    });
    const verdict = await observing.evaluate(request);
    expect(verdict).toEqual(decision);
    const record = (await store.listRecords(APPLICATION_ID))[0]!;
    expect(record.actionDetail).toEqual({
      allowed: false,
      executionStatus: "CREATED",
      denialReason: "provider not permitted by policy",
    });
    expect(record.rationale.why).toContain("denied");
  });

  test("repeated evaluation under the same policy converges to one record; a new policy version is new evidence", async () => {
    const store = baseStore();
    const evidence = {
      policySetId: "ps-1",
      policySetVersion: 3,
      policyContentHash: "a".repeat(64),
    };
    const observing = createObservingAdmission({
      inner: { evaluate: async () => ({ allowed: true, evidence }) },
      store,
      environment: "production",
      command: "authorize",
      now: NOW,
    });
    await observing.evaluate(request);
    await observing.evaluate(request);
    expect(await store.listRecords(APPLICATION_ID)).toHaveLength(1);
    const observingV4 = createObservingAdmission({
      inner: {
        evaluate: async () => ({
          allowed: true,
          evidence: { ...evidence, policySetVersion: 4, policyContentHash: "c".repeat(64) },
        }),
      },
      store,
      environment: "production",
      command: "authorize",
      now: NOW,
    });
    await observingV4.evaluate(request);
    const records = await store.listRecords(APPLICATION_ID);
    expect(records).toHaveLength(2);
    expect(records[1]?.rationale.policyContext?.policySetVersion).toBe(4);
  });
});

describe("the decision-record seam observer (WORK-059)", () => {
  const decision = {
    decisionId: "d".repeat(64),
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    planId: "e".repeat(64),
    irId: "f".repeat(64),
    selectedCandidateId: "deterministic-run",
    transformationBasis: {
      code: "representation-substitution",
      detail: "The governed plan's model route can be represented by the deterministic capability.",
    },
  };

  test("an appended decision is observed as evidence; the outcome passes through verbatim", async () => {
    const store = baseStore();
    const observing = createObservingDecisionStore({
      inner: {
        append: async (record) => {
          expect(record.decisionId).toBe(decision.decisionId);
          return { decisionId: record.decisionId, replayed: false };
        },
      },
      store,
      environment: "production",
      now: NOW,
    });
    const outcome = await observing.append(decision);
    expect(outcome).toEqual({ decisionId: decision.decisionId, replayed: false });
    const records = await store.listRecords(APPLICATION_ID);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.action.kind).toBe("decision.recorded");
    expect(record.target).toEqual({ kind: "decision", id: decision.decisionId });
    expect(record.provenance.seam).toBe("optimization-decisions");
    expect(record.rationale.why).toBe(decision.transformationBasis.detail);
  });

  test("re-appending the SAME decision (identity replay) converges to one record", async () => {
    const store = baseStore();
    const observing = createObservingDecisionStore({
      inner: { append: async (record) => ({ decisionId: record.decisionId, replayed: false }) },
      store,
      environment: "production",
      now: NOW,
    });
    await observing.append(decision);
    const replaying = createObservingDecisionStore({
      inner: { append: async (record) => ({ decisionId: record.decisionId, replayed: true }) },
      store,
      environment: "production",
      now: NOW,
    });
    const outcome = await replaying.append(decision);
    expect(outcome.replayed).toBe(true);
    expect(await store.listRecords(APPLICATION_ID)).toHaveLength(1);
  });
});
