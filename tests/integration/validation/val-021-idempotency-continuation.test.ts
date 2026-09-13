/**
 * VAL-021 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * idempotency-and-continuation application runs end to end against the
 * REAL platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL idempotency ledger arbitrating every submission: the
 *     duplicate creates REPLAY (identity preserved, the replayed flag
 *     surfaced by the REAL receipt), the conflicting replay gets the
 *     REAL typed 409 IDEMPOTENCY_KEY_REUSED, the five-create storm
 *     converges on ONE durable execution;
 *   - the REAL executions state machine: the canonical transitions,
 *     the durable planning decision recorded BEFORE the first
 *     dispatch, the GENUINE wait-user → resume pair (the continuation
 *     parks in WAITING_USER and resumes exactly once), the REAL
 *     stale-worker denial (the second resume against RUNNING is
 *     rejected by the frozen transition table and journaled as
 *     resume-denied evidence), and the REAL no-op resume replay (the
 *     exact completion transition re-issued under the same idempotency
 *     key REPLAYS with zero state change);
 *   - the REAL ledger journal: every dispatch attempt and every applied
 *     effect journaled exactly once (the per-attempt agent-action
 *     records with per-attempt-distinct idempotency keys — the VAL-018
 *     lesson), the execution_events sequence verified GAPLESS per
 *     execution;
 *   - the escalation routing records on the REAL ledger
 *     (agent-action-recorded with the causal-chain digests) and the
 *     idempotent re-escalation REPLAY (the authority receives the
 *     escalation exactly once);
 *   - mechanical verification: the corpus oracles, the effect
 *     multiplicity against the fixture state's own counters, the
 *     journal-sequence continuity, the resume-exactly-once contract
 *     and the escalation routing contract.
 *
 * The live rail rows (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drive REAL model dispatches through the REAL
 * platform model gateway where the continuation semantics demand them
 * (the continuation supervisor's confirmation rounds). Absent
 * credentials are a recorded NOT RUN boundary — never a fake success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runIdempotencyContinuationApp } from "../../../benchmarks/validation/apps/idempotency-continuation/application";
import {
  CONTINUATION_CORPUS,
  CORPUS_ESCALATION_DEPTH,
  CORPUS_RETRY_POLICY,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/idempotency-continuation/corpus";
import {
  createFaultedDispatch,
  createScriptedEscalationAuthority,
  createSettlementWorld,
  type EscalationAuthorityFixture,
  receiveEscalation,
} from "../../../benchmarks/validation/apps/idempotency-continuation/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import {
  type ContinuationCorpusRow,
  type ContinuationDispatch,
  type DispatchAttemptOutcome,
  driveIdempotencyContinuationExecution,
  type IdempotencyContinuationLifecyclePort,
} from "../../../benchmarks/validation/platform/idempotency-continuation";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import {
  SqlConnectionStore,
  SqlConnectionsIdempotency,
} from "../../../src/modules/connections/adapters/sql-connection-store";
import {
  createTxCredentialVault,
  SqlCredentialVault,
} from "../../../src/modules/connections/adapters/sql-credential-vault";
import { createConnectionService } from "../../../src/modules/connections/application/connection-service";
import { createFetchTransport } from "../../../src/modules/models/adapters/fetch-transport";
import { createOpenRouterAdapter } from "../../../src/modules/models/adapters/openrouter";
import { createSqlDispatchJournal } from "../../../src/modules/models/adapters/sql-dispatch-journal";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../../src/modules/models/application/rail-registry";
import {
  createEnvelopeCipher,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import type { Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const PROVIDER = "openrouter";
const MODEL = process.env.ZECK_VAL_021_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-021|idempotency-continuation|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly submissions: string;
  readonly attempts: number;
  readonly journaledAttempts: number;
  readonly journaledEffects: number;
  readonly waitUserCycles: number;
  readonly staleWorkerDenied: boolean | null;
  readonly noOpResumeReplayed: boolean | null;
  readonly escalationsRouted: number;
  readonly latencyMs: number;
  readonly usage: string;
  readonly appPassed: boolean;
  readonly submissionCriteria: string;
}

/**
 * The platform-side lifecycle binding over the REAL executions service
 * (the idempotency ledger, the state machine and the journal are the
 * system under test — every call rides the REAL single write path).
 */
function createLifecycleBinding(
  world: ApiPgWorld,
  authority: EscalationAuthorityFixture,
): IdempotencyContinuationLifecyclePort {
  const generateId = createUuidv7Generator();
  let transitionCounter = 0;
  let completeKeyOf: string | null = null;
  const verificationResultsOf = (
    criteria: readonly {
      criterionId: string;
      strategy: "deterministic";
      status: "PASS" | "FAIL";
      evidence: readonly string[];
    }[],
  ) =>
    criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      strategy: criterion.strategy,
      status: criterion.status,
      recordedBy: "val-021-platform",
      evidence: [...criterion.evidence],
    }));
  return {
    async transition({ executionId, step, reason, callKey }) {
      transitionCounter += 1;
      void callKey;
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: step,
          reason,
        },
        // Every call gets a unique key: repeated steps (wait-user /
        // resume / the stale-worker probe) must never collide on the
        // ledger — but the COMPLETION key is remembered for the no-op
        // resume replay (the exact-key re-issue).
        `val-021-${executionId}-${step}-${transitionCounter}`,
      );
    },
    async recordPlanningDecision({ executionId, route }) {
      await world.executions.recordPlanningDecision(
        {
          applicationId: world.applicationId,
          executionId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          decisionId: generateId(),
          planId: generateId(),
          payload: {
            candidates: [
              {
                strategyId: "val-021-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-021-pinned",
          },
        },
        `val-021-${executionId}-decision`,
      );
    },
    async recordDispatchAttempt({ executionId, record }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-021-dispatch-attempt-${record.attempt}`,
          reference: {
            attempt: record.attempt,
            segment: record.segment,
            outcome: record.outcome,
            category: record.category,
            retryable: record.retryable,
            retried: record.retried,
            latencyMs: record.latencyMs,
            requestDigest: record.requestDigest,
          },
          payload: { attempt: record.attempt, outcome: record.outcome },
        },
        // Distinct per attempt (the ledger sees distinct payloads).
        `val-021-${executionId}-attempt-${record.attempt}`,
      );
    },
    async recordEffect({ executionId, record }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-021-effect-${record.sequence}`,
          reference: {
            sequence: record.sequence,
            effect: record.effect,
            attempt: record.attempt,
            digest: record.digest,
          },
          payload: { effect: record.effect, sequence: record.sequence },
        },
        `val-021-${executionId}-effect-${record.sequence}`,
      );
    },
    async recordInterruption({ executionId, at, callKey }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "interruption-requested",
          cause: "val-021-interruption",
          reference: { at },
          payload: { at },
        },
        `val-021-${executionId}-interruption-${callKey}`,
      );
    },
    async recordResumeDenied({ executionId, reason, callKey }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "resume-denied",
          cause: "val-021-resume-denied",
          reference: { reason },
          payload: { reason },
        },
        `val-021-${executionId}-resume-denied-${callKey}`,
      );
    },
    async recordEscalation({ executionId, gateId, authority: routedTo, causalChain, callKey }) {
      const outcome = await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-021-escalation-${gateId}`,
          reference: {
            escalation: true,
            gateId,
            authority: routedTo,
            causalChain: causalChain.map((link) => ({ cause: link.cause, digest: link.digest })),
          },
          payload: { gateId, authority: routedTo },
        },
        // The idempotent escalation key: a re-issue with the SAME key
        // (the re-escalation probe) REPLAYS — the authority is not
        // notified again (exactly-once routing).
        `val-021-${executionId}-escalation-${callKey}`,
      );
      if (outcome.replayed) {
        return { routed: false, replayed: true };
      }
      receiveEscalation(authority, { gateId, authority: routedTo, causalChain });
      return { routed: true, replayed: false };
    },
    async complete(input) {
      completeKeyOf = `val-021-${input.executionId}-complete-${input.callKey}`;
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId: input.executionId,
          command: input.verdict,
          reason: input.reason,
          verificationResults: verificationResultsOf(input.criteria),
        },
        completeKeyOf,
      );
    },
    async attemptNoOpResume(input) {
      // Re-issue the EXACT completion transition (same key, same
      // fingerprint): the platform's idempotency ledger must REPLAY
      // it — zero state change (the VAL-014 ledger-key discipline).
      const replayed = await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId: input.executionId,
          command: input.verdict,
          reason: input.reason,
          verificationResults: verificationResultsOf(input.criteria),
        },
        completeKeyOf ?? `val-021-${input.executionId}-complete-unknown`,
      );
      return { replayed: replayed.replayed };
    },
  };
}

/** Build the REAL model-gateway dispatch round (the live rows' seam). */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{
  readonly dispatch: ContinuationDispatch;
  readonly principal: { readonly actorId: string; readonly authenticatedAt: string };
}> {
  const generateId = createUuidv7Generator();
  const cipher = createEnvelopeCipher(generateMasterKey());
  const auth = createSqlAuthModule(ctx.port, generateId);
  const vault = new SqlCredentialVault(ctx.port, cipher, generateId);
  const connections = createConnectionService(
    new SqlConnectionStore(ctx.port),
    new SqlConnectionsIdempotency(
      ctx.port,
      (tx: Transaction) => createTxCredentialVault(tx, cipher, generateId),
      generateId,
    ),
    createScopeResolver(auth.store),
    auth.store,
    generateId,
  );
  const registry = createRailRegistry([
    createOpenRouterAdapter({ transport: createFetchTransport() }),
  ]);
  const gateway = createModelGateway({
    resolver: createScopeResolver(auth.store),
    catalog: connections,
    credentials: vault,
    admission: {
      async admit() {
        return { allowed: true };
      },
    },
    capabilities: {
      async resolve() {
        return { satisfied: true, catalogRevision: "val-021", satisfactions: [] };
      },
    },
    rails: registry,
    journal: createSqlDispatchJournal(ctx.port),
    generateId,
    defaultTimeoutMs: 150_000,
    hashRequest: (request) =>
      createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
  });
  const principal = { actorId: world.actorId, authenticatedAt: new Date().toISOString() };
  const { connection } = await connections.registerConnection(
    {
      principal,
      applicationId: world.applicationId,
      rail: "openrouter",
      label: "val-021-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-021-conn-${generateId().slice(-8)}`,
  );

  const dispatch: ContinuationDispatch = async ({ executionId, segment }) => {
    const startedAt = Date.now();
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: MODEL,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are the continuation supervisor of a governed settlement execution.",
            "At each segment boundary you receive the committed settlement progress and",
            "decide whether the execution should continue. Answer with the single word: continue",
          ].join(" "),
        },
        {
          role: "user",
          content: `Segment ${segment} of the settlement batch. Confirm continuation.`,
        },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ executionId, segment, model: MODEL }))
      .digest("hex")
      .slice(0, 8);
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      const usage: LabUsage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.costUsd === null || response.usage.costUsd === undefined
          ? {}
          : { costUsd: response.usage.costUsd }),
      };
      const outcome: DispatchAttemptOutcome = {
        kind: "success",
        content: response.content.join("\n"),
        usage,
        latencyMs,
        requestDigest,
      };
      return outcome;
    }
    const failure = result.outcome.failure;
    const outcome: DispatchAttemptOutcome = {
      kind: "failure",
      category: failure.category,
      message: failure.providerMessage ?? "provider failure (no provider message)",
      latencyMs,
      requestDigest,
    };
    return outcome;
  };
  return { dispatch, principal };
}

/** Submit one corpus row through the public SDK boundary (the app). */
async function submitRow(
  world: ApiPgWorld,
  address: string,
  options: {
    readonly generateId: () => string;
    readonly taskIndex: number;
    readonly completionTimeoutMs: number;
  },
): Promise<Awaited<ReturnType<typeof runIdempotencyContinuationApp>>> {
  return runIdempotencyContinuationApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      pollIntervalMs: 250,
      completionTimeoutMs: options.completionTimeoutMs,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-021-idempotency-continuation" },
    },
    runSuffix: `it-${options.generateId().slice(-8)}`,
    taskIndex: options.taskIndex,
  });
}

/** Drive one corpus row platform-side and ledger-verify the journals. */
async function driveRow(
  ctx: PgContext,
  world: ApiPgWorld,
  options: {
    readonly row: ContinuationCorpusRow;
    readonly executionId: string;
    readonly dispatch?: ContinuationDispatch;
    readonly authority: EscalationAuthorityFixture;
    readonly settlementWorld: ReturnType<typeof createSettlementWorld>;
  },
): Promise<RunFacts> {
  const lifecycle = createLifecycleBinding(world, options.authority);
  const result = await driveIdempotencyContinuationExecution({
    executionId: options.executionId,
    row: options.row,
    provider: options.row.needsDispatch ? PROVIDER : "deterministic-fixture",
    model: options.row.needsDispatch ? MODEL : "none",
    lifecycle,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    world: options.settlementWorld,
    escalationSource: options.authority,
    retry: {
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      backoffMs: options.dispatch === undefined ? 10 : 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    maxEscalationDepth: CORPUS_ESCALATION_DEPTH,
    now: () => new Date(),
  });

  // ---- the durable ledger cross-checks (the REAL journals) ----
  const events = await ctx.port.execute<{ command: string; cause: string; sequence: number }>({
    sql: `SELECT command, cause, sequence FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence ASC`,
    parameters: [options.executionId],
  });
  const commands = events.rows.map((rowEvent) => rowEvent.command);
  const sequences = events.rows.map((rowEvent) => rowEvent.sequence);
  // 2026-09-12 Lead review fix: REAL PostgreSQL event rows can carry a
  // NULL cause (the platform's own cause-less transitions) — the fake
  // world never produced one, so the unguarded startsWith crashed on the
  // first live run. Null-safe filtering.
  const causeOf = (rowEvent: { cause: string | null }): string => rowEvent.cause ?? "";
  const journaledAttempts = events.rows.filter((rowEvent) =>
    causeOf(rowEvent).startsWith("val-021-dispatch-attempt-"),
  ).length;
  const journaledEffects = events.rows.filter((rowEvent) =>
    causeOf(rowEvent).startsWith("val-021-effect-"),
  ).length;
  const waitUserCycles = commands.filter((command) => command === "wait-user").length;
  const resumeCommands = commands.filter((command) => command === "resume").length;
  const resumeDenials = commands.filter((command) => command === "resume-denied").length;
  const escalationEvents = events.rows.filter((rowEvent) =>
    causeOf(rowEvent).startsWith("val-021-escalation-"),
  ).length;

  // The honest outcome contract for every run.
  expect(result.terminal, `${options.row.rowId} terminal`).toBe(options.row.expected.terminal);
  const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
  expect(failedCriteria, `${options.row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
  // Journal exactly once per attempt — ledger-verified.
  expect(journaledAttempts, `${options.row.rowId} attempts`).toBe(result.attempts.length);
  // The effect journal — ledger-verified, exactly the driver's records.
  expect(journaledEffects, `${options.row.rowId} effects`).toBe(result.effects.length);
  // The execution_events sequence is GAPLESS (the AC4 continuity).
  const gapless = sequences.every((sequence, index) => sequence === index + 1);
  expect(gapless, `${options.row.rowId} sequences: ${sequences.join(",")}`).toBe(true);
  // The continuation cycles — ledger-verified.
  expect(waitUserCycles, `${options.row.rowId} wait-user`).toBe(
    options.row.expected.waitUserCycles,
  );
  expect(resumeCommands, `${options.row.rowId} resumes`).toBe(result.resumeAdmitted);
  if (options.row.pattern === "continue") {
    // wait-user + the admitted resumes (+1 for the admitted stale probe).
    expect(resumeCommands).toBe(options.row.expected.waitUserCycles);
  }
  if (options.row.staleWorkerProbe) {
    expect(resumeDenials, `${options.row.rowId} resume-denied`).toBe(1);
  }
  // The escalation routing — ledger-verified (routed + the replayed probe).
  if (options.row.pattern === "escalate") {
    const routed = result.escalations.filter((record) => record.routed).length;
    expect(routed).toBe(options.row.expected.escalationRouted);
    // ONE ledger event per routed escalation (the replayed probe
    // re-issued the same key — no second event).
    expect(escalationEvents).toBe(1);
    // The authority RECEIVED exactly one escalation (exactly-once
    // routing — the replayed re-issue never re-notified).
    expect(options.authority.received.length).toBe(options.row.expected.escalationRouted);
    expect(options.authority.received[0]?.authority).toBe("settlement-ops-oncall");
  }
  // The no-op resume replay: the execution stays COMPLETED (zero
  // state change) after the re-issued completion.
  if (options.row.noOpResumeProbe) {
    expect(result.noOpResumeReplayed).toBe(options.row.expected.noopResumeReplayed);
    const after = await world.executions.getExecution(world.applicationId, options.executionId);
    expect(after?.status).toBe("COMPLETED");
  }

  return {
    rowId: options.row.rowId,
    terminal: result.terminal,
    submissions: "n/a (app-side)",
    attempts: result.attempts.length,
    journaledAttempts,
    journaledEffects,
    waitUserCycles,
    staleWorkerDenied: result.staleWorkerDenied,
    noOpResumeReplayed: result.noOpResumeReplayed,
    escalationsRouted: result.escalations.filter((record) => record.routed).length,
    latencyMs: result.totalDispatchLatencyMs,
    usage:
      result.usage === null
        ? "none-reported"
        : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
          (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`),
    appPassed: false,
    submissionCriteria: "n/a",
  };
}

/** Wait for THIS row's submission to land as a new execution row. */
async function awaitNextExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  drivenExecutionIds: Set<string>,
): Promise<string> {
  for (let attempt = 0; attempt < 2_400; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string }>({
      sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
      parameters: [world.applicationId],
    });
    const id = rows.rows[0]?.id;
    if (id !== undefined && !drivenExecutionIds.has(id)) {
      drivenExecutionIds.add(id);
      return id;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no new execution landed for the submitted row");
}

definePgSuite("VAL-021 idempotency and continuation over the real platform path", (ctx) => {
  test("the offline corpus drives duplicate/conflict/retry/escalation/continuation semantics over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      for (const row of OFFLINE_CORPUS_ROWS) {
        const taskIndex = CONTINUATION_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        const appPromise = submitRow(world, address, {
          generateId,
          taskIndex,
          completionTimeoutMs: 120_000,
        }).then(
          (outcome) => ({ ok: true as const, outcome }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        const executionId = await awaitNextExecution(ctx, world, drivenExecutionIds);

        const settlementWorld = createSettlementWorld();
        const authority = createScriptedEscalationAuthority({
          authority: row.escalation?.authority ?? "settlement-ops-oncall",
        });
        let dispatch: ContinuationDispatch | undefined;
        if (row.rowId === "retry-storm-bounded-dispatch") {
          dispatch = createFaultedDispatch({
            scenario: "transport-fail-twice-then-success",
          }).dispatch;
        } else if (row.rowId === "retry-storm-exhausted") {
          dispatch = createFaultedDispatch({ scenario: "transport-fail-always" }).dispatch;
        }

        const facts = await driveRow(ctx, world, {
          row,
          executionId,
          ...(dispatch === undefined ? {} : { dispatch }),
          authority,
          settlementWorld,
        });

        const appSettled = await appPromise;
        if (!appSettled.ok) {
          throw appSettled.error;
        }
        const violations = validateHarnessEvidence(appSettled.outcome.evidence);
        expect(violations).toEqual([]);
        // The application's assertions PASS on the honest outcome.
        expect(appSettled.outcome.passed, `${row.rowId} app passed`).toBe(true);
        // The submission contract: every criterion PASSes.
        const failedSubmission = appSettled.outcome.submissionCriteria.filter(
          (criterion) => criterion.status === "FAIL",
        );
        expect(failedSubmission, `${row.rowId}: ${JSON.stringify(failedSubmission)}`).toEqual([]);
        // The submission facts match the row's declared pattern.
        expect(appSettled.outcome.submissionFacts.replayed).toBe(row.expected.replayedSubmissions);
        expect(appSettled.outcome.submissionFacts.rejected).toBe(row.expected.rejectedSubmissions);

        // ---- the idempotency ledger cross-check: ONE durable
        // execution + ONE ledger record per submission key ----
        const appKeyCount = await ctx.port.execute<{ count: string }>({
          sql: `SELECT COUNT(*)::text AS count FROM platform.idempotency_records
WHERE application_id = $1 AND operation_name = 'executions.create' AND idempotency_key LIKE 'val-021-%'`,
          parameters: [world.applicationId],
        });
        expect(Number(appKeyCount.rows[0]?.count ?? "0")).toBe(runFacts.length + 1);

        const executionCount = await ctx.port.execute<{ count: string }>({
          sql: `SELECT COUNT(*)::text AS count FROM executions.executions WHERE application_id = $1`,
          parameters: [world.applicationId],
        });
        // Every row so far created EXACTLY ONE execution (the storm
        // converged; the conflict never created a second one).
        expect(Number(executionCount.rows[0]?.count ?? "0")).toBe(runFacts.length + 1);

        // The conflict row surfaced the typed rejection as evidence.
        if (row.pattern === "conflict") {
          const typed = appSettled.outcome.evidence.errors.find(
            (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
          );
          expect(typed).toBeDefined();
          expect(typed?.status).toBe(409);
        }

        runFacts.push({
          ...facts,
          appPassed: appSettled.outcome.passed,
          submissions: `${appSettled.outcome.submissionFacts.created}c+${appSettled.outcome.submissionFacts.replayed}r+${appSettled.outcome.submissionFacts.rejected}x`,
          submissionCriteria: appSettled.outcome.submissionCriteria
            .map((criterion) => `${criterion.criterionId}:${criterion.status}`)
            .join(","),
        });
        console.info(
          `[VAL-021]   ${facts.rowId} -> ${facts.terminal} ` +
            `subs=${runFacts[runFacts.length - 1]?.submissions} ` +
            `attempts=${facts.attempts} journaled=${facts.journaledAttempts} ` +
            `effects=${facts.journaledEffects} waitUser=${facts.waitUserCycles} ` +
            `staleDenied=${String(facts.staleWorkerDenied)} ` +
            `noopReplayed=${String(facts.noOpResumeReplayed)} ` +
            `escalations=${facts.escalationsRouted} latency=${facts.latencyMs}ms ` +
            `usage=${facts.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-021] OFFLINE corpus summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
          `of ${runFacts.length} driven rows; every execution_events sequence gapless; every ` +
          `attempt/effect journaled exactly once; every submission key holding exactly ONE ` +
          `durable execution (zero credentials).`,
      );
      expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives the continuation semantics with REAL model dispatches", {
    timeout: 240_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const notRun: string[] = [];
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-021] OPENROUTER_API_KEY absent — the REAL live continuation rows are a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every duplicate/conflict/retry/escalation/continuation path without credentials. " +
          "Required access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
          "covering the default chat model — the continuation supervisor's confirmation rounds " +
          "demand REAL model dispatches.",
      );
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const { dispatch } = await buildLiveDispatch(ctx, world);
    const drivenExecutionIds = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      for (const [corpusIndex, row] of CONTINUATION_CORPUS.entries()) {
        if (row.liveGate === undefined) {
          continue;
        }
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate.envVars.join("+")} absent); ` +
              `requirement: ${row.liveGate.requirement}`,
          );
          continue;
        }
        // Provider-side pacing: a modest spacing between REAL dispatches.
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        const appPromise = submitRow(world, address, {
          generateId,
          taskIndex: corpusIndex,
          completionTimeoutMs: 180_000,
        }).then(
          (outcome) => ({ ok: true as const, outcome }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        const executionId = await awaitNextExecution(ctx, world, drivenExecutionIds);

        const settlementWorld = createSettlementWorld();
        const authority = createScriptedEscalationAuthority({
          authority: row.escalation?.authority ?? "settlement-ops-oncall",
        });
        const facts = await driveRow(ctx, world, {
          row,
          executionId,
          dispatch,
          authority,
          settlementWorld,
        });

        const appSettled = await appPromise;
        if (!appSettled.ok) {
          throw appSettled.error;
        }
        expect(validateHarnessEvidence(appSettled.outcome.evidence)).toEqual([]);
        expect(appSettled.outcome.passed, `${row.rowId} app passed`).toBe(true);
        const failedSubmission = appSettled.outcome.submissionCriteria.filter(
          (criterion) => criterion.status === "FAIL",
        );
        expect(failedSubmission).toEqual([]);

        runFacts.push({
          ...facts,
          appPassed: appSettled.outcome.passed,
          submissions: `${appSettled.outcome.submissionFacts.created}c+${appSettled.outcome.submissionFacts.replayed}r+${appSettled.outcome.submissionFacts.rejected}x`,
          submissionCriteria: appSettled.outcome.submissionCriteria
            .map((criterion) => `${criterion.criterionId}:${criterion.status}`)
            .join(","),
        });
        console.info(
          `[VAL-021]   LIVE ${facts.rowId} -> ${facts.terminal} ` +
            `subs=${runFacts[runFacts.length - 1]?.submissions} ` +
            `attempts=${facts.attempts} journaled=${facts.journaledAttempts} ` +
            `waitUser=${facts.waitUserCycles} latency=${facts.latencyMs}ms usage=${facts.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const totalInput = runFacts.reduce(
        (sum, fact) => sum + Number.parseInt(fact.usage.split("+")[0] ?? "0", 10) || 0,
        0,
      );
      console.info(
        `[VAL-021] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live ` +
          `rows over the REAL OpenRouter rail (model ${MODEL}); measured usage ${totalInput}+ ` +
          `input tokens (BYOK).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-021] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live dispatch happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
