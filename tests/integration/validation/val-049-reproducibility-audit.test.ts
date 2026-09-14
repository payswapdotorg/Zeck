/**
 * VAL-049 acceptance criteria 3 and 7 — the crown proof: the
 * reproducibility and anti-gaming audit corpus runs end to end against
 * the REAL platform path over REAL PostgreSQL.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port;
 *   - the RECORDED EVIDENCE BASIS served READ-ONLY: every audited
 *     offline reference of the corpus (the digest fingerprints over the
 *     recorded corpora of VAL-041..048 — the recomputed content digests
 *     and the re-derived recorded verdicts, payload bytes NEVER
 *     recorded) pre-seeded READ-ONLY into REAL SQL through the
 *     platform's own idempotency-record arbitration: an identical
 *     re-commit REPLAYS; a different-content commit under a recorded
 *     key THROWS (the recorded history is a frozen input), then served
 *     back over FRESH SQL reads and verified digest-for-digest against
 *     the audit engine's own re-derivation at verification time;
 *   - the REAL executions state machine: the canonical transitions, the
 *     durable planning decisions carrying the AUDIT DECISIONS (the arm,
 *     the audited work orders, the audited evidence digest references,
 *     the gaming vectors under probe) BEFORE any input is consulted,
 *     and the gapless step-event journal (per-record-distinct
 *     idempotency keys — the VAL-018 lesson);
 *   - the REAL idempotency ledger arbitrating every submission (one
 *     record per app key; no drift, no phantoms, no orphan events —
 *     verified against the REAL SQL row counts);
 *   - the REAL accounting rails: every audit record sealed through the
 *     REAL validation recorder (offline replay rows seal honest
 *     zero-cost measured facts — the audit derives, it never
 *     re-measures; the live rail below owns the measured lane);
 *   - the whole offline audit corpus driven crown-style: the honest
 *     replay rows (REPRODUCIBLE-VERIFIED over VAL-041..048, the declared
 *     divergence record, the NOT-AUDITABLE boundaries, the offline
 *     bounds floor, the GAMING-DETECTED single-vector and
 *     cross-vector-combination probes, the accepted-risk resolution)
 *     COMPLETING with the pinned audit verdicts; the four adversarial
 *     audit-probe rows (rubber-stamp / favorable-subset / off-bounds /
 *     unresolved-finding) FAILing their NAMED criteria honestly;
 *   - trajectory determinism: a headline re-drive over a FRESH
 *     submission reproduces its audit EXACTLY (the same replays
 *     digest-for-digest, the same criteria statuses and the same
 *     deterministic audit evidence);
 *   - freeze integrity after the battery: the recorded evidence basis
 *     is still the frozen input (identical re-commit REPLAYS over FRESH
 *     SQL reads after the whole corpus drove).
 *
 * Test 2 (the live rail): the env-gated REAL re-run audit slice — an
 * absent OPENROUTER_API_KEY is an honest NOT RUN boundary (logged,
 * skipped, never fabricated); the live path (REAL dispatches on the
 * pinned OpenRouter rail — max_tokens 32 pinned, measured usage priced
 * at the pinned manifest revision, the measured resolution rate checked
 * against the RECORDED declared bounds through the bounds-held oracle,
 * sealed through the REAL recorder) is fully wired for when the
 * credential lands (the operator/session-B live review).
 *
 * Digest-only assertions everywhere (payload bytes never journaled);
 * no credentials in the repository, logs or reports.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runAuditApp } from "../../../benchmarks/validation/apps/economic-audit/application";
import {
  AUDIT_CORPUS,
  AUDIT_CORPUS_VERSION,
  AUDIT_TASK_KIND,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/economic-audit/corpus";
import type {
  AuditCorpusRow,
  AuditedEvidenceReference,
} from "../../../benchmarks/validation/apps/economic-audit/driver";
import {
  auditEvidenceDigestOf,
  driveAuditRow,
  LIVE_AUDIT_PLAN,
  liveAuditPlanDigestOf,
  replayRecordedEvidenceOf,
} from "../../../benchmarks/validation/apps/economic-audit/driver";
import {
  createRealAccountingRails,
  gamingProbesFor,
} from "../../../benchmarks/validation/apps/economic-audit/fixtures";
import type {
  EconomicLifecyclePort,
  EconomicWorldFacts,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import {
  manifestRevisionOf,
  parseDecimal,
  resolveListPrice,
} from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { divRoundHalfUp } from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { ExecutionService } from "../../../src/modules/executions/application/execution-service";
import type { Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const REVISION = createHash("sha256")
  .update("val-049|economic-audit|pinned")
  .digest("hex")
  .slice(0, 40);

/** The REAL SQL operation the crown's recorded-evidence bindings ride. */
const RECORDED_EVIDENCE_OPERATION = "val-049.recorded-evidence";

/** The recorded direct-arm reference (the live re-run's bounds basis). */
const DIRECT_BOUNDS_REFERENCE = {
  workOrder: "VAL-041" as const,
  corpusRowId: "fixed-quality-direct-default-rail",
};

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly mechanism: string;
  readonly arm: string;
  readonly replays: number;
  readonly criteriaPassed: number;
  readonly criteriaFailed: number;
  readonly appPassed: boolean;
  readonly usage: string;
  readonly latencyMs: number;
  readonly inputDigests: readonly string[];
}

// ---------------------------------------------------------------------------
// The REAL world bindings
// ---------------------------------------------------------------------------

/** The REAL durable world facts over the application's SQL ledger. */
function createWorldFacts(ctx: PgContext, world: ApiPgWorld): () => Promise<EconomicWorldFacts> {
  return async () => {
    const execCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    const eventCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.execution_events WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    const keyCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = 'executions.create'`,
      parameters: [world.applicationId],
    });
    const orphans = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.execution_events e
            LEFT JOIN executions.executions x ON e.execution_id = x.id
            WHERE e.application_id = $1 AND x.id IS NULL`,
      parameters: [world.applicationId],
    });
    return {
      executionCount: execCount.rows[0]?.c ?? 0,
      eventCount: eventCount.rows[0]?.c ?? 0,
      idempotencyRecordCount: keyCount.rows[0]?.c ?? 0,
      orphanEventCount: orphans.rows[0]?.c ?? 0,
    };
  };
}

/**
 * The platform-side lifecycle binding over the REAL executions
 * service: the canonical transitions (per-call-distinct idempotency
 * keys — the VAL-018 lesson), the durable planning decisions carrying
 * the AUDIT DECISIONS, the step-event journal (digest references
 * only), the terminal completion with the mechanically derived
 * criteria and the observed-terminal read-back.
 */
function createLifecycleBinding(
  world: ApiPgWorld,
  executions: ExecutionService,
): EconomicLifecyclePort {
  const generateId = createUuidv7Generator();
  let transitionCounter = 0;
  return {
    async transition({ executionId, step, reason, callKey }) {
      transitionCounter += 1;
      void callKey;
      await executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: step,
          reason,
        },
        `val-049-${executionId}-${step}-${transitionCounter}`,
      );
    },
    async recordPlanningDecision({ executionId, route, armDecision }) {
      await executions.recordPlanningDecision(
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
                strategyId: "val-049-audit",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-049-audit",
            armDecision,
          },
        },
        `val-049-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-049-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        `val-049-${executionId}-${record.kind}-${record.ordinal}`,
      );
    },
    async complete({ executionId, verdict, criteria, reason }) {
      await executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: verdict,
          reason,
          verificationResults: criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            strategy: criterion.strategy,
            status: criterion.status,
            recordedBy: "val-049-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-049-${executionId}-${verdict}`,
      );
    },
    async statusOf(executionId) {
      const execution = await executions.getExecution(world.applicationId, executionId);
      return execution?.status ?? null;
    },
  };
}

/**
 * The landed-executions provider: polls the REAL SQL until the row's
 * expected count of the APP's audit executions land.
 */
function createLandedProvider(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  taskKind: string,
): (group: number, expectedCount: number) => Promise<readonly string[]> {
  return async (group, expectedCount) => {
    void group;
    for (let attempt = 0; attempt < 4_800; attempt += 1) {
      const rows = await ctx.port.execute<{ id: string }>({
        sql: `SELECT id FROM executions.executions
              WHERE application_id = $1
                AND task->>'kind' = $2
                AND id != ALL($3::uuid[])
              ORDER BY created_at ASC, id ASC
              LIMIT $4`,
        parameters: [world.applicationId, taskKind, [...driven], expectedCount],
      });
      if (rows.rows.length >= expectedCount) {
        const ids = rows.rows.map((row) => row.id);
        for (const id of ids) {
          driven.add(id);
        }
        return ids;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no new landed executions after 120s (expected ${expectedCount})`);
  };
}

// ---------------------------------------------------------------------------
// The RECORDED evidence basis served over REAL SQL (the frozen input)
// ---------------------------------------------------------------------------

/** The generic REAL SQL insert-or-replay arbitration (append-only). */
async function arbitrate(
  ctx: PgContext,
  world: ApiPgWorld,
  generateId: () => string,
  operation: string,
  key: string,
  fingerprint: string,
  durableOutcome: Record<string, unknown>,
): Promise<{
  readonly accepted: boolean;
  readonly replayed: boolean;
  readonly refused: boolean;
}> {
  return ctx.port.transaction(async (tx: Transaction) => {
    const inserted = await tx.execute<{ id: string }>({
      sql: `INSERT INTO platform.idempotency_records
                (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
              ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
              DO NOTHING
              RETURNING id`,
      parameters: [
        generateId(),
        world.actorId,
        world.applicationId,
        operation,
        key,
        fingerprint,
        JSON.stringify(durableOutcome),
      ],
    });
    if (inserted.rows.length > 0) {
      return { accepted: true, replayed: false, refused: false };
    }
    const existing = await tx.execute<{ request_fingerprint: string }>({
      sql: `SELECT request_fingerprint FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
      parameters: [world.applicationId, operation, key],
    });
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new Error(`the ${operation} arbitration lost the record ${key}`);
    }
    if (existingRow.request_fingerprint === fingerprint) {
      return { accepted: true, replayed: true, refused: false };
    }
    return { accepted: false, replayed: false, refused: true };
  });
}

/** The read-only commit: an identical re-commit replays, different content THROWS. */
async function commitReadOnly(
  ctx: PgContext,
  world: ApiPgWorld,
  generateId: () => string,
  operation: string,
  key: string,
  fingerprint: string,
  durableOutcome: Record<string, unknown>,
): Promise<boolean> {
  const receipt = await arbitrate(
    ctx,
    world,
    generateId,
    operation,
    key,
    fingerprint,
    durableOutcome,
  );
  if (receipt.refused) {
    throw new Error(
      `append-only violation: the recorded record ${key} is already committed with ` +
        "different content — the recorded evidence basis is a read-only input",
    );
  }
  return receipt.replayed;
}

/** One audited offline reference (the corpus's own digest reference shape). */
interface RecordedEvidenceRecord {
  readonly key: string;
  readonly workOrder: string;
  readonly corpusRowId: string;
  readonly fingerprint: string;
  readonly replayedVerdict: string;
}

/**
 * The corpus's audited OFFLINE references in corpus order (the complete
 * read surface the audit replays — live-slice references excluded: the
 * honest NOT-AUDITABLE boundary is never offline evidence).
 */
function auditedOfflineReferences(): readonly RecordedEvidenceRecord[] {
  const seen = new Set<string>();
  const records: RecordedEvidenceRecord[] = [];
  for (const row of AUDIT_CORPUS) {
    for (const reference of row.evidence) {
      const key = `${reference.workOrder}::${reference.corpusRowId}`;
      if (seen.has(key)) {
        continue;
      }
      const replay = replayRecordedEvidenceOf(reference);
      if (!replay.resolvable || replay.liveSlice) {
        continue;
      }
      seen.add(key);
      records.push({
        key,
        workOrder: reference.workOrder,
        corpusRowId: reference.corpusRowId,
        fingerprint: replay.recomputedDigest,
        replayedVerdict: replay.replayedVerdict,
      });
    }
  }
  return records;
}

/**
 * Seed the RECORDED evidence basis into REAL SQL (read-only): every
 * audited offline reference's content digest as the fingerprint and the
 * re-derived recorded verdict as the durable outcome (payload bytes
 * NEVER recorded — digest references only). The second pass over an
 * already-seeded world REPLAYS every record.
 */
async function seedRecordedEvidenceBasis(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{
  readonly records: number;
  readonly replayed: boolean;
}> {
  const generateId = createUuidv7Generator();
  let replayed = false;
  const references = auditedOfflineReferences();
  for (const record of references) {
    const wasReplayed = await commitReadOnly(
      ctx,
      world,
      generateId,
      RECORDED_EVIDENCE_OPERATION,
      record.key,
      record.fingerprint,
      {
        workOrder: record.workOrder,
        corpusRowId: record.corpusRowId,
        replayedVerdict: record.replayedVerdict,
      },
    );
    replayed = replayed || wasReplayed;
  }
  return { records: references.length, replayed };
}

/**
 * Serve the RECORDED evidence basis back over FRESH SQL reads and
 * verify it digest-for-digest against the audit engine's own
 * re-derivation at verification time (the served basis IS the replay
 * basis — never a copy, never a re-measurement).
 */
async function verifyServedEvidenceBasis(ctx: PgContext, world: ApiPgWorld): Promise<number> {
  const rows = await ctx.port.execute<{
    idempotency_key: string;
    request_fingerprint: string;
    durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT idempotency_key, request_fingerprint, durable_outcome
            FROM platform.idempotency_records
           WHERE application_id = $1 AND operation_name = $2
           ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, RECORDED_EVIDENCE_OPERATION],
  });
  expect(rows.rows.length).toBe(auditedOfflineReferences().length);
  for (const row of rows.rows) {
    const [workOrder, corpusRowId] = row.idempotency_key.split("::");
    const replay = replayRecordedEvidenceOf({
      workOrder: workOrder as AuditedEvidenceReference["workOrder"],
      corpusRowId: corpusRowId ?? "",
    });
    expect(replay.resolvable, row.idempotency_key).toBe(true);
    expect(replay.liveSlice, row.idempotency_key).toBe(false);
    expect(row.request_fingerprint, row.idempotency_key).toBe(replay.recomputedDigest);
    expect(row.durable_outcome.replayedVerdict, row.idempotency_key).toBe(replay.replayedVerdict);
  }
  return rows.rows.length;
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one audit row crown-style: the app rides the public wire (the
 * customer-side submission + completion poll + result retrieval) while
 * the driver drives the landed execution through the REAL platform
 * path — the re-derivation EXECUTES over the digest-referenced recorded
 * corpora, the gaming probes run against the FINAL integrated
 * machinery, the audit record seals through the REAL accounting rails
 * and the mechanically derived verdict settles over the REAL ledger.
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: AuditCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly driven: Set<string>;
  readonly facts: () => Promise<EconomicWorldFacts>;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveAuditRow>>;
  readonly appOutcome: Awaited<ReturnType<typeof runAuditApp>>;
}> {
  const { world, row, taskIndex } = options;
  const lifecycle = createLifecycleBinding(world, world.executions);
  const baseline = await options.facts();
  const metadata = {
    program: "zeck-validation",
    workOrder: "VAL-049",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: AUDIT_CORPUS_VERSION,
    integrationSurface: "audit:recorded-evidence-replay",
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-049-reproducibility-audit", row: row.rowId },
    },
    observedAt: new Date().toISOString(),
  };

  // The app promise: submits through the public wire and polls to the
  // row's terminal while the driver drives the landed lane.
  const appPromise = runAuditApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: AUDIT_CORPUS_VERSION,
      integrationSurface: "audit:recorded-evidence-replay",
      pollIntervalMs: 250,
      completionTimeoutMs: 300_000,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-049-reproducibility-audit" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  });

  const result = await driveAuditRow({
    row,
    lifecycle,
    probes: gamingProbesFor(row),
    rails: createRealAccountingRails(),
    metadata,
    environmentIdentity: `val-049-crown-${row.rowId}`,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(options.ctx, world, options.driven, AUDIT_TASK_KIND),
    now: () => new Date(),
  });
  const appOutcome = await appPromise;
  return { result, appOutcome };
}

/** The deterministic criteria whose evidence a re-drive must reproduce EXACTLY. */
const REPRODUCIBLE_CRITERIA = new Set([
  "audit-input-integrity",
  "rubber-stamp-detection",
  "favorable-subset-sampling",
  "verdict-grounding",
  "gaming-probe-completeness",
  "bounds-held",
  "resolution-honesty",
  "not-auditable-boundary",
  "audit-outcome-oracle",
  "observed-terminal-readback",
]);

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite(
  "VAL-049 reproducibility and anti-gaming audit over the real platform path",
  (ctx) => {
    test("the offline audit corpus drives every row over the REAL platform path", {
      timeout: 600_000,
    }, async () => {
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const facts = createWorldFacts(ctx, world);
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];

      /** Each adversarial audit-probe row's NAMED criterion (the honest failure). */
      const probeNamedCriterion: Readonly<Record<string, string>> = {
        "probe-audit-rubber-stamp": "rubber-stamp-detection",
        "probe-audit-favorable-subset": "favorable-subset-sampling",
        "probe-audit-off-bounds": "bounds-held",
        "probe-audit-unresolved-finding": "resolution-honesty",
      };

      try {
        // ---- the RECORDED evidence basis seeded READ-ONLY over REAL SQL ----
        const seeding = await seedRecordedEvidenceBasis(ctx, world);
        expect(seeding.replayed).toBe(false);
        // 90 audited offline references across VAL-041..048 (the corpus's
        // complete offline read surface; the live-slice references are the
        // honest NOT-AUDITABLE boundary, never offline evidence).
        expect(seeding.records).toBe(90);
        // The read-only discipline: the identical re-commit REPLAYS
        // (nothing new lands, nothing drifts).
        const reseed = await seedRecordedEvidenceBasis(ctx, world);
        expect(reseed.replayed).toBe(true);
        expect(reseed.records).toBe(seeding.records);
        // A different-content commit under a recorded key THROWS (the
        // recorded evidence basis is a frozen input).
        const anyReference = auditedOfflineReferences()[0];
        if (anyReference === undefined) {
          throw new Error("the audited offline references are empty");
        }
        const generateId = createUuidv7Generator();
        await expect(
          commitReadOnly(
            ctx,
            world,
            generateId,
            RECORDED_EVIDENCE_OPERATION,
            anyReference.key,
            "deadbeef",
            {
              workOrder: anyReference.workOrder,
              corpusRowId: anyReference.corpusRowId,
              replayedVerdict: "a-verdict-that-never-recorded",
            },
          ),
        ).rejects.toThrow(/append-only violation/);
        // The served basis IS the audit engine's own re-derivation basis
        // (digest-for-digest, over FRESH SQL reads).
        const served = await verifyServedEvidenceBasis(ctx, world);
        expect(served).toBe(seeding.records);

        // ---- every offline row end to end over the REAL platform path ----
        for (const row of OFFLINE_CORPUS_ROWS) {
          const taskIndex = AUDIT_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
          expect(taskIndex).toBeGreaterThanOrEqual(0);
          const runSuffix = `it-${createUuidv7Generator()().slice(-8)}`;
          const { result, appOutcome } = await driveCrownRow({
            ctx,
            world,
            address,
            row,
            taskIndex,
            runSuffix,
            driven,
            facts,
          });

          // ---- the honest outcome contracts ----
          if (result.terminal !== row.expected.terminal) {
            for (const criterion of result.criteria) {
              if (criterion.status === "FAIL") {
                console.info(
                  `[VAL-049][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
                );
              }
            }
          }
          expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
          expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
          expect(validateHarnessEvidence(appOutcome.evidence)).toEqual([]);
          const failedApp = appOutcome.auditCriteria.filter(
            (criterion) => criterion.status === "FAIL",
          );
          expect(failedApp, `${row.rowId} app: ${JSON.stringify(failedApp)}`).toEqual([]);
          expect(appOutcome.observedTerminal).toBe(row.expected.terminal);

          if (row.expected.terminal === "COMPLETED") {
            // The honest audit row: every mechanical criterion green — the
            // replays, the boundaries, the bounds floor and the gaming
            // detections alike (the honest audit verdict IS the verified
            // outcome; the honest FAILED probes are evidence too).
            const failedCriteria = result.criteria.filter(
              (criterion) => criterion.status === "FAIL",
            );
            expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
            expect(result.failure).toBeNull();
            expect(result.notRun).toBe(false);
            expect(result.auditVerdict.verdict, row.rowId).toBe(row.expected.verdict);
            expect(result.auditVerdict.mechanism ?? "none", row.rowId).toBe(
              row.expected.mechanism ?? "none",
            );
            expect(result.auditVerdict.reason ?? "none", row.rowId).toBe(
              row.expected.reason ?? "none",
            );
            // The re-derivation EXECUTED over the REAL ledger (never a
            // rubber stamp) and the replays agree digest-for-digest with
            // the seeded recorded basis.
            expect(result.replays, row.rowId).toHaveLength(row.evidence.length);
            for (const [index, reference] of row.evidence.entries()) {
              const replay = result.replays[index];
              expect(replay?.resolvable, `${row.rowId}/${reference.corpusRowId}`).toBe(true);
              if (replay?.liveSlice === true) {
                continue;
              }
              expect(replay?.recomputedDigest, `${row.rowId}/${reference.corpusRowId}`).toBe(
                reference.recordedDigest,
              );
            }
          } else {
            // The honest audit-probe failure: the row's NAMED criterion
            // FAILs, the observed terminal read-back agrees (never a
            // fabricated pass) — the refused audit IS the verified outcome.
            const named = probeNamedCriterion[row.rowId];
            expect(named, `${row.rowId} named criterion`).toBeDefined();
            const criterion = result.criteria.find((c) => c.criterionId === named);
            expect(criterion?.status, `${row.rowId} ${named}`).toBe("FAIL");
            expect(result.observedTerminal).toBe("FAILED");
            expect(
              result.criteria.find((c) => c.criterionId === "observed-terminal-readback")?.status,
            ).toBe("PASS");
          }

          // ---- the verdict is the mechanically derived one ----
          const verdict = result.criteria.find((c) => c.criterionId === "audit-outcome-oracle");
          expect(verdict?.status).toBe("PASS");
          expect(verdict?.evidence.join(" ")).toContain(`expectedVerdict:${row.expected.verdict}`);

          // ---- the journal sequences are GAPLESS over the REAL SQL ----
          if (result.executionId !== null) {
            const events = await ctx.port.execute<{ sequence: number }>({
              sql: `SELECT sequence FROM executions.execution_events
                  WHERE execution_id = $1 ORDER BY sequence ASC`,
              parameters: [result.executionId],
            });
            const sequences = events.rows.map((eventRow) => eventRow.sequence);
            const gapless = sequences.every((sequence, index) => sequence === index + 1);
            expect(gapless, `${row.rowId} sequences: ${sequences.join(",")}`).toBe(true);
          }

          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            verdict: row.expected.verdict,
            mechanism: row.expected.mechanism ?? "none",
            arm: row.arm,
            replays: result.replays.length,
            criteriaPassed: result.criteria.filter((criterion) => criterion.status === "PASS")
              .length,
            criteriaFailed: result.criteria.filter((criterion) => criterion.status === "FAIL")
              .length,
            appPassed: appOutcome.passed,
            // Offline rows derive over the RECORDED corpora — nothing
            // freshly measured offline (the live rail below owns the
            // measured lane); the audit record seals honest zero-cost
            // measured facts.
            usage: "recorded-evidence-replay",
            latencyMs: result.totalLatencyMs,
            inputDigests: row.evidence.map((reference) => reference.recordedDigest),
          });
          console.info(
            `[VAL-049]   ${row.rowId} -> ${result.terminal} (${row.arm}/${row.expected.verdict}) ` +
              `replays=${result.replays.length} ` +
              `criteria=${runFacts[runFacts.length - 1]?.criteriaPassed}PASS/` +
              `${runFacts[runFacts.length - 1]?.criteriaFailed}FAIL ` +
              `latency=${result.totalLatencyMs}ms appPassed=${String(appOutcome.passed)}`,
          );
        }

        // ---- trajectory determinism: a headline re-drive reproduces its audit EXACTLY ----
        const headline = OFFLINE_CORPUS_ROWS.find(
          (candidate) => candidate.rowId === "replay-cross-workload-verdicts",
        );
        if (headline === undefined) {
          throw new Error("the headline replay row is missing");
        }
        const headlineIndex = AUDIT_CORPUS.findIndex(
          (candidate) => candidate.rowId === headline.rowId,
        );
        const first = runFacts.find((fact) => fact.rowId === headline.rowId);
        const firstDrive = await driveCrownRow({
          ctx,
          world,
          address,
          row: headline,
          taskIndex: headlineIndex,
          runSuffix: `determ-${createUuidv7Generator()().slice(-8)}`,
          driven,
          facts,
        });
        // A second, FRESH re-drive over the same row (the SHARED driven set
        // so each re-drive lands its OWN new execution).
        const secondDrive = await driveCrownRow({
          ctx,
          world,
          address,
          row: headline,
          taskIndex: headlineIndex,
          runSuffix: `determ2-${createUuidv7Generator()().slice(-8)}`,
          driven,
          facts,
        });
        expect(secondDrive.result.terminal).toBe(firstDrive.result.terminal);
        expect(secondDrive.result.auditVerdict).toEqual(firstDrive.result.auditVerdict);
        // The replays reproduce digest-for-digest + verdict-for-verdict.
        expect(
          secondDrive.result.replays.map((replay) => [
            replay.recomputedDigest,
            replay.replayedVerdict,
          ]),
        ).toEqual(
          firstDrive.result.replays.map((replay) => [
            replay.recomputedDigest,
            replay.replayedVerdict,
          ]),
        );
        // The criteria reproduce: the same criterionIds, the same statuses
        // and the same deterministic audit evidence EXACTLY (only the
        // ledger-count criteria may differ — their evidence embeds the
        // running ledger counts, never the audit trajectory).
        expect(secondDrive.result.criteria.map((criterion) => criterion.criterionId)).toEqual(
          firstDrive.result.criteria.map((criterion) => criterion.criterionId),
        );
        for (const [index, criterion] of secondDrive.result.criteria.entries()) {
          const original = firstDrive.result.criteria[index];
          expect(original?.status, criterion.criterionId).toBe(criterion.status);
          if (REPRODUCIBLE_CRITERIA.has(criterion.criterionId)) {
            expect(original?.evidence, criterion.criterionId).toEqual(criterion.evidence);
          }
        }
        // And the first crown drive matched the battery's own recorded
        // outcome for the headline row.
        expect(firstDrive.result.terminal).toBe(first?.terminal);
        console.info(
          `[VAL-049] trajectory determinism: replay-cross-workload-verdicts re-driven twice over ` +
            `FRESH submissions — identical replays (${secondDrive.result.replays.length} digest ` +
            `references), identical criteria statuses and identical deterministic audit evidence.`,
        );

        // ---- the battery-level ledger integrity (the whole corpus) ----
        const finalFacts = await facts();
        expect(finalFacts.orphanEventCount).toBe(0);
        // 28 offline rows + the two determinism re-drives.
        const expectedExecutions =
          OFFLINE_CORPUS_ROWS.reduce((sum, row) => sum + row.expected.executions, 0) + 2;
        expect(finalFacts.executionCount).toBe(expectedExecutions);
        const expectedKeys =
          OFFLINE_CORPUS_ROWS.reduce((sum, row) => sum + row.expected.idempotencyRecords, 0) + 2;
        expect(finalFacts.idempotencyRecordCount).toBe(expectedKeys);

        // ---- freeze integrity after the battery (FRESH SQL reads) ----
        const frozen = await verifyServedEvidenceBasis(ctx, world);
        expect(frozen).toBe(seeding.records);
        const postBattery = await seedRecordedEvidenceBasis(ctx, world);
        expect(postBattery.replayed).toBe(true);
        expect(postBattery.records).toBe(seeding.records);

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
        console.info(
          `[VAL-049] OFFLINE corpus summary: ${completed} COMPLETED + ${failed} honest FAILED of ` +
            `${runFacts.length} driven rows; ${seeding.records} recorded evidence references served ` +
            `READ-ONLY from REAL SQL (content digests as fingerprints; identical re-commit REPLAYS, ` +
            `different content THROWS); the ledger holds exactly ${finalFacts.executionCount} ` +
            `executions and ${finalFacts.idempotencyRecordCount} idempotency records (zero phantoms, ` +
            `zero drift, zero orphan events); every execution_events sequence gapless; every audit ` +
            `record sealed through the REAL recorder (offline replay rows with honest zero-cost ` +
            `measured facts); every honest row reproduced its pinned audit verdict ` +
            `(REPRODUCIBLE-VERIFIED / BOUNDS-HELD / GAMING-DETECTED with the mechanism NAMED / ` +
            `NOT-AUDITABLE with the reason NAMED) and every adversarial audit-probe row FAILED its ` +
            `NAMED criterion honestly; a headline re-drive reproduced its audit EXACTLY; the ` +
            `recorded basis stayed frozen after the whole battery; usage/latency honestly the ` +
            `recorded history's own offline (none freshly measured — the live rail owns that).`,
        );
        expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
        expect(completed).toBe(24);
        expect(failed).toBe(4);
      } finally {
        await world.server.app.close();
      }
    });

    test("the REAL live re-run rail drives one sampled re-run audit slice over the pinned OpenRouter rail", {
      timeout: 480_000,
    }, async () => {
      const notRun: string[] = [];
      // The env-gated live rows (offline rows first, live rows last in the
      // pinned corpus — exactly ONE live re-run row).
      const liveRows = AUDIT_CORPUS.filter((row) => row.needsDispatch);
      expect(liveRows).toHaveLength(1);
      for (const row of liveRows) {
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+") ?? "?"} absent); ` +
              `requirement: ${row.liveGate?.requirement ?? ""}`,
          );
        }
      }
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-049] OPENROUTER_API_KEY absent — the REAL live re-run audit slice is a NOT RUN " +
            "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
            "covers the complete audit machinery over the RECORDED evidence without credentials. " +
            "Required access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
            "covering the pinned chat model meta-llama/llama-3.3-70b-instruct on the pinned rail — " +
            "the REAL re-run slice demands sampled re-runs with REAL dispatches (BYOK, measured " +
            "usage, max_tokens 32 pinned explicitly, temperature unset per the provider's " +
            "documented default, every priced token at the pinned manifest revision rev-001), the " +
            "measured resolution rate checked against the RECORDED declared bounds (the recorded " +
            "live windows' Wilson intervals) and the audit record sealed through the REAL recorder " +
            "with honest economics (a measured rate landing outside its bounds FAILs named — the " +
            "measurement was noise, not signal; never fabricated). This live lane is reserved for " +
            "the operator/session-B live review (the offline audit above never re-measures; the " +
            "live row is the only place new measurements happen).",
        );
        // The honest-skip invariants: every live row's gate is closed, and
        // the pinned live plan's declaration digest stays deterministic.
        expect(notRun.length).toBe(liveRows.length);
        expect(liveAuditPlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
        expect(liveAuditPlanDigestOf()).toBe(liveAuditPlanDigestOf());
        expect(LIVE_AUDIT_PLAN.rounds).toBe(4);
        expect(LIVE_AUDIT_PLAN.rail.model).toBe("meta-llama/llama-3.3-70b-instruct");
        expect(LIVE_AUDIT_PLAN.rail.maxTokens).toBe(32);
        expect(true).toBe(true);
        return;
      }

      const world = await seedApiPgWorld(ctx.port);
      const facts = createWorldFacts(ctx, world);
      const generateId = createUuidv7Generator();

      /** Price ONE measured dispatch onto the canonical micro-USD basis. */
      const priceTokensAt = (tokens: number, tier: "input" | "output"): bigint => {
        const manifest = manifestRevisionOf(LIVE_AUDIT_PLAN.rail.priceRevision);
        const entry =
          manifest === null
            ? null
            : resolveListPrice(
                manifest,
                LIVE_AUDIT_PLAN.rail.provider,
                LIVE_AUDIT_PLAN.rail.model,
                tier,
              );
        if (entry === null) {
          throw new Error(
            `the pinned model manifest holds no ${tier} price for ${LIVE_AUDIT_PLAN.rail.model}`,
          );
        }
        const price = parseDecimal(entry.price);
        if (price === null) {
          throw new Error("the pinned list price failed to parse as a decimal");
        }
        return divRoundHalfUp(BigInt(tokens) * price.digits, 10n ** BigInt(price.scale));
      };

      try {
        const drivenLive: string[] = [];
        for (const row of liveRows) {
          if (!liveGateOpen(row, process.env)) {
            continue;
          }
          // Provider-side pacing between the live rows.
          await new Promise((resolve) => setTimeout(resolve, 2_000));

          // ---- the sampled re-run: REAL dispatches on the ONE pinned rail ----
          const rounds: {
            readonly resolved: boolean;
            readonly measuredCostMicroUsd: string;
          }[] = [];
          for (let round = 0; round < LIVE_AUDIT_PLAN.rounds; round += 1) {
            const response = await fetch(LIVE_AUDIT_PLAN.rail.endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${OPENROUTER_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: LIVE_AUDIT_PLAN.rail.model,
                max_tokens: LIVE_AUDIT_PLAN.rail.maxTokens,
                messages: [
                  {
                    role: "user",
                    content: `Reply with the single word: ok (round ${round + 1})`,
                  },
                ],
              }),
            });
            // The provider envelope's usage tokens WIN over raw HTTP
            // observations; the empty-completion 200 is an honest
            // non-error (VAL-014 rule) — priced, counted as a run,
            // resolved only when content actually landed.
            const payload = (await response.json()) as {
              readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
              readonly usage?: {
                readonly prompt_tokens?: number;
                readonly completion_tokens?: number;
              };
            };
            const content = payload.choices?.[0]?.message?.content ?? "";
            const inputTokens = payload.usage?.prompt_tokens ?? 0;
            const outputTokens = payload.usage?.completion_tokens ?? 0;
            const cost =
              priceTokensAt(inputTokens, "input") + priceTokensAt(outputTokens, "output");
            rounds.push({
              resolved: response.ok && content.length > 0,
              measuredCostMicroUsd: response.ok ? cost.toString() : "0",
            });
          }
          const resolvedCount = rounds.filter((round) => round.resolved).length;
          const measuredRate = resolvedCount / rounds.length;
          const measuredTotal = rounds.reduce(
            (total, round) => total + BigInt(round.measuredCostMicroUsd),
            0n,
          );

          // ---- the measured bounds declaration over the RECORDED basis ----
          // The re-run's measured resolution rate checked against the
          // RECORDED declared bounds (the direct arm's recorded Wilson
          // interval — the recorded live window of record).
          const directReplay = replayRecordedEvidenceOf(DIRECT_BOUNDS_REFERENCE);
          if (!directReplay.resolvable || directReplay.liveSlice) {
            throw new Error("the recorded direct-arm bounds basis failed to re-derive");
          }
          const directReference: AuditedEvidenceReference = {
            ...DIRECT_BOUNDS_REFERENCE,
            recordedDigest: directReplay.recomputedDigest,
            recordedVerdict: directReplay.replayedVerdict,
          };
          const measuredRow: AuditCorpusRow = {
            ...row,
            evidence: [directReference],
            boundsDeclaration: {
              armKind: "direct",
              corpusRowId: DIRECT_BOUNDS_REFERENCE.corpusRowId,
              measuredRate,
            },
            expected: {
              ...row.expected,
              groundedOn: auditEvidenceDigestOf([directReference]),
            },
          };

          const lifecycle = createLifecycleBinding(world, world.executions);
          const baseline = await facts();
          const executionId = await world.seedExecution(`val-049-live-${generateId()}`);
          const result = await driveAuditRow({
            row: measuredRow,
            lifecycle,
            probes: gamingProbesFor(measuredRow),
            rails: createRealAccountingRails(),
            metadata: {
              program: "zeck-validation",
              workOrder: "VAL-049",
              baseRevision: REVISION,
              applicationRevision: REVISION,
              corpusRevision: AUDIT_CORPUS_VERSION,
              integrationSurface: "audit:live-measured-slice",
              environment: {
                runtime: `node ${process.version}`,
                toolchain: "vitest",
                database: "postgresql",
                configuration: { suite: "val-049-reproducibility-audit", row: row.rowId },
              },
              observedAt: new Date().toISOString(),
            },
            environmentIdentity: `val-049-live-${row.rowId}`,
            baseline,
            worldFacts: facts,
            landedProvider: async () => [executionId],
            now: () => new Date(),
            env: process.env,
          });

          // The live lane's honesty invariants: the ledger's own terminal
          // agrees with the mechanically derived verdict (whatever the
          // measured facts derive — never a fabricated pass), the
          // bounds-held criterion names the measured rate AND the recorded
          // bounds, and the re-derivation executed over the recorded basis.
          expect(result.observedTerminal).toBe(result.terminal);
          expect(result.notRun).toBe(false);
          expect(
            result.criteria.find((c) => c.criterionId === "observed-terminal-readback")?.status,
          ).toBe("PASS");
          const bounds = result.criteria.find((c) => c.criterionId === "bounds-held");
          const boundsEvidence = bounds?.evidence.join(" ") ?? "";
          expect(boundsEvidence).toContain(`measuredRate:${measuredRate.toFixed(6)}`);
          expect(boundsEvidence).toContain("recordedBounds:[");
          expect(measuredTotal).toBeGreaterThanOrEqual(0n);
          drivenLive.push(
            `${row.rowId} -> ${result.terminal} measuredRate=${measuredRate.toFixed(6)} ` +
              `measured=${measuredTotal.toString()}µ$ bounds=${bounds?.status ?? "none"}`,
          );
          console.info(`[VAL-049]   LIVE ${row.rowId} -> ${result.terminal} ${drivenLive.at(-1)}`);
        }

        console.info(
          `[VAL-049] LIVE rail summary: ${drivenLive.length} REAL re-run audit slice(s) driven over ` +
            `the pinned OpenRouter rail (sampled re-runs with REAL dispatches, measured usage priced ` +
            `at the pinned manifest revision, the measured resolution rate checked against the ` +
            `RECORDED declared bounds through the bounds-held oracle, the audit record sealed ` +
            `through the REAL recorder with honest economics — the mechanically derived verdict ` +
            `stands on whatever the measured slice derives, never fabricated).`,
        );
        for (const boundary of notRun) {
          console.warn(`[VAL-049] NOT RUN boundary: ${boundary}`);
        }
        // At least one REAL live re-run happened (never an all-NOT-RUN
        // silent pass once a credential is present).
        expect(drivenLive.length).toBeGreaterThan(0);
      } finally {
        await world.server.app.close();
      }
    });
  },
);
