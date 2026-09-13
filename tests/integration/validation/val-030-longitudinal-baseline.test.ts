/**
 * VAL-030 acceptance criteria 3, 4, 5, 7 — the crown proof: the frozen
 * baseline corpus drives its CONTROL RUNS end to end over the REAL
 * platform path (the baseline freeze the longitudinal learning wave
 * will be measured AGAINST).
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port — the
 *     customer application (runLongitudinalApp) rides the public SDK
 *     boundary: the control-run submission, the completion poll, the
 *     result read (the route's modelCalls — the control run's OWN
 *     dispatch demand visible at the customer boundary) and the events
 *     read, with the re-run row re-issuing the SAME submission key with
 *     the IDENTICAL body through the REAL idempotency ledger (a second
 *     identity is a re-arbitration and FAILs);
 *   - the REAL execution lifecycle: the canonical transitions
 *     (authorize → plan → the durable planning decision → queue →
 *     start → the control chain → verify → pass/fail), the terminal
 *     derived MECHANICALLY (anyFail→FAILED) and the verification
 *     criteria recorded durably with the terminal transition — an
 *     honest FAILED row (the guard-rejected baseline) surfaces its
 *     honest FAIL criterion visibly;
 *   - the REAL recorder path: every trajectory step of the control run
 *     (dispatch rounds, effects in the declared equivalent ordering,
 *     the verification boundary) is journaled through the REAL
 *     executions recordStepEvent seam (the same append-only, gapless,
 *     provenance-bound ledger the lifecycle itself uses) — and the
 *     crown mechanically verifies over REAL SQL that the journal holds
 *     EXACTLY the canonical control trajectory: the projected
 *     trajectory digest IS the recorded digest and a MEMBER of the
 *     corpus-pinned equivalence class. The control re-run re-drives
 *     the SAME frozen workload and its identical steps REPLAY the
 *     committed step events (the REAL idempotency arbitration) — the
 *     journal gains ZERO new events (the recorded baseline is
 *     immutable once recorded);
 *   - the REAL longitudinal ledger: every control run's exactly-once
 *     identity observation rides the REAL SQL unique-index arbitration
 *     over platform.idempotency_records (the run key as the
 *     idempotency key, the identity content digest as the request
 *     fingerprint): ONE immutable identity per control run — the first
 *     observation RECORDS the derived stable form, the re-run's
 *     same-content re-observation REPLAYS it, a different-content
 *     re-observation would be REFUSED (the identity's content is
 *     immutable);
 *   - the REAL frozen-baseline registry: the append-only commits (the
 *     superseded RAG revision 1 + every corpus pin, digests over the
 *     pinned artifacts — never the artifacts copied) ride the same
 *     REAL SQL arbitration; the freeze-integrity derivation reads the
 *     committed entries back from the REAL durable rows (a read-through
 *     view — a correction is a NEW revision, never an edit).
 *
 * The lab-contract seams (the platform slice's own design): the
 * competence-system gate binding returns FRESH rounds and never
 * shortcircuits the verification boundary (learning explicitly INERT —
 * the control arm; the discrimination suite drives the contaminated
 * variants), and the live row's REAL model dispatch rides the REAL
 * model gateway (env-gated, BYOK, measured — never fabricated).
 *
 * Boundary recorded honestly: the app-side trajectory-digest criteria
 * (the raw public-events digest re-derivation) are exercised over the
 * controlled fake world in the unit suite — over the REAL journal the
 * platform's own lifecycle envelopes (creation, transitions, the
 * planning decision) are legitimately part of the public stream, so
 * the crown verifies the trajectory-class reproduction through the
 * REAL recorder path (the SQL projection) instead, mechanically per
 * row.
 *
 * The live rail row (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drives ONE REAL model confirmation round through
 * the REAL platform model gateway. Absent credentials are a recorded
 * NOT RUN boundary — never a fake success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runLongitudinalApp } from "../../../benchmarks/validation/apps/longitudinal-baseline/application";
import {
  controlSubmissionKey,
  controlTaskBodyFor,
  liveGateOpen,
  LONGITUDINAL_CORPUS,
  LONGITUDINAL_TASK_KIND,
} from "../../../benchmarks/validation/apps/longitudinal-baseline/corpus";
import { SUPERSEDED_RAG_MANIFEST } from "../../../benchmarks/validation/apps/longitudinal-baseline/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import {
  type BaselineManifestEntry,
  type BaselineRegistryEntry,
  controlIdentityIdOf,
  controlRunKeyOf,
  controlTrajectoryStepsOf,
  type ControlDispatch,
  type ControlLearningPort,
  type ControlRecorderPort,
  deriveWorkloadAdmission,
  driveControlRun,
  type FrozenBaselineRegistryPort,
  type LongitudinalCorpusRow,
  type LongitudinalLedgerPort,
  type TrajectoryStepKind,
  type TrajectoryStepRecord,
  trajectoryDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createScopeResolver } from "../../../src/modules/auth/public";
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
const MODEL = process.env.ZECK_VAL_030_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-030|longitudinal-baseline|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** The REAL SQL operations the crown's durable bindings ride. */
const REGISTRY_OPERATION = "val-030.baseline-registry";
const LEDGER_OPERATION = "val-030.longitudinal-ledger";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly trajectoryDigest: string;
  readonly rerunDigest: string;
  readonly identityId: string;
  readonly journalSteps: number;
  readonly latencyMs: number;
  readonly appSubmissions: string;
  readonly appTerminal: string;
  readonly appModelCalls: number;
  readonly usage: string;
  readonly keyDigest: string;
  readonly bodyDigest: string;
  readonly manifestDigest: string;
}

/** The app's own outcome (the settled app promise's payload). */
interface AppOutcome {
  readonly ok: true;
  readonly outcome: Awaited<ReturnType<typeof runLongitudinalApp>>;
}

// ---------------------------------------------------------------------------
// The REAL durable bindings (the platform slice's lifecycle ports)
// ---------------------------------------------------------------------------

/**
 * The REAL frozen-baseline registry: the append-only commits ride the
 * REAL SQL unique-index arbitration (the platform's own idempotency
 * discipline — the pin as the idempotency key, the manifest digest as
 * the request fingerprint), then the freeze derivation reads the
 * committed entries back from the REAL durable rows (a read-through
 * view: entryFor/historyOf serve the durable state, never fabricated
 * content; commit is the seed-time arbitration only).
 */
async function seedRealBaselineRegistry(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<FrozenBaselineRegistryPort> {
  const generateId = createUuidv7Generator();
  const pinOf = (manifest: BaselineManifestEntry): string =>
    `${manifest.appId}|${manifest.workloadId}|r${manifest.workloadRevision}`;

  const commitOne = async (manifest: BaselineManifestEntry, committedAt: string): Promise<void> => {
    await ctx.port.transaction(async (tx) => {
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
          REGISTRY_OPERATION,
          pinOf(manifest),
          manifest.manifestDigest,
          JSON.stringify({ workloadRevision: manifest.workloadRevision, manifest, committedAt }),
        ],
      });
      if (inserted.rows.length > 0) {
        return;
      }
      const existing = await tx.execute<{ request_fingerprint: string }>({
        sql: `SELECT request_fingerprint FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
        parameters: [world.applicationId, REGISTRY_OPERATION, pinOf(manifest)],
      });
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error(`the registry arbitration lost the pin ${pinOf(manifest)}`);
      }
      if (row.request_fingerprint !== manifest.manifestDigest) {
        throw new Error(
          `append-only violation: the pin ${pinOf(manifest)} is already committed with different ` +
            "content — a correction must be a NEW workload revision, never an edit",
        );
      }
      // The identical re-commit replays the committed entry (idempotent).
    });
  };

  // The correction history FIRST (the superseded RAG revision 1), then
  // every corpus pin in corpus order — the deterministic default
  // registry shape, durably committed over REAL SQL.
  await commitOne(SUPERSEDED_RAG_MANIFEST, "2025-01-01T00:00:00.000Z");
  for (const [index, row] of LONGITUDINAL_CORPUS.entries()) {
    await commitOne(row.manifest, `2025-01-01T00:${String(index + 1).padStart(2, "0")}:00.000Z`);
  }

  // The read-through view over the REAL durable rows.
  const readBack = await ctx.port.execute<{
    idempotency_key: string;
    request_fingerprint: string;
    durable_outcome: {
      manifest?: unknown;
      committedAt?: unknown;
    };
    created_at: Date;
  }>({
    sql: `SELECT idempotency_key, request_fingerprint, durable_outcome, created_at
          FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
          ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, REGISTRY_OPERATION],
  });
  const entries: BaselineRegistryEntry[] = readBack.rows.flatMap((row) => {
    const manifest = row.durable_outcome?.manifest as BaselineManifestEntry | undefined;
    if (manifest === undefined) {
      return [];
    }
    const committedAt =
      typeof row.durable_outcome?.committedAt === "string"
        ? row.durable_outcome.committedAt
        : row.created_at.toISOString();
    return [{ workloadRevision: manifest.workloadRevision, manifest, committedAt }];
  });
  return {
    // The durable commits are the seed-time arbitration above; the
    // derivation only ever READS the committed state on this path.
    commit() {
      throw new Error(
        "the crown's registry is read-through over the REAL durable commits " +
          "(append through the REAL SQL arbitration at seed time only)",
      );
    },
    entryFor(pin) {
      return (
        entries.find(
          (entry) =>
            entry.manifest.appId === pin.appId &&
            entry.manifest.workloadId === pin.workloadId &&
            entry.workloadRevision === pin.workloadRevision,
        ) ?? null
      );
    },
    historyOf(appId, workloadId) {
      return entries
        .filter(
          (entry) => entry.manifest.appId === appId && entry.manifest.workloadId === workloadId,
        )
        .sort((a, b) => a.workloadRevision - b.workloadRevision);
    },
  };
}

/**
 * The REAL longitudinal ledger: the exactly-once identity observation
 * per control run rides the REAL SQL unique-index arbitration (the run
 * key as the idempotency key, the identity content digest as the
 * request fingerprint). The first observation RECORDS the derived
 * stable identity form; a same-content re-observation REPLAYS it
 * (never a second identity); a different-content re-observation is
 * REFUSED (the identity's content is immutable). The facts view is the
 * read-back of the REAL durable rows after every observation.
 */
function createRealLongitudinalLedger(ctx: PgContext, world: ApiPgWorld): LongitudinalLedgerPort {
  const generateId = createUuidv7Generator();
  let identities: readonly {
    readonly identityId: string;
    readonly runKey: string;
    readonly contentDigest: string;
  }[] = [];

  const readBack = async (): Promise<void> => {
    const rows = await ctx.port.execute<{
      idempotency_key: string;
      request_fingerprint: string;
      durable_outcome: { identityId?: unknown };
    }>({
      sql: `SELECT idempotency_key, request_fingerprint, durable_outcome
            FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
            ORDER BY created_at ASC, id ASC`,
      parameters: [world.applicationId, LEDGER_OPERATION],
    });
    identities = rows.rows.map((row) => ({
      runKey: row.idempotency_key,
      contentDigest: row.request_fingerprint,
      identityId:
        typeof row.durable_outcome?.identityId === "string" ? row.durable_outcome.identityId : "",
    }));
  };

  return {
    async observeControlRun({ runKey, contentDigest }) {
      const observation = await ctx.port.transaction(async (tx: Transaction) => {
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
            LEDGER_OPERATION,
            runKey,
            contentDigest,
            JSON.stringify({ identityId: controlIdentityIdOf(runKey) }),
          ],
        });
        if (inserted.rows.length > 0) {
          // The first observation RECORDS the derived stable identity.
          return {
            contentDigest,
            identityId: controlIdentityIdOf(runKey),
            replayed: false,
            refused: false,
          };
        }
        const existing = await tx.execute<{
          request_fingerprint: string;
          durable_outcome: { identityId?: unknown };
        }>({
          sql: `SELECT request_fingerprint, durable_outcome FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
          parameters: [world.applicationId, LEDGER_OPERATION, runKey],
        });
        const row = existing.rows[0];
        if (row === undefined) {
          throw new Error(`the longitudinal ledger arbitration lost the run key ${runKey}`);
        }
        const identityId =
          typeof row.durable_outcome?.identityId === "string" ? row.durable_outcome.identityId : null;
        if (row.request_fingerprint === contentDigest) {
          // The re-run re-observed the SAME identity (same content).
          return { contentDigest, identityId, replayed: true, refused: false };
        }
        // The identity's content is IMMUTABLE — the honest refusal.
        return { contentDigest, identityId, replayed: false, refused: true };
      });
      await readBack();
      return observation;
    },
    facts() {
      return { identities: [...identities] };
    },
  };
}

/**
 * The REAL recorder-path binding: the sync capture port buffers the
 * trajectory steps per capture (the port contract is synchronous); the
 * crown flushes them through the REAL executions recordStepEvent seam
 * while the execution is RUNNING (before the verify boundary). Each
 * step's call key is `${kind}-${ordinal}` — the control re-run's
 * IDENTICAL steps replay the committed step events through the REAL
 * idempotency arbitration (the journal gains ZERO new events: the
 * recorded baseline is immutable once recorded).
 */
interface RealControlRecorder extends ControlRecorderPort {
  /** The buffered captures per execution, in capture order. */
  readonly buffers: ReadonlyMap<string, readonly TrajectoryStepRecord[][]>;
}

function createRealControlRecorder(): RealControlRecorder {
  const captures = new Map<string, TrajectoryStepRecord[][]>();
  const baseline = new Map<string, TrajectoryStepRecord[]>();
  return {
    beginCapture(executionId) {
      captures.set(executionId, [...(captures.get(executionId) ?? []), []]);
    },
    capture(executionId, step) {
      let list = captures.get(executionId);
      if (list === undefined) {
        list = [[]];
        captures.set(executionId, list);
      }
      let current = list[list.length - 1];
      if (current === undefined) {
        current = [];
        list.push(current);
      }
      current.push(step);
      if (!baseline.has(executionId)) {
        baseline.set(executionId, current);
      }
    },
    latestCapture(executionId) {
      const list = captures.get(executionId);
      const steps = list?.[list.length - 1] ?? [];
      if (steps.length === 0) {
        return null;
      }
      return { steps: [...steps], declaredDigest: trajectoryDigestOf(steps) };
    },
    baselineCapture(executionId) {
      const steps = baseline.get(executionId);
      if (steps === undefined || steps.length === 0) {
        return null;
      }
      return { steps: [...steps], declaredDigest: trajectoryDigestOf(steps) };
    },
    get buffers() {
      return captures;
    },
  };
}

/** Flush the buffered trajectory steps through the REAL recorder path. */
async function flushControlRecorder(world: ApiPgWorld, recorder: RealControlRecorder): Promise<void> {
  for (const [executionId, captures] of recorder.buffers) {
    for (const steps of captures) {
      for (const step of steps) {
        await world.executions.recordStepEvent(
          {
            applicationId: world.applicationId,
            executionId,
            actor: { actorId: world.actorId, tenantId: world.tenantId },
            command: "agent-action-recorded",
            cause: `val-030-${step.kind}-${step.ordinal}`,
            reference: {
              kind: step.kind,
              ordinal: step.ordinal,
              detail: step.detail,
              digest: step.digest,
            },
            payload: { kind: step.kind, detail: step.detail, ordinal: step.ordinal },
          },
          // The call key is distinct per (kind, ordinal): the original
          // capture appends, the re-run's IDENTICAL steps replay (the
          // REAL idempotency arbitration — zero new journal events).
          `val-030-${executionId}-${step.kind}-${step.ordinal}`,
        );
      }
    }
  }
}

/**
 * The inert-learning gate binding (the lab-contract seam): every
 * dispatch round is FRESH and the verification boundary is never
 * shortcircuited — learning explicitly INERT over the REAL platform
 * path (the reference arm; the discrimination suite drives the
 * contaminated variants over the fixture gate).
 */
const INERT_LEARNING: ControlLearningPort = {
  async gateRound() {
    return { mode: "fresh" };
  },
  verificationShortcut() {
    return false;
  },
};

/** Parse one REAL journal step kind (the trajectory vocabulary — honest on unknowns). */
function trajectoryStepKindOf(kind: string): TrajectoryStepKind {
  if (kind === "dispatch" || kind === "effect" || kind === "verification") {
    return kind;
  }
  throw new Error(`the REAL journal holds an unknown trajectory step kind: ${kind}`);
}

// ---------------------------------------------------------------------------
// The REAL lifecycle driving (the canonical transitions around the chain)
// ---------------------------------------------------------------------------

/** The canonical prologue: authorize → plan → the planning decision → queue → start. */
async function driveLifecycleToRunning(
  world: ApiPgWorld,
  executionId: string,
  row: LongitudinalCorpusRow,
  generateId: () => string,
): Promise<void> {
  const transitionCounter = { count: 0 };
  const transition = async (command: "authorize" | "plan" | "queue" | "start"): Promise<void> => {
    transitionCounter.count += 1;
    await world.executions.transition(
      {
        actorId: world.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        command,
        reason: `val-030-${command}`,
      },
      `val-030-${executionId}-${command}-${transitionCounter.count}`,
    );
  };
  await transition("authorize");
  await transition("plan");
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
            strategyId: "val-030-control",
            plan: {
              strategyClass: "longitudinal-baseline",
              // The control run's OWN dispatch demand — the route read
              // surfaces it at the customer boundary.
              modelCalls: row.expectedModelCalls,
              steps: [
                {
                  routeRef: {
                    provider: row.needsDispatch ? "openrouter" : "deterministic-fixture",
                    model: row.needsDispatch ? MODEL : "none",
                  },
                },
              ],
            },
          },
        ],
        selectedStrategyId: "val-030-control",
      },
    },
    `val-030-${executionId}-decision`,
  );
  await transition("queue");
  await transition("start");
}

/**
 * The verification boundary + the terminal: the mechanically derived
 * verdict (anyFail→FAILED), the row criteria recorded durably with the
 * terminal transition, and the honest guard-admission criterion (an
 * honest FAILED row surfaces its visible FAIL cause — the val-026
 * precedent, the anyFail→FAILED invariant at the customer boundary).
 */
async function completeControlRun(
  world: ApiPgWorld,
  executionId: string,
  row: LongitudinalCorpusRow,
  result: Awaited<ReturnType<typeof driveControlRun>>,
): Promise<void> {
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: "verify",
      reason: "val-030-verify",
    },
    `val-030-${executionId}-verify`,
  );
  const admission = deriveWorkloadAdmission(row.workload);
  const criteria = [
    // The honest guard admission: PASS when the budget guard admitted
    // the declared demand, the visible FAIL cause when it rejected.
    {
      criterionId: "guard-admission",
      strategy: "deterministic",
      status: admission.allowed ? ("PASS" as const) : ("FAIL" as const),
      evidence: [
        `quotaMicro:${row.workload.quotaMicro}`,
        `demandedMicro:${admission.demandedMicro}`,
        `guard:${admission.allowed ? "admitted" : "rejected"}`,
        ...(admission.reason === null ? [] : [admission.reason]),
      ],
    },
    ...result.criteria,
  ];
  const verdict = result.terminal === "COMPLETED" ? "pass" : "fail";
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: verdict,
      reason:
        verdict === "pass"
          ? "val-030-verified"
          : `val-030-${result.failure?.category ?? "criterion-fail"}`,
      verificationResults: criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        strategy: criterion.strategy,
        status: criterion.status,
        recordedBy: "val-030-platform",
        evidence: [...criterion.evidence],
      })),
    },
    `val-030-${executionId}-${verdict}`,
  );
}

// ---------------------------------------------------------------------------
// The landed-execution provider (the app's submission lands through the
// public wire; the crown polls the REAL SQL for the durable row)
// ---------------------------------------------------------------------------

async function awaitLandedExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  rowId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 4_800; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string }>({
      sql: `SELECT id FROM executions.executions
            WHERE application_id = $1
              AND task->>'kind' = $2
              AND task->>'rowId' = $3
              AND id != ALL($4::uuid[])
            ORDER BY created_at ASC, id ASC
            LIMIT 1`,
      parameters: [world.applicationId, LONGITUDINAL_TASK_KIND, rowId, [...driven]],
    });
    const landed = rows.rows[0];
    if (landed !== undefined) {
      driven.add(landed.id);
      return landed.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no landed control-run execution for row ${rowId} after 120s`);
}

// ---------------------------------------------------------------------------
// The live dispatch binding (the REAL model gateway — the live row's seam)
// ---------------------------------------------------------------------------

/** Build the REAL model-gateway dispatch round (the live row's seam). */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{ readonly dispatch: ControlDispatch }> {
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
  const registry = createRailRegistry([createOpenRouterAdapter({ transport: createFetchTransport() })]);
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
        return { satisfied: true, catalogRevision: "val-030", satisfactions: [] };
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
      label: "val-030-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-030-conn-${generateId().slice(-8)}`,
  );

  const dispatch: ControlDispatch = async ({ round, attempt }) => {
    const startedAt = Date.now();
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: MODEL,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are the control-run confirmation supervisor of a governed validation execution.",
            "You receive the frozen baseline workload's confirmation request and decide whether the",
            "control dispatch round completed. Answer with the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content:
            `Longitudinal baseline control round (golden:live-confirmation, round ${round}, ` +
            `attempt ${attempt}). Confirm the control dispatch.`,
        },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      const usage: LabUsage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.costUsd === null || response.usage.costUsd === undefined
          ? {}
          : { costUsd: response.usage.costUsd }),
      };
      if (!/confirm/i.test(response.content.join("\n"))) {
        return {
          kind: "failure",
          category: "supervisor-halt",
          message: `the confirmation supervisor did not confirm: ${response.content
            .join("\n")
            .slice(0, 120)}`,
          latencyMs,
        };
      }
      return { kind: "success", usage, latencyMs };
    }
    const failure = result.outcome.failure;
    return {
      kind: "failure",
      category: failure.category,
      message: failure.providerMessage ?? "provider failure (no provider message)",
      latencyMs,
    };
  };
  return { dispatch };
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one corpus row crown-style: the app rides the public wire
 * (submit → poll → result read → events read → (the re-run rows) the
 * key re-issue with the IDENTICAL body) while the crown waits for the
 * landed execution and drives the REAL lifecycle around the control
 * chain (the prologue transitions → the control run through the
 * platform driver with the REAL recorder/ledger/registry bindings →
 * the trajectory flush through the REAL recorder path → the
 * verification boundary + the mechanically derived terminal).
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: LongitudinalCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly registry: FrozenBaselineRegistryPort;
  readonly ledger: LongitudinalLedgerPort;
  readonly dispatch?: ControlDispatch;
  readonly driven: Set<string>;
}): Promise<{
  readonly executionId: string;
  readonly result: Awaited<ReturnType<typeof driveControlRun>>;
  readonly appSettled: AppOutcome;
  readonly appKey: string;
  readonly appBody: Readonly<Record<string, unknown>>;
}> {
  const { world, row, taskIndex } = options;
  const generateId = createUuidv7Generator();
  const appKey = controlSubmissionKey({ runSuffix: options.runSuffix, taskIndex });
  const appBody = controlTaskBodyFor({ rowId: row.rowId });

  // The app promise: the customer application over the REAL served
  // public wire (the app never touches platform internals).
  const appPromise: Promise<AppOutcome> = runLongitudinalApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      pollIntervalMs: 250,
      completionTimeoutMs: 120_000,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-030-longitudinal-baseline" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  }).then((outcome) => ({ ok: true as const, outcome }));

  // The landed execution (the app's submission through the public wire).
  const executionId = await awaitLandedExecution(
    options.ctx,
    world,
    options.driven,
    row.rowId,
  );

  // The canonical prologue (authorize → plan → the planning decision →
  // queue → start) — the control run drives over the REAL state machine.
  await driveLifecycleToRunning(world, executionId, row, generateId);

  // The control run through the platform driver with the REAL
  // recorder/ledger/registry bindings (the trajectory capture, the
  // exactly-once identity observations, the freeze-integrity verdict,
  // the re-run probe).
  const recorder = createRealControlRecorder();
  const result = await driveControlRun({
    row,
    executionId,
    registry: options.registry,
    ledger: options.ledger,
    recorder,
    learning: INERT_LEARNING,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry: {
      maxExtraAttempts: 2,
      backoffMs: 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
  });

  // The trajectory flush through the REAL recorder path (while the
  // execution is RUNNING — the re-run's identical steps replay).
  await flushControlRecorder(world, recorder);

  // The verification boundary + the mechanically derived terminal.
  await completeControlRun(world, executionId, row, result);

  const appSettled = await appPromise;
  return { executionId, result, appSettled, appKey, appBody };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite(
  "VAL-030 baseline freeze and pre-learning control runs over the real platform path",
  (ctx) => {
    test("the offline control corpus drives freeze/re-run/ledger/accounting semantics over the REAL platform path", {
      timeout: 300_000,
    }, async () => {
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];

      try {
        // The REAL durable frozen-baseline registry (the append-only
        // arbitration over REAL SQL: the superseded RAG r1 + every
        // corpus pin) and the REAL longitudinal ledger.
        const registry = await seedRealBaselineRegistry(ctx, world);
        const ledger = createRealLongitudinalLedger(ctx, world);

        for (const [taskIndex, row] of LONGITUDINAL_CORPUS.entries()) {
          if (row.liveGate !== undefined) {
            continue;
          }
          const generateId = createUuidv7Generator();
          const runSuffix = `it-${generateId().slice(-8)}`;
          const { executionId, result, appSettled, appKey, appBody } = await driveCrownRow({
            ctx,
            world,
            address,
            row,
            taskIndex,
            runSuffix,
            registry,
            ledger,
            driven,
          });

          // ---- the honest control-run contracts (the platform side) ----
          if (result.terminal !== row.expected.terminal) {
            console.info(
              `[VAL-030][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
            );
            for (const criterion of result.criteria) {
              if (criterion.status === "FAIL") {
                console.info(
                  `[VAL-030][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
                );
              }
            }
          }
          expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
          // Freeze integrity: the manifest digest agreement on every leg.
          expect(result.freeze.agreed, `${row.rowId} freeze`).toBe(true);
          // Inert learning: the control run made its OWN dispatches.
          expect(result.learning.inert, `${row.rowId} inert`).toBe(true);
          expect(result.observedModelCalls, `${row.rowId} own dispatches`).toBe(
            row.expectedModelCalls,
          );
          // Ledger exactly-once: ONE immutable identity in the stable form.
          expect(result.ledger.exactlyOnce, `${row.rowId} exactly once`).toBe(true);
          expect(result.ledger.identityStable, `${row.rowId} identity stable`).toBe(true);
          expect(result.ledger.reobservationReplayed, `${row.rowId} replayed re-observation`).toBe(
            true,
          );
          expect(result.identityId).toBe(
            controlIdentityIdOf(controlRunKeyOf({ executionId, manifest: row.manifest })),
          );
          // Accounting honesty: latency measured; usage honestly
          // none-reported offline (no model dispatched — never fabricated).
          expect(result.accounting.honest, `${row.rowId} accounting`).toBe(true);
          expect(result.usage, `${row.rowId} offline usage none-reported`).toBeNull();
          // The recorded trajectory digest is a MEMBER of the pinned class.
          expect(result.trajectoryDigest, `${row.rowId} trajectory digest`).not.toBeNull();
          expect(row.expectedTrajectoryClass).toContain(result.trajectoryDigest ?? "");

          // ---- the re-run probe (the rerun rows) ----
          if (row.rerun !== undefined) {
            expect(result.rerun?.reproduced, `${row.rowId} re-run equivalence`).toBe(true);
            expect(result.rerunTrajectoryDigest, `${row.rowId} re-run digest`).toBe(
              result.trajectoryDigest,
            );
          }

          // ---- trajectories recorded through the REAL recorder path ----
          // The REAL journal's trajectory step events project onto the
          // canonical control trajectory: the projected digest IS the
          // recorded digest (a pinned class member) and the ordinals
          // are 1..N (the re-run's identical steps REPLAYED — the
          // journal gained ZERO new events).
          const stepRows = await ctx.port.execute<{
            ordinal: number;
            kind: string;
            detail: string;
            digest: string;
          }>({
            sql: `SELECT (reference->>'ordinal')::int AS ordinal, reference->>'kind' AS kind,
                         reference->>'detail' AS detail, reference->>'digest' AS digest
                  FROM executions.execution_events
                  WHERE execution_id = $1 AND type = 'execution.agent-action-recorded'
                  ORDER BY sequence ASC`,
            parameters: [executionId],
          });
          const effectOrder = row.effectOrderings?.[0];
          const canonical = controlTrajectoryStepsOf({
            workload: row.workload,
            ...(effectOrder === undefined ? {} : { effectOrder }),
          });
          const projection: TrajectoryStepRecord[] = stepRows.rows.map((step) => ({
            ordinal: step.ordinal,
            kind: trajectoryStepKindOf(step.kind),
            detail: step.detail,
            digest: step.digest,
          }));
          expect(projection.length, `${row.rowId} REAL journal trajectory steps`).toBe(
            canonical.length,
          );
          expect(trajectoryDigestOf(projection), `${row.rowId} REAL journal digest`).toBe(
            result.trajectoryDigest,
          );
          expect(row.expectedTrajectoryClass).toContain(trajectoryDigestOf(projection));
          const ordinals = projection.map((step) => step.ordinal);
          expect(
            ordinals.every((ordinal, index) => ordinal === index + 1),
            `${row.rowId} trajectory ordinals: ${ordinals.join(",")}`,
          ).toBe(true);

          // ---- the longitudinal ledger over REAL SQL: exactly ONE ----
          const ledgerRow = await ctx.port.execute<{ c: number; identityId: string | null }>({
            sql: `SELECT count(*)::int AS c, min(durable_outcome->>'identityId') AS "identityId"
                  FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
            parameters: [
              world.applicationId,
              LEDGER_OPERATION,
              controlRunKeyOf({ executionId, manifest: row.manifest }),
            ],
          });
          expect(Number(ledgerRow.rows[0]?.c ?? 0), `${row.rowId} ONE ledger identity`).toBe(1);
          expect(ledgerRow.rows[0]?.identityId, `${row.rowId} ledger identity form`).toBe(
            result.identityId,
          );

          // ---- the app's honest observations over the public wire ----
          expect(validateHarnessEvidence(appSettled.outcome.evidence)).toEqual([]);
          expect(appSettled.outcome.submission?.rejection, `${row.rowId} app submission`).toBeNull();
          expect(appSettled.outcome.submission?.replayed, `${row.rowId} app created`).toBe(false);
          expect(appSettled.outcome.observedTerminal, `${row.rowId} app terminal`).toBe(
            row.expected.terminal,
          );
          expect(appSettled.outcome.observedModelCalls, `${row.rowId} app model calls`).toBe(
            row.expectedModelCalls,
          );
          // The anyFail→FAILED invariant visible at the customer
          // boundary over the REAL wire (an honest FAILED row surfaces
          // its visible FAIL criterion; a COMPLETED row is all-PASS).
          expect(
            appSettled.outcome.appCriteria.find(
              (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
            )?.status,
            `${row.rowId} app terminal-criteria agreement`,
          ).toBe("PASS");
          expect(
            appSettled.outcome.appCriteria.find(
              (criterion) => criterion.criterionId === "app-control-run-inert",
            )?.status,
            `${row.rowId} app control-run inert`,
          ).toBe("PASS");
          if (row.rerun !== undefined) {
            // The re-issue of the SAME key with the IDENTICAL body
            // replayed the committed receipt: identity preserved, ZERO
            // new executions (a second identity is a re-arbitration).
            expect(appSettled.outcome.replay?.replayed, `${row.rowId} app replay`).toBe(true);
            expect(appSettled.outcome.replay?.executionId).toBe(
              appSettled.outcome.submission?.executionId,
            );
            expect(appSettled.outcome.replay?.rejection).toBeNull();
          }

          // ---- the durable terminal + the journal gaplessness ----
          const durable = await world.executions.getExecution(world.applicationId, executionId);
          expect(durable?.status, `${row.rowId} durable terminal`).toBe(row.expected.terminal);
          const events = await ctx.port.execute<{ sequence: number }>({
            sql: `SELECT sequence FROM executions.execution_events
                  WHERE execution_id = $1 ORDER BY sequence ASC`,
            parameters: [executionId],
          });
          const sequences = events.rows.map((eventRow) => eventRow.sequence);
          expect(
            sequences.every((sequence, index) => sequence === index + 1),
            `${row.rowId} journal sequences: ${sequences.join(",")}`,
          ).toBe(true);

          // ---- the app key's ledger record: ONE create arbitration ----
          const keyRecords = await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND idempotency_key = $2
                    AND operation_name = 'executions.create'`,
            parameters: [world.applicationId, appKey],
          });
          expect(Number(keyRecords.rows[0]?.c ?? 0), `${row.rowId} app key records`).toBe(1);

          const submission = appSettled.outcome.submission;
          const replay = appSettled.outcome.replay;
          const created =
            submission !== null && submission.rejection === null && !submission.replayed ? 1 : 0;
          const replayedCount = replay?.replayed === true ? 1 : 0;
          const rejectedCount =
            (submission !== null && submission.rejection !== null ? 1 : 0) +
            (replay !== null && replay.rejection !== null ? 1 : 0);
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            trajectoryDigest: result.trajectoryDigest ?? "none",
            rerunDigest: result.rerunTrajectoryDigest ?? "none",
            identityId: result.identityId ?? "none",
            journalSteps: projection.length,
            latencyMs: result.totalLatencyMs,
            appSubmissions: `${created}c+${replayedCount}r+${rejectedCount}x`,
            appTerminal: appSettled.outcome.observedTerminal ?? "none",
            appModelCalls: appSettled.outcome.observedModelCalls ?? -1,
            usage: "none-reported",
            // Payload DIGESTS only (never the key/body bytes).
            keyDigest: createHash("sha256").update(appKey, "utf8").digest("hex").slice(0, 16),
            bodyDigest: createHash("sha256")
              .update(JSON.stringify(appBody), "utf8")
              .digest("hex")
              .slice(0, 16),
            manifestDigest: row.manifest.manifestDigest,
          });
          console.info(
            `[VAL-030]   ${row.rowId} -> ${result.terminal} traj=${result.trajectoryDigest} ` +
              `rerun=${result.rerunTrajectoryDigest ?? "none"} identity=${result.identityId} ` +
              `steps=${projection.length} latency=${result.totalLatencyMs}ms ` +
              `app=${runFacts[runFacts.length - 1]?.appSubmissions}/${runFacts[runFacts.length - 1]?.appTerminal} ` +
              `modelCalls=${runFacts[runFacts.length - 1]?.appModelCalls} ` +
              `usage=${runFacts[runFacts.length - 1]?.usage} manifest=${row.manifest.manifestDigest} ` +
              `keyDigest=${runFacts[runFacts.length - 1]?.keyDigest} ` +
              `bodyDigest=${runFacts[runFacts.length - 1]?.bodyDigest}`,
          );
        }

        // ---- the battery-level integrity (the whole offline corpus) ----
        const drivenRows = runFacts.length;
        const expectedRows = LONGITUDINAL_CORPUS.filter((row) => row.liveGate === undefined).length;
        expect(drivenRows).toBe(expectedRows);

        // No phantom executions: exactly ONE durable execution per
        // driven row (the re-run re-observed, never re-created).
        const execCount = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
          parameters: [world.applicationId],
        });
        expect(Number(execCount.rows[0]?.c ?? 0), "no phantom executions").toBe(drivenRows);

        // The idempotency ledger: exactly ONE create arbitration per
        // submission key (no ledger drift).
        const keyCount = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = 'executions.create'`,
          parameters: [world.applicationId],
        });
        expect(Number(keyCount.rows[0]?.c ?? 0), "no ledger drift").toBe(drivenRows);

        // Zero orphan events.
        const orphans = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.execution_events e
                LEFT JOIN executions.executions x ON e.execution_id = x.id
                WHERE e.application_id = $1 AND x.id IS NULL`,
          parameters: [world.applicationId],
        });
        expect(Number(orphans.rows[0]?.c ?? 0), "zero orphan events").toBe(0);

        // The longitudinal ledger holds exactly ONE immutable identity
        // per control run (the re-run re-observed the SAME identity).
        const ledgerCount = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = $2`,
          parameters: [world.applicationId, LEDGER_OPERATION],
        });
        expect(Number(ledgerCount.rows[0]?.c ?? 0), "one identity per control run").toBe(drivenRows);

        // The append-only registry history over REAL SQL: the superseded
        // RAG revision 1 stays intact and verifiable after the
        // correction (the r1→r2 correction discipline as durable fact).
        const ragHistory = registry.historyOf("portfolio:rag", "golden:rag-retrieval");
        expect(
          ragHistory.map((entry) => entry.workloadRevision),
          "the append-only RAG correction history",
        ).toEqual([1, 2]);
        for (const row of LONGITUDINAL_CORPUS) {
          if (row.liveGate !== undefined) {
            continue;
          }
          const entry = registry.entryFor({
            appId: row.manifest.appId,
            workloadId: row.manifest.workloadId,
            workloadRevision: row.manifest.workloadRevision,
          });
          expect(entry?.manifest.manifestDigest, `${row.rowId} registry pin`).toBe(
            row.manifest.manifestDigest,
          );
        }

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
        const totalSteps = runFacts.reduce((sum, fact) => sum + fact.journalSteps, 0);
        console.info(
          `[VAL-030] OFFLINE corpus summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
            `of ${runFacts.length} driven control rows; ${totalSteps} trajectory steps recorded through ` +
            `the REAL recorder path (every projected digest a member of its pinned class; the re-run's ` +
            `identical steps REPLAYED — zero new journal events); the longitudinal ledger holds exactly ` +
            `${ledgerCount.rows[0]?.c} immutable identities (ONE per control run — the re-run re-observed ` +
            `the SAME identity, never a second one); the registry holds the append-only history ` +
            `(r1→r2 correction intact over REAL SQL); usage honestly none-reported offline; latency ` +
            `measured, never estimated; digests only, payload bytes never journaled.`,
        );
      } finally {
        await world.server.app.close();
      }
    });

    test("the REAL live rail drives the control semantics with a REAL model confirmation round", {
      timeout: 240_000,
    }, async () => {
      const generateId = createUuidv7Generator();
      const notRun: string[] = [];
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-030] OPENROUTER_API_KEY absent — the REAL live control row is a NOT RUN " +
            "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
            "covers every freeze/re-run/ledger/accounting path without credentials. Required " +
            "access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
            "covering the default chat model — the control run's own dispatch round demands a " +
            "REAL model confirmation (measured usage, never estimated, never fabricated).",
        );
        expect(true).toBe(true);
        return;
      }

      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];

      try {
        // The REAL durable registry + ledger for the live world.
        const registry = await seedRealBaselineRegistry(ctx, world);
        const ledger = createRealLongitudinalLedger(ctx, world);

        // ONE live dispatch binding for ALL live rows (the VAL-025
        // review lesson): the connection and its sealed credential
        // envelope are registered ONCE and shared.
        let liveDispatch: ControlDispatch | undefined;
        for (const [taskIndex, row] of LONGITUDINAL_CORPUS.entries()) {
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
          // Provider-side pacing before the live row.
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const runSuffix = `live-${generateId().slice(-8)}`;
          if (liveDispatch === undefined) {
            liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
          }
          const dispatch: ControlDispatch = liveDispatch;
          const { executionId, result, appSettled, appKey, appBody } = await driveCrownRow({
            ctx,
            world,
            address,
            row,
            taskIndex,
            runSuffix,
            registry,
            ledger,
            driven,
            dispatch,
          });

          expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
          expect(result.freeze.agreed, `${row.rowId} freeze`).toBe(true);
          expect(result.learning.inert, `${row.rowId} inert`).toBe(true);
          expect(result.ledger.exactlyOnce, `${row.rowId} exactly once`).toBe(true);
          expect(result.accounting.honest, `${row.rowId} accounting`).toBe(true);
          // The live row's usage is MEASURED (never estimated, never
          // fabricated) and the control run made its OWN dispatch.
          expect(result.usage === null || result.usage.inputTokens > 0).toBe(true);
          expect(result.observedModelCalls).toBe(row.expectedModelCalls);
          expect(result.trajectoryDigest).not.toBeNull();
          expect(row.expectedTrajectoryClass).toContain(result.trajectoryDigest ?? "");
          // The trajectories recorded through the REAL recorder path.
          const stepRows = await ctx.port.execute<{
            ordinal: number;
            kind: string;
            detail: string;
            digest: string;
          }>(
            {
              sql: `SELECT (reference->>'ordinal')::int AS ordinal, reference->>'kind' AS kind,
                           reference->>'detail' AS detail, reference->>'digest' AS digest
                    FROM executions.execution_events
                    WHERE execution_id = $1 AND type = 'execution.agent-action-recorded'
                    ORDER BY sequence ASC`,
              parameters: [executionId],
            },
          );
          const projection: TrajectoryStepRecord[] = stepRows.rows.map((step) => ({
            ordinal: step.ordinal,
            kind: trajectoryStepKindOf(step.kind),
            detail: step.detail,
            digest: step.digest,
          }));
          expect(trajectoryDigestOf(projection)).toBe(result.trajectoryDigest);
          // The ledger: exactly ONE immutable identity over REAL SQL.
          const ledgerRow = await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
            parameters: [
              world.applicationId,
              LEDGER_OPERATION,
              controlRunKeyOf({ executionId, manifest: row.manifest }),
            ],
          });
          expect(Number(ledgerRow.rows[0]?.c ?? 0), `${row.rowId} ONE ledger identity`).toBe(1);
          // The app over the public wire.
          expect(validateHarnessEvidence(appSettled.outcome.evidence)).toEqual([]);
          expect(appSettled.outcome.observedTerminal).toBe(row.expected.terminal);
          expect(appSettled.outcome.observedModelCalls).toBe(row.expectedModelCalls);

          const usage =
            result.usage === null
              ? "none-reported"
              : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
                (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`);
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            trajectoryDigest: result.trajectoryDigest ?? "none",
            rerunDigest: result.rerunTrajectoryDigest ?? "none",
            identityId: result.identityId ?? "none",
            journalSteps: projection.length,
            latencyMs: result.totalLatencyMs,
            appSubmissions: "1c+0r+0x",
            appTerminal: appSettled.outcome.observedTerminal ?? "none",
            appModelCalls: appSettled.outcome.observedModelCalls ?? -1,
            usage,
            keyDigest: createHash("sha256").update(appKey, "utf8").digest("hex").slice(0, 16),
            bodyDigest: createHash("sha256")
              .update(JSON.stringify(appBody), "utf8")
              .digest("hex")
              .slice(0, 16),
            manifestDigest: row.manifest.manifestDigest,
          });
          console.info(
            `[VAL-030]   LIVE ${row.rowId} -> ${result.terminal} traj=${result.trajectoryDigest} ` +
              `identity=${result.identityId} steps=${projection.length} ` +
              `latency=${result.totalLatencyMs}ms usage=${usage}`,
          );
        }

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        console.info(
          `[VAL-030] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live ` +
            `control rows over the REAL OpenRouter rail (model ${MODEL}); measured usage on every ` +
            `dispatched round (BYOK); digests only, payload bytes never journaled.`,
        );
        for (const boundary of notRun) {
          console.warn(`[VAL-030] NOT RUN boundary: ${boundary}`);
        }
        // At least one REAL live dispatch happened (never an
        // all-NOT-RUN silent pass once a credential is present).
        expect(runFacts.length).toBeGreaterThan(0);
      } finally {
        await world.server.app.close();
      }
    });
  },
);
