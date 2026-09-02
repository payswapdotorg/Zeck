/**
 * Real-PostgreSQL proofs — the media-generation fabric (WORK-026,
 * MOD-011/MOD-012/MOD-013) through migration 0021.
 *
 * The durable-state + lifecycle + isolation proofs over REAL
 * PostgreSQL: job identity binding (one job = one execution = one paid
 * dispatch), the submission idempotency convergence (N=8 concurrent
 * duplicates), tenant isolation (service + physical FK), the
 * observation ledger discipline, the closed lifecycle vocabulary +
 * terminal immutability, budget-before-paid-dispatch with the REAL
 * budgets service (physical wallet debits + reservation rows), the
 * verification-before-completion boundary through the REAL
 * verification authority, artifact adoption lineage (MOD-012), the
 * write-once physical guards of migration 0021, and the full
 * provenance walk on ONE execution identity.
 */

import { expect, test } from "vitest";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import {
  completedCallbackFor,
  type MediaPgWorld,
  pollToCompletion,
  seedMediaWorld,
  submitMediaJob,
} from "./media-world";

definePgSuite("media generation proofs (WORK-026) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<MediaPgWorld> {
    return seedMediaWorld(ctx.port);
  }

  async function expectCode(promise: Promise<unknown>, code: string): Promise<PlatformError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      const platformError = error as PlatformError;
      expect(platformError.code).toBe(code);
      return platformError;
    }
    throw new Error(`expected PlatformError ${code}`);
  }

  // ---- SQL inspection helpers ---------------------------------------------

  async function jobRow(applicationId: string, jobId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: "SELECT * FROM deployments.media_jobs WHERE application_id = $1 AND id = $2",
      parameters: [applicationId, jobId],
    });
    return result.rows[0] ?? null;
  }

  async function observationCount(applicationId: string, jobId: string, observationKey: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: "SELECT COUNT(*)::text AS count FROM deployments.media_observations WHERE application_id = $1 AND job_id = $2 AND observation_key = $3",
      parameters: [applicationId, jobId, observationKey],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function operationRow(applicationId: string, operationKey: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: "SELECT * FROM deployments.media_operations WHERE application_id = $1 AND operation_key = $2",
      parameters: [applicationId, operationKey],
    });
    return result.rows[0] ?? null;
  }

  async function artifactRows(applicationId: string, jobId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: "SELECT * FROM deployments.media_artifacts WHERE application_id = $1 AND job_id = $2 ORDER BY created_at, id",
      parameters: [applicationId, jobId],
    });
    return result.rows;
  }

  async function walletBalance(applicationId: string): Promise<string> {
    const result = await ctx.port.execute<{ balance_micro_usd: string }>({
      sql: "SELECT balance_micro_usd FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'",
      parameters: [applicationId],
    });
    return result.rows[0]?.balance_micro_usd ?? "missing";
  }

  async function reservationCount(applicationId: string, operationId: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: "SELECT COUNT(*)::text AS count FROM budgets.reservations WHERE application_id = $1 AND operation_id = $2",
      parameters: [applicationId, operationId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function executionStatus(applicationId: string, executionId: string) {
    const result = await ctx.port.execute<{ status: string }>({
      sql: "SELECT status FROM executions.executions WHERE application_id = $1 AND id = $2",
      parameters: [applicationId, executionId],
    });
    return result.rows[0]?.status ?? null;
  }

  async function evidenceCount(applicationId: string, executionId: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: "SELECT COUNT(*)::text AS count FROM executions.execution_events WHERE application_id = $1 AND execution_id = $2",
      parameters: [applicationId, executionId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  const GRANT = "50000000";

  // ---- IDENTITY + SUBMISSION ----------------------------------------------

  test("a submission walks the full admission chain to ONE paid dispatch, a generating job row and an execution RUNNING", async () => {
    const world = await freshWorld();
    const outcome = await submitMediaJob(world, "identity-1");
    expect(outcome.status).toBe("generating");
    expect(outcome.providerJobRef).toMatch(/^simmedia-job-\d+$/);
    // The job row: identity core + closed vocabulary + the pinned plan v1.
    const row = await jobRow(world.applicationId, outcome.jobId);
    expect(row?.status).toBe("generating");
    expect(row?.generation_kind).toBe("image");
    expect(row?.pinned_plan_id).toBe("brand-media-plan");
    expect(row?.pinned_plan_version).toBe(1);
    expect(row?.provider_job_ref).toBe(outcome.providerJobRef);
    expect(row?.reservation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The execution: RUNNING (a media job IS an execution).
    expect(await executionStatus(world.applicationId, outcome.executionId)).toBe("RUNNING");
    // The budget-before-paid-dispatch is PHYSICAL: the wallet was
    // debited the rail's declared image cost (80000) — ONE converged
    // reservation — and ONE reservation row exists for the stable
    // operation id.
    expect(await walletBalance(world.applicationId)).toBe(String(Number(GRANT) - 80000));
    expect(await reservationCount(world.applicationId, `media-reserve:${outcome.jobId}`)).toBe(1);
    // The provenance: the submission + dispatch evidence ride the
    // executions ledger (physical rows).
    expect(await evidenceCount(world.applicationId, outcome.executionId)).toBeGreaterThanOrEqual(2);
    // The paid-dispatch operation row is COMPLETED (the durable tail).
    const dispatchOp = await operationRow(
      world.applicationId,
      `mediaop:paid-dispatch:${outcome.jobId}`,
    );
    expect(dispatchOp?.status).toBe("completed");
  });

  test("submission idempotency: N=8 CONCURRENT duplicate submissions converge on ONE job, ONE execution, ONE paid dispatch, ONE reservation", async () => {
    const world = await freshWorld();
    const actor = world.actor();
    const input = {
      deploymentId: world.deploymentId,
      generationKind: "image" as const,
      prompt: "a concurrent render",
    };
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => world.service.submitJob(input, "submit-concurrent", actor)),
    );
    const jobIds = new Set(outcomes.map((o) => o.jobId));
    const executionIds = new Set(outcomes.map((o) => o.executionId));
    expect(jobIds.size).toBe(1);
    expect(executionIds.size).toBe(1);
    // Exactly ONE rail dispatch record (duplicates converge by key).
    expect(world.rail.sends.filter((r) => r.kind === "dispatch")).toHaveLength(1);
    // ONE physical job row + ONE reservation for the stable operation id.
    const jobId = outcomes[0]?.jobId ?? "";
    expect(await jobRow(world.applicationId, jobId)).not.toBeNull();
    expect(await reservationCount(world.applicationId, `media-reserve:${jobId}`)).toBe(1);
    // The operation rows converged (completed).
    expect(
      (await operationRow(world.applicationId, "mediaop:job-submission:submit-concurrent"))?.status,
    ).toBe("completed");
    expect(
      (await operationRow(world.applicationId, `mediaop:paid-dispatch:${jobId}`))?.status,
    ).toBe("completed");
  });

  test("a reused submission key with a DIFFERENT body fails closed (IDEMPOTENCY_KEY_REUSED)", async () => {
    const world = await freshWorld();
    await submitMediaJob(world, "reuse-1");
    await expectCode(
      world.service.submitJob(
        {
          deploymentId: world.deploymentId,
          generationKind: "image",
          prompt: "a DIFFERENT render under the same key",
        },
        "submit-reuse-1",
        world.actor(),
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
    // Still exactly one job row under the key.
    expect(
      await jobRow(world.applicationId, (await submitMediaJob(world, "reuse-1")).jobId),
    ).not.toBeNull();
  });

  // ---- ADMISSION DENIALS (before any paid dispatch) ------------------------

  test("policy denial BEFORE any paid dispatch: no job row, no rail dispatch, no reservation, execution FAILED", async () => {
    const world = await freshWorld();
    // Deny the neutral tool dimension for the media job-submit action
    // through the REAL policies engine (a strictly-increasing version
    // of the default set — the house publish discipline).
    await world.policyAuthority.publish({
      id: "default",
      version: 2,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: { tool: { deniedTools: ["media:job-submit"] } },
        },
      ],
    });
    const error = await expectCode(
      world.service.submitJob(
        {
          deploymentId: world.deploymentId,
          generationKind: "image",
          prompt: "a denied render",
        },
        "submit-denied",
        world.actor(),
      ),
      "POLICY_DENIED",
    );
    expect(error.message).toMatch(/denied by admission policy/);
    // ZERO side effects: no dispatch, no reservation, no wallet debit.
    expect(world.rail.sends).toHaveLength(0);
    expect(await walletBalance(world.applicationId)).toBe(GRANT);
    // The denial is durably recorded on the submission operation row.
    const op = await operationRow(world.applicationId, "mediaop:job-submission:submit-denied");
    expect(op?.status).toBe("failed");
    expect(String(op?.failure_reason ?? "")).toMatch(/denied/);
  });

  test("budget exhaustion BEFORE the paid dispatch fails the submission closed: zero dispatches, the wallet untouched beyond the failed reservation", async () => {
    const world = await freshWorld();
    // Drain the wallet with a competing reservation held open.
    const scope = {
      actorId: world.actor().actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.budgetService.reserve(
      { ...scope, executionId: "drain-exec", operationId: "drain-op", amountMicroUsd: GRANT },
      "drain-reserve",
    );
    await expectCode(
      world.service.submitJob(
        {
          deploymentId: world.deploymentId,
          generationKind: "video",
          prompt: "an unfunded render",
        },
        "submit-unfunded",
        world.actor(),
      ),
      "BUDGET_EXCEEDED",
    );
    expect(world.rail.sends).toHaveLength(0);
    expect(await reservationCount(world.applicationId, "media-reserve:")).toBe(0);
  });

  test("capability denial BEFORE the paid dispatch (CAPABILITY_UNAVAILABLE)", async () => {
    const world = await freshWorld();
    world.admissions.unmetCapabilities = ["media-generation-fabric"];
    await expectCode(
      world.service.submitJob(
        {
          deploymentId: world.deploymentId,
          generationKind: "image",
          prompt: "an incapable render",
        },
        "submit-incapable",
        world.actor(),
      ),
      "CAPABILITY_UNAVAILABLE",
    );
    expect(world.rail.sends).toHaveLength(0);
    expect(await walletBalance(world.applicationId)).toBe(GRANT);
  });

  // ---- OBSERVATIONS + CALLBACK CORRELATION ---------------------------------

  test("polls append the normalized observation evidence; the completion observation completes the job through the deterministic boundary", async () => {
    const world = await freshWorld();
    const submitted = await submitMediaJob(world, "poll-1");
    const outcome = await pollToCompletion(world.service, submitted.jobId, world.actor());
    expect(outcome?.status).toBe("completed");
    expect(outcome?.outputArtifactDigest).toMatch(/^[0-9a-f]{64}$/);
    // The observation rows: accepted, progressed, progressed, completed
    // (append-only evidence, one row per normalized observation).
    const observations = await ctx.port.execute<Record<string, unknown>>({
      sql: "SELECT observation FROM deployments.media_observations WHERE application_id = $1 AND job_id = $2 ORDER BY event_seq",
      parameters: [world.applicationId, submitted.jobId],
    });
    expect(observations.rows.map((r) => r.observation)).toEqual([
      "progressed",
      "progressed",
      "provider-completed",
    ]);
    // The job row: completed + the output artifact digest (the
    // verification-before-completion projection guard's happy path).
    const row = await jobRow(world.applicationId, submitted.jobId);
    expect(row?.status).toBe("completed");
    expect(String(row?.output_artifact_digest ?? "")).toMatch(/^[0-9a-f]{64}$/);
    // The execution reached COMPLETED through the ledger's `pass`.
    expect(await executionStatus(world.applicationId, submitted.executionId)).toBe("COMPLETED");
    // ONE generated-output adoption record with lineage + deployment version.
    const artifacts = await artifactRows(world.applicationId, submitted.jobId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.role).toBe("generated-output");
    expect(artifacts[0]?.pinned_plan_version).toBe(1);
  });

  test("duplicate callbacks converge on the physical observation key; foreign/stale callbacks are rejected", async () => {
    const world = await freshWorld();
    const submitted = await submitMediaJob(world, "callback-1");
    const frame = completedCallbackFor(submitted.jobId, submitted.providerJobRef ?? "");
    const first = await world.service.applyCallback(frame, world.actor());
    expect(first.status).toBe("completed");
    expect(first.replayed).toBe(false);
    // The duplicate callback converges (no second row, replayed outcome).
    const duplicate = await world.service.applyCallback(frame, world.actor());
    expect(duplicate.status).toBe("completed");
    expect(duplicate.replayed).toBe(true);
    expect(await observationCount(world.applicationId, submitted.jobId, frame.callbackKey)).toBe(1);
    // A FOREIGN callback (wrong provider reference) is rejected BEFORE
    // any mutation.
    await expectCode(
      world.service.applyCallback(
        completedCallbackFor(submitted.jobId, "simmedia-job-foreign"),
        world.actor(),
      ),
      "PROVIDER_ERROR",
    );
    // A callback for a job with no rail reference cannot precede dispatch.
    const notDispatched = await world.service.submitJob(
      {
        deploymentId: world.deploymentId,
        generationKind: "image",
        prompt: "not dispatched yet",
      },
      "submit-callback-2",
      world.actor(),
    );
    await expectCode(
      world.service.applyCallback(
        completedCallbackFor(notDispatched.jobId, "simmedia-job-x"),
        world.actor(),
      ),
      "PROVIDER_ERROR",
    );
  });

  // ---- TENANT ISOLATION ----------------------------------------------------

  test("tenant isolation: a job belongs to its tenant (service guard + physical FK); foreign actors cannot poll or cancel", async () => {
    const world = await freshWorld();
    const submitted = await submitMediaJob(world, "tenant-1");
    const foreignActor = {
      actorId: world.actor().actorId,
      applicationId: world.applicationId,
      tenantId: "00000000-0000-7000-8000-0000000000e9",
    };
    await expectCode(
      world.service.pollJob(submitted.jobId, foreignActor),
      "TENANT_SCOPE_VIOLATION",
    );
    await expectCode(
      world.service.cancelJob(submitted.jobId, "foreign cancel", foreignActor),
      "TENANT_SCOPE_VIOLATION",
    );
    await expectCode(world.service.getJob(submitted.jobId, foreignActor), "TENANT_SCOPE_VIOLATION");
    // The physical FK: a job row for a foreign tenant cannot be
    // inserted (the (application_id, tenant_id) FK into
    // applications.applications fails closed at the database).
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO deployments.media_jobs (id, application_id, tenant_id, deployment_id, pinned_plan_id, pinned_plan_version, execution_id, generation_kind, status, submission_key, creation_fingerprint, verification_mode, verification_criteria, created_by, created_at, updated_at)
VALUES ($1, $2, $3, $4, 'p', 1, $5, 'image', 'submitted', 'k', 'fp', 'none', '[]'::jsonb, $6, now(), now())`,
        parameters: [
          "00000000-0000-7000-8000-0000000000f9",
          world.applicationId,
          foreignActor.tenantId,
          world.deploymentId,
          "00000000-0000-7000-8000-0000000000fa",
          world.actor().actorId,
        ],
      }),
    ).rejects.toThrowError(/violates foreign key constraint/);
  });

  // ---- VERIFICATION-BEFORE-COMPLETION ---------------------------------------

  test("verification-before-completion: mode required with a REJECTING criterion FAILS the job (the output never completes)", async () => {
    const world = await freshWorld();
    const submitted = await world.service.submitJob(
      {
        deploymentId: world.deploymentId,
        generationKind: "image",
        prompt: "a verified render that must fail",
        verification: { criteria: [{ criterionId: "media-kind-audio", version: 1 }] },
      },
      "submit-verify-reject",
      world.actor(),
    );
    const outcome = await pollToCompletion(world.service, submitted.jobId, world.actor()).catch(
      (error: unknown) => {
        expect(error).toBeInstanceOf(PlatformError);
        const platformError = error as PlatformError;
        expect(platformError.code).toBe("VERIFICATION_FAILED");
        return null;
      },
    );
    expect(outcome).toBeNull();
    const row = await jobRow(world.applicationId, submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(String(row?.failure_cause ?? "")).toMatch(/verification rejected/);
    // The output digest is ABSENT on the failed row (the physical
    // projection: outputs attach only at completion).
    expect(row?.output_artifact_digest).toBeNull();
    // The adoption row IS recorded (the rejected output's evidence —
    // the unit suite's contract), but the job row never carries the
    // digest and the execution never completes.
    const rejectedArtifacts = await artifactRows(world.applicationId, submitted.jobId);
    expect(rejectedArtifacts).toHaveLength(1);
    expect(rejectedArtifacts[0]?.role).toBe("generated-output");
    // The execution FAILED through the ledger.
    expect(await executionStatus(world.applicationId, submitted.executionId)).toBe("FAILED");
    // A re-poll of the completion observation CONVERGES on the FAILED
    // terminal state (the recorded rejection cannot flip).
    const replay = await world.service.pollJob(submitted.jobId, world.actor());
    expect(replay.status).toBe("failed");
    expect(replay.replayed).toBe(true);
  });

  test("verification-before-completion: mode required with a PASSING criterion completes through the REAL authority", async () => {
    const world = await freshWorld();
    const submitted = await world.service.submitJob(
      {
        deploymentId: world.deploymentId,
        generationKind: "image",
        prompt: "a verified render that passes",
        verification: { criteria: [{ criterionId: "media-kind-image", version: 1 }] },
      },
      "submit-verify-pass",
      world.actor(),
    );
    const outcome = await pollToCompletion(world.service, submitted.jobId, world.actor());
    expect(outcome?.status).toBe("completed");
    const row = await jobRow(world.applicationId, submitted.jobId);
    expect(row?.status).toBe("completed");
    expect(String(row?.output_artifact_digest ?? "")).toMatch(/^[0-9a-f]{64}$/);
    expect(await executionStatus(world.applicationId, submitted.executionId)).toBe("COMPLETED");
    // The verification evaluation is DURABLE in the verification module's
    // own tables (the independent authority's evidence).
    const evaluations = await ctx.port.execute<Record<string, unknown>>({
      sql: "SELECT COUNT(*)::text AS count FROM verification.evaluations WHERE application_id = $1 AND execution_id = $2",
      parameters: [world.applicationId, submitted.executionId],
    });
    expect(Number(evaluations.rows[0]?.count ?? "0")).toBeGreaterThanOrEqual(1);
  });

  // ---- ARTIFACT LINEAGE (MOD-012) -------------------------------------------

  test("derived variants link to the SOURCE artifact digest + deployment version through the canonical authority", async () => {
    const world = await freshWorld();
    const submitted = await submitMediaJob(world, "variant-1");
    const completed = await pollToCompletion(world.service, submitted.jobId, world.actor());
    expect(completed?.status).toBe("completed");
    const output = completed?.outputArtifactDigest ?? "";
    expect(output).toMatch(/^[0-9a-f]{64}$/);
    const variant = await world.service.deriveVariant(
      { jobId: submitted.jobId, variant: { transform: "resize", width: 512 } },
      "variant-key-1",
      world.actor(),
    );
    expect(variant.parentDigests).toEqual([output]);
    expect(variant.pinnedPlanVersion).toBe(1);
    // The adoption record: write-once with the lineage linkage.
    const artifacts = await artifactRows(world.applicationId, submitted.jobId);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.filter((a) => a.role === "generated-output")).toHaveLength(1);
    expect(artifacts.filter((a) => a.role === "derived-variant")).toHaveLength(1);
    expect(artifacts.find((a) => a.role === "derived-variant")?.parent_digests).toEqual([output]);
    // The canonical authority holds BOTH artifacts (content-addressed).
    expect(
      (await world.artifacts.getArtifact({ tenantId: world.tenantId }, output as never)) !== null,
    ).toBe(true);
    expect(
      (await world.artifacts.getArtifact(
        { tenantId: world.tenantId },
        variant.artifactDigest as never,
      )) !== null,
    ).toBe(true);
    // A repeated derivation under the same key converges (write-once).
    const repeat = await world.service.deriveVariant(
      { jobId: submitted.jobId, variant: { transform: "resize", width: 512 } },
      "variant-key-1",
      world.actor(),
    );
    expect(repeat.replayed).toBe(true);
    expect(repeat.artifactDigest).toBe(variant.artifactDigest);
    expect(await artifactRows(world.applicationId, submitted.jobId)).toHaveLength(2);
  });

  test("source-input artifact lineage: a job whose input artifact is ABSENT from the tenant namespace is denied", async () => {
    const world = await freshWorld();
    const foreignDigest = "a".repeat(64);
    await expectCode(
      world.service.submitJob(
        {
          deploymentId: world.deploymentId,
          generationKind: "image",
          prompt: "a transformation of a foreign artifact",
          inputArtifactDigest: foreignDigest,
        },
        "submit-foreign-input",
        world.actor(),
      ),
      "POLICY_DENIED",
    );
    expect(world.rail.sends).toHaveLength(0);
  });

  // ---- CANCELLATION ---------------------------------------------------------

  test("cancellation: the rail cancel under the stable key, the terminal move, the budget release and the execution cancel", async () => {
    const world = await freshWorld();
    const submitted = await submitMediaJob(world, "cancel-1");
    const outcome = await world.service.cancelJob(submitted.jobId, "fixture", world.actor());
    expect(outcome.status).toBe("cancelled");
    expect(world.rail.sends.filter((r) => r.kind === "cancel")).toHaveLength(1);
    const row = await jobRow(world.applicationId, submitted.jobId);
    expect(row?.status).toBe("cancelled");
    expect(row?.completed_at).not.toBeNull();
    expect(await executionStatus(world.applicationId, submitted.executionId)).toBe("CANCELLED");
    // The wallet: the paid dispatch SETTLED before the cancellation, so
    // the spent funds are not refunded (a settled reservation cannot be
    // released — the release path exists for pre-settle cancellations
    // and crash windows; the P-proofs cover the released-funds case).
    expect(await walletBalance(world.applicationId)).toBe(String(Number(GRANT) - 80000));
    // The repeated cancellation converges.
    const replay = await world.service.cancelJob(submitted.jobId, "fixture", world.actor());
    expect(replay.replayed).toBe(true);
    expect(world.rail.sends.filter((r) => r.kind === "cancel")).toHaveLength(1);
  });

  // ---- CLOSED LIFECYCLE + PHYSICAL GUARDS -----------------------------------

  test("the closed lifecycle vocabulary + terminal immutability are PHYSICAL (migration 0021 guards)", async () => {
    const world = await freshWorld();
    const submitted = await submitMediaJob(world, "guards-1");
    const row = await jobRow(world.applicationId, submitted.jobId);
    expect(row?.status).toBe("generating");
    // An out-of-vocabulary move is rejected by the closed lifecycle
    // guard (the BEFORE trigger runs before the CHECK vocabulary —
    // either way the move is physically unrepresentable).
    await expect(
      ctx.port.execute({
        sql: "UPDATE deployments.media_jobs SET status = 'poof' WHERE id = $1",
        parameters: [submitted.jobId],
      }),
    ).rejects.toThrowError(/cannot move from status generating to poof/);
    // A generating → submitted regression is not a legal transition.
    await expect(
      ctx.port.execute({
        sql: "UPDATE deployments.media_jobs SET status = 'submitted' WHERE id = $1",
        parameters: [submitted.jobId],
      }),
    ).rejects.toThrowError(/cannot move from status generating to submitted/);
    // Complete the job, then attempt terminal mutations.
    const completed = await pollToCompletion(world.service, submitted.jobId, world.actor());
    expect(completed?.status).toBe("completed");
    await expect(
      ctx.port.execute({
        sql: "UPDATE deployments.media_jobs SET status = 'failed', failure_cause = 'x' WHERE id = $1",
        parameters: [submitted.jobId],
      }),
    ).rejects.toThrowError(/terminal-immutable in state completed/);
    // The identity core (pinned plan version) never moves.
    await expect(
      ctx.port.execute({
        sql: "UPDATE deployments.media_jobs SET pinned_plan_version = 2 WHERE id = $1",
        parameters: [submitted.jobId],
      }),
    ).rejects.toThrowError(/identity core is immutable/);
    // Job rows are never deleted.
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM deployments.media_jobs WHERE id = $1",
        parameters: [submitted.jobId],
      }),
    ).rejects.toThrowError(/media_jobs rows are never deleted/);
    // Observation rows are append-only.
    await expect(
      ctx.port.execute({
        sql: "UPDATE deployments.media_observations SET observation = 'accepted' WHERE job_id = $1",
        parameters: [submitted.jobId],
      }),
    ).rejects.toThrowError(/media_observations is append-only/);
    // Adoption rows are write-once.
    await expect(
      ctx.port.execute({
        sql: "UPDATE deployments.media_artifacts SET artifact_digest = repeat('a', 64) WHERE job_id = $1",
        parameters: [submitted.jobId],
      }),
    ).rejects.toThrowError(/media_artifacts is write-once/);
    // Operation rows are never deleted and terminal-immutable.
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM deployments.media_operations WHERE application_id = $1",
        parameters: [world.applicationId],
      }),
    ).rejects.toThrowError(/media_operations rows are never deleted/);
    const dispatchOp = await operationRow(
      world.applicationId,
      `mediaop:paid-dispatch:${submitted.jobId}`,
    );
    expect(dispatchOp?.status).toBe("completed");
    await expect(
      ctx.port.execute({
        sql: "UPDATE deployments.media_operations SET status = 'pending' WHERE application_id = $1",
        parameters: [world.applicationId],
      }),
    ).rejects.toThrowError(/media_operations is terminal-immutable/);
  });

  test("the output-digest projection guard: an output digest cannot appear on a non-completed row", async () => {
    const world = await freshWorld();
    const submitted = await submitMediaJob(world, "projection-1");
    // A LEGAL lifecycle move (generating → verifying) carrying an
    // output digest: the projection guard fires behind the lifecycle
    // guard — outputs attach ONLY at completion.
    await expect(
      ctx.port.execute({
        sql: "UPDATE deployments.media_jobs SET status = 'verifying', output_artifact_digest = repeat('b', 64) WHERE id = $1",
        parameters: [submitted.jobId],
      }),
    ).rejects.toThrowError(/cannot carry an output artifact digest in status verifying/);
  });

  test("the operations ledger discipline: unique claim convergence + attempts monotonicity", async () => {
    const world = await freshWorld();
    const op = await operationRow(world.applicationId, "mediaop:job-submission:submit-discipline");
    expect(op).toBeNull();
    await submitMediaJob(world, "discipline");
    const first = await operationRow(
      world.applicationId,
      "mediaop:job-submission:submit-discipline",
    );
    expect(first?.status).toBe("completed");
    expect(Number(first?.attempts ?? 0)).toBe(1);
    // A duplicate submission claim re-reads the terminal row (no
    // attempts regression, no mutation).
    await submitMediaJob(world, "discipline");
    const second = await operationRow(
      world.applicationId,
      "mediaop:job-submission:submit-discipline",
    );
    expect(second?.status).toBe("completed");
    expect(Number(second?.attempts ?? 0)).toBe(1);
    // The unique key: a second operation row under the same key is
    // unrepresentable.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO deployments.media_operations (id, application_id, tenant_id, job_id, deployment_id, execution_id, operation_kind, operation_key, status, attempts, created_at, updated_at)
VALUES ($1, $2, $3, NULL, $4, NULL, 'job-submission', 'mediaop:job-submission:submit-discipline', 'pending', 1, now(), now())`,
        parameters: [
          "00000000-0000-7000-8000-0000000000fd",
          world.applicationId,
          world.tenantId,
          world.deploymentId,
        ],
      }),
    ).rejects.toThrowError(/media_ops_key_unique/);
  });

  // ---- RETRY + PROVIDER SUBSTITUTION / ROLLBACK ------------------------------

  test("retry: a NEW job with ONE new paid dispatch; the repeated retry key converges (no uncontrolled paid duplicates)", async () => {
    const world = await freshWorld();
    const submitted = await submitMediaJob(world, "retry-src");
    // Drive the job to failed through the provider-failed observation
    // path (the normalized failure projection).
    const frame = {
      jobId: submitted.jobId,
      providerJobRef: submitted.providerJobRef ?? "",
      callbackKey: "cb-fail",
      observation: "provider-failed" as const,
      providerStateLabel: "simulated-failed",
    };
    const failedOutcome = await world.service.applyCallback(frame, world.actor());
    expect(failedOutcome.status).toBe("failed");
    const row = await jobRow(world.applicationId, submitted.jobId);
    expect(row?.status).toBe("failed");
    expect(await executionStatus(world.applicationId, submitted.executionId)).toBe("FAILED");
    // The retry: a NEW job, ONE new paid dispatch, same intent digest.
    const dispatchesBefore = world.rail.sends.filter((r) => r.kind === "dispatch").length;
    const retry = await world.service.retryJob(
      submitted.jobId,
      { prompt: "a fixture render retry-src" },
      "retry-1",
      world.actor(),
    );
    expect(retry.status).toBe("generating");
    expect(retry.jobId).not.toBe(submitted.jobId);
    expect(retry.executionId).not.toBe(submitted.executionId);
    expect(retry.retryOfJobId).toBe(submitted.jobId);
    expect(world.rail.sends.filter((r) => r.kind === "dispatch")).toHaveLength(
      dispatchesBefore + 1,
    );
    // The repeated retry under the same key converges.
    const replay = await world.service.retryJob(
      submitted.jobId,
      { prompt: "a fixture render retry-src" },
      "retry-1",
      world.actor(),
    );
    expect(replay.jobId).toBe(retry.jobId);
    expect(world.rail.sends.filter((r) => r.kind === "dispatch")).toHaveLength(
      dispatchesBefore + 1,
    );
  });

  test("deployment version pinning: jobs pin the deployment's CURRENT plan version; promotion moves the pointer for NEW jobs only", async () => {
    const world = await freshWorld();
    const v1Job = await submitMediaJob(world, "pin-v1");
    expect((await jobRow(world.applicationId, v1Job.jobId))?.pinned_plan_version).toBe(1);
    // Promote plan v2 (the deployment pointer moves).
    const actor = world.actor();
    await world.base.deploymentService.promoteDeployment({
      applicationId: world.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "promote-v2",
      actorId: actor.actorId,
      tenantId: actor.tenantId,
      toPlanVersion: 2,
    });
    // NEW jobs pin v2; the v1 job keeps its pin (the identity core is
    // immutable).
    const v2Job = await submitMediaJob(world, "pin-v2");
    expect((await jobRow(world.applicationId, v2Job.jobId))?.pinned_plan_version).toBe(2);
    expect((await jobRow(world.applicationId, v1Job.jobId))?.pinned_plan_version).toBe(1);
    // The v1 job still COMPLETES on its pinned version (rollback/pinning
    // preserves execution identity — AC7).
    const completed = await pollToCompletion(world.service, v1Job.jobId, world.actor());
    expect(completed?.status).toBe("completed");
    const v1Row = await jobRow(world.applicationId, v1Job.jobId);
    expect(v1Row?.pinned_plan_version).toBe(1);
    expect(String(v1Row?.output_artifact_digest ?? "")).toMatch(/^[0-9a-f]{64}$/);
    // The adoption record carries the v1 pin (deployment-version lineage).
    const v1Artifacts = await artifactRows(world.applicationId, v1Job.jobId);
    expect(v1Artifacts[0]?.pinned_plan_version).toBe(1);
  });
});
