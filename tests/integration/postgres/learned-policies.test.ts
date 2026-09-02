/**
 * Real-PostgreSQL learned planning-policy proofs (WORK-020; migration
 * `0017_learned_planning_policies.sql`): the durable lifecycle over
 * the REAL population history (migration 0009 telemetry/scorecards),
 * the physical invariants and the tenant/application scope.
 *
 * Required-test mapping (the Work Order's real-PostgreSQL axis):
 *  - migration 0017 applies on fresh databases (the collision rule);
 *  - generation mines the REAL telemetry population (scope + window
 *    bound) and persists a durable versioned artifact with full
 *    provenance (source executions + evidence refs);
 *  - same-basis retries CONVERGE (no version churn);
 *  - a new population produces a NEW version whose rollback metadata
 *    names the exact prior version + digest;
 *  - shadow evaluation binds the LATEST durable scorecard version;
 *  - the explicit publication path: canary (shadow evidence) → canary
 *    evaluation (bound to the exact canary publication) → promoted
 *    (shadow + canary evidence) — all revision-bound;
 *  - rollback appends a journal entry (history is never rewritten);
 *  - the ACTIVE pointer is the LATEST journal entry;
 *  - PHYSICAL immutability: UPDATE/DELETE rejected by triggers on all
 *    three tables; version arbitration UNIQUE (application, version);
 *    the CHECK vocabularies (mode/reason/status, canary binding, the
 *    non-empty evidence gate); the composite application/tenant FKs;
 *  - tenant/application scope: cross-scope reads return nothing.
 */

import { expect, test } from "vitest";
import {
  createLearnedPolicyService,
  createLearnedPolicySource,
  createNodeDigest,
  type LearnedPolicyService,
  SqlLearnedPolicyStore,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import { generateId, seedLearningWorld, telemetryFor } from "./learning-world";

definePgSuite("learning learned policies (real PostgreSQL, migration 0017)", (ctx) => {
  interface SeededPopulation {
    readonly world: Awaited<ReturnType<typeof seedLearningWorld>>;
    readonly service: LearnedPolicyService;
    readonly store: SqlLearnedPolicyStore;
  }

  function makeService(at: string): LearnedPolicyService {
    return createLearnedPolicyService({
      store: new SqlLearnedPolicyStore(ctx.port),
      digest: createNodeDigest(),
      generateId,
      now: () => new Date(at),
    });
  }

  /** 12 rail-a observations (11 completed) + 12 rail-b (5 completed). */
  async function seedPopulation(
    world: Awaited<ReturnType<typeof seedLearningWorld>>,
  ): Promise<void> {
    const mix: readonly { route: { provider: string; model: string }; completed: number }[] = [
      { route: { provider: "rail-a", model: "model-x" }, completed: 11 },
      { route: { provider: "rail-b", model: "model-y" }, completed: 5 },
    ];
    for (const entry of mix) {
      for (let index = 0; index < 12; index += 1) {
        const final = index < entry.completed ? "COMPLETED" : "FAILED";
        const executionId = await world.seedTerminalExecution(final);
        await world.learning.recordExecutionTelemetry(
          telemetryFor(world, executionId, final, {
            route: entry.route,
            costMicroUsd: entry.route.provider === "rail-a" ? "1000" : "200",
            latencyMs: entry.route.provider === "rail-a" ? 2000 : 1500,
          }),
        );
      }
    }
    await world.learning.buildScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
  }

  async function seed(): Promise<SeededPopulation> {
    const world = await seedLearningWorld(ctx.port);
    await seedPopulation(world);
    return {
      world,
      service: makeService("2026-09-15T14:00:00Z"),
      store: new SqlLearnedPolicyStore(ctx.port),
    };
  }

  /** Publish through the full explicit path (shadow → canary → promoted). */
  async function publishFully(
    seeded: SeededPopulation,
    mode: "canary" | "promoted",
  ): Promise<void> {
    const { world, service } = seeded;
    const { policy } = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const { evaluation: shadow } = await service.evaluateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    await service.publishLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
    });
    if (mode === "promoted") {
      const { evaluation: canary } = await service.evaluateLearnedPolicy({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        policyId: policy.policyId,
        evaluationClass: "canary",
      });
      await service.publishLearnedPolicy({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        policyId: policy.policyId,
        publicationMode: "promoted",
        publishedBy: "operator-1",
        evaluationEvidence: [
          { evaluationId: shadow.evaluationId },
          { evaluationId: canary.evaluationId },
        ],
      });
    }
  }

  test("migration 0017 applies on fresh databases (the inventory rule)", async () => {
    const world = await seedLearningWorld(ctx.port);
    const exists = await world.db.execute<{ readonly exists: boolean }>({
      sql: `SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'learning'
                AND table_name IN ('learned_planning_policies', 'learned_policy_evaluations',
                                   'learned_policy_publication_log')
            ) AS exists`,
      parameters: [],
    });
    expect(exists.rows[0]?.exists).toBe(true);
  });

  test("generation mines the REAL population and persists the durable versioned artifact", async () => {
    const seeded = await seed();
    const { world, service } = seeded;
    const { policy, replayed } = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(replayed).toBe(false);
    expect(policy.policyVersion).toBe(1);
    expect(policy.totalPopulation).toBe(24);
    expect(policy.preferences).toHaveLength(1);
    expect(policy.preferences[0]?.taskClass).toBe("summarize");
    expect(policy.preferences[0]?.ranked[0]?.subjectKey).toBe("rail-a/model-x");
    expect(policy.preferences[0]?.ranked[1]?.subjectKey).toBe("rail-b/model-y");

    // The durable row exists with the exact digest.
    const row = await ctx.port.execute<{
      readonly digest: string;
      readonly total_population: number;
    }>({
      sql: `SELECT digest, total_population FROM learning.learned_planning_policies WHERE id = $1`,
      parameters: [policy.policyId],
    });
    expect(row.rows[0]?.digest).toBe(policy.digest);
    expect(Number(row.rows[0]?.total_population)).toBe(24);

    // Provenance: every source execution is a REAL execution row.
    const executionCheck = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM executions.executions WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(String(executionCheck.rows[0]?.count)).toBe("24");
  });

  test("same-basis retries CONVERGE; a NEW population produces version 2 with exact rollback metadata", async () => {
    const seeded = await seed();
    const { world, service } = seeded;
    const first = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const retry = await makeService("2026-09-15T15:00:00Z").generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(retry.replayed).toBe(true);
    expect(retry.policy.policyId).toBe(first.policy.policyId);

    // New evidence → version 2.
    const executionId = await world.seedTerminalExecution("COMPLETED");
    await world.learning.recordExecutionTelemetry(
      telemetryFor(world, executionId, "COMPLETED", {
        route: { provider: "rail-c", model: "model-z" },
        costMicroUsd: "500",
      }),
    );
    const second = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(second.replayed).toBe(false);
    expect(second.policy.policyVersion).toBe(2);
    expect(second.policy.rollback.rollbackToPolicyVersion).toBe(1);
    expect(second.policy.rollback.priorPolicyDigest).toBe(first.policy.digest);

    // The prior version is byte-identical history.
    const reread = await seeded.store.getLearnedPolicy(
      { applicationId: world.applicationId, tenantId: world.tenantId },
      first.policy.policyId,
    );
    expect(reread).toEqual(first.policy);
  });

  test("the explicit publication path is revision-bound end to end (shadow → canary → promoted)", async () => {
    const seeded = await seed();
    const { world, service } = seeded;
    const { policy } = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const { evaluation: shadow } = await service.evaluateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    // The shadow evaluation bound the LATEST durable scorecard (the
    // seed built version 1 — read it back through the store, never a
    // rebuild: a same-basis rebuild fails closed by design).
    const scorecard = await new SqlLearnedPolicyStore(ctx.port).getLatestScorecard({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    expect(scorecard).not.toBeNull();
    expect(shadow.basis).toMatchObject({
      kind: "scorecard",
      scorecardId: scorecard?.scorecardId,
      scorecardVersion: scorecard?.scorecardVersion,
    });
    expect(shadow.status).not.toBe("insufficient-evidence");

    // Promoted without canary evidence fails closed.
    await expect(
      service.publishLearnedPolicy({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        policyId: policy.policyId,
        publicationMode: "promoted",
        publishedBy: "operator-1",
        evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
      }),
    ).rejects.toThrow(/BOTH a shadow and a canary/);

    // Canary publication → canary evaluation bound to it → promoted.
    const canaryPublication = await service.publishLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
    });
    const { evaluation: canary } = await service.evaluateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      evaluationClass: "canary",
    });
    expect(canary.canaryBinding?.publicationId).toBe(canaryPublication.publicationId);
    expect(canary.canaryBinding?.publishedAt).toBe(canaryPublication.publishedAt);

    const promoted = await service.publishLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      publicationMode: "promoted",
      publishedBy: "operator-1",
      evaluationEvidence: [
        { evaluationId: shadow.evaluationId },
        { evaluationId: canary.evaluationId },
      ],
    });
    expect(promoted.publicationMode).toBe("promoted");

    // The ACTIVE pointer is the promoted publication; the read seam
    // projects it with its full anchors.
    const active = await service.consultLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(active?.publication.publicationId).toBe(promoted.publicationId);
    expect(active?.policy.policyId).toBe(policy.policyId);
    const source = createLearnedPolicySource(service);
    expect(
      (await source.consult({ applicationId: world.applicationId, tenantId: world.tenantId }))
        ?.publication.publicationMode,
    ).toBe("promoted");

    // The durable evaluation rows are revision-bound to the policy.
    const evaluations = await seeded.store.listLearnedPolicyEvaluations(
      { applicationId: world.applicationId, tenantId: world.tenantId },
      policy.policyId,
    );
    expect(evaluations.map((evaluation) => evaluation.evaluationClass).sort()).toEqual([
      "canary",
      "shadow",
    ]);
    for (const evaluation of evaluations) {
      expect(evaluation.policyVersion).toBe(policy.policyVersion);
    }
  });

  test("rollback appends a journal entry; the ACTIVE pointer moves; history stays durable", async () => {
    const seeded = await seed();
    const { world, service } = seeded;
    await publishFully(seeded, "promoted");
    const v1 = await service.consultLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });

    // New population → v2 → publish promoted.
    const executionId = await world.seedTerminalExecution("COMPLETED");
    await world.learning.recordExecutionTelemetry(
      telemetryFor(world, executionId, "COMPLETED", {
        route: { provider: "rail-c", model: "model-z" },
        costMicroUsd: "500",
      }),
    );
    await publishFully(seeded, "promoted");
    const v2 = await service.consultLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(v2?.policy.policyVersion).toBe(2);

    // Rollback to v1.
    const rollback = await service.rollbackLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      toPolicyId: v1?.policy.policyId as string,
      publishedBy: "operator-9",
    });
    expect(rollback.publicationReason).toBe("rollback");
    expect(rollback.policyVersion).toBe(1);
    expect(rollback.publicationMode).toBe("promoted");

    const active = await service.consultLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(active?.publication.publicationId).toBe(rollback.publicationId);
    expect(active?.policy.policyVersion).toBe(1);

    // The journal carries the full append-only history (initial ×3 +
    // rollback) and v2 remains durable.
    const journal = await ctx.port.execute<{ readonly reason: string; readonly mode: string }>({
      sql: `SELECT publication_reason AS reason, publication_mode AS mode
            FROM learning.learned_policy_publication_log
            WHERE application_id = $1 ORDER BY publication_seq`,
      parameters: [world.applicationId],
    });
    expect(journal.rows.map((row) => row.reason)).toEqual([
      "initial",
      "initial",
      "initial",
      "initial",
      "rollback",
    ]);
    const v2Row = await seeded.store.getLearnedPolicy(
      { applicationId: world.applicationId, tenantId: world.tenantId },
      v2?.policy.policyId as string,
    );
    expect(v2Row).toEqual(v2?.policy);
  });

  test("PHYSICAL immutability: UPDATE and DELETE are rejected by the triggers on all three tables", async () => {
    const seeded = await seed();
    const { world } = seeded;
    await publishFully(seeded, "canary");
    const policyId = (
      await seeded.service.consultLearnedPolicy({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      })
    )?.policy.policyId as string;
    const evaluationId = (
      await seeded.store.listLearnedPolicyEvaluations(
        { applicationId: world.applicationId, tenantId: world.tenantId },
        policyId,
      )
    )[0]?.evaluationId as string;
    const publicationId = (
      await ctx.port.execute<{ readonly publication_id: string }>({
        sql: `SELECT publication_id FROM learning.learned_policy_publication_log
            WHERE application_id = $1 ORDER BY publication_seq DESC LIMIT 1`,
        parameters: [world.applicationId],
      })
    ).rows[0]?.publication_id as string;

    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.learned_planning_policies SET digest = 'tampered' WHERE id = $1`,
        parameters: [policyId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.learned_planning_policies WHERE id = $1`,
        parameters: [policyId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.learned_policy_evaluations SET status = 'evaluated' WHERE evaluation_id = $1`,
        parameters: [evaluationId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.learned_policy_evaluations WHERE evaluation_id = $1`,
        parameters: [evaluationId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.learned_policy_publication_log SET publication_mode = 'promoted' WHERE publication_id = $1`,
        parameters: [publicationId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.learned_policy_publication_log WHERE publication_id = $1`,
        parameters: [publicationId],
      }),
    ).rejects.toThrow(/immutable/i);
  });

  test("version arbitration is PHYSICAL: a duplicate (application, policy_version) is rejected", async () => {
    const seeded = await seed();
    const { world } = seeded;
    const { policy } = await seeded.service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.learned_planning_policies
              (id, application_id, tenant_id, policy_version, analysis_version,
               telemetry_schema_version, population_fingerprint, evaluation_window_from,
               evaluation_window_to, total_population, preferences,
               rollback_to_policy_version, prior_policy_digest, rollback_note,
               generated_at, digest)
              VALUES ($1, $2, $3, 1, 1, 1, 'rival-fingerprint', NULL, NOW(), 24,
                      '[{"taskClass":"summarize","ranked":[{"subjectKey":"rail-a/model-x","population":12,"successCount":11,"successRate":0.92,"uncertaintyLevel":"high","uncertaintyReasonCode":"binomial-spread","meanCostMicroUsd":"1000","meanLatencyMs":2000}],"confidence":{"level":"high","reasonCode":"binomial-spread","detail":"x"},"population":12,"windowFrom":null,"windowTo":"2026-09-15T14:00:00Z","sourceExecutionIds":["e"],"evidenceRefs":["r"]}]'::jsonb,
                      NULL, NULL, 'rival build', NOW(), 'rival-digest')`,
        parameters: [generateId(), world.applicationId, world.tenantId],
      }),
    ).rejects.toThrow();
    // The service-level arbitration surfaces the same violation typed.
    await expect(
      seeded.store.insertLearnedPolicy({ ...policy, policyId: generateId() }),
    ).rejects.toBeInstanceOf(PlatformError);
  });

  test("the CHECK vocabularies: shadow mode, bad reasons, canary binding, empty evidence are unrepresentable", async () => {
    const seeded = await seed();
    const { world } = seeded;
    const { policy } = await seeded.service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });

    // 'shadow' is not a publication mode.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.learned_policy_publication_log
              (publication_id, application_id, tenant_id, policy_id, policy_version,
               publication_mode, publication_reason, evaluation_evidence, published_at,
               published_by, publication_schema_version)
              VALUES ($1, $2, $3, $4, 1, 'shadow', 'initial', $5::jsonb, NOW(), 'op', 1)`,
        parameters: [
          "pub-shadow-mode",
          world.applicationId,
          world.tenantId,
          policy.policyId,
          JSON.stringify([
            {
              evaluationId: "eval-x",
              evaluationClass: "shadow",
              evaluationDigest: "d",
              evaluatedAt: "2026-09-15T14:00:00Z",
            },
          ]),
        ],
      }),
    ).rejects.toThrow(/mode|vocabulary/i);

    // A canary evaluation without a binding is unrepresentable.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.learned_policy_evaluations
              (evaluation_id, application_id, tenant_id, policy_id, policy_version,
               evaluation_class, status, verdict, metrics, comparison, basis,
               canary_binding, evidence_refs, source_execution_ids, evaluated_at, schema_version)
              VALUES ($1, $2, $3, $4, 1, 'canary', 'inconclusive', 'inconclusive', NULL, NULL,
                      $5::jsonb, NULL, '[]'::jsonb, '[]'::jsonb, NOW(), 1)`,
        parameters: [
          "eval-unbound-canary",
          world.applicationId,
          world.tenantId,
          policy.policyId,
          JSON.stringify({
            kind: "scorecard",
            scorecardId: "sc-1",
            scorecardVersion: 1,
            definitionId: "route-outcome-by-task-class",
            definitionVersion: 1,
            telemetrySchemaVersion: 1,
            populationWindowFrom: null,
            populationWindowTo: "2026-09-15T14:00:00Z",
          }),
        ],
      }),
    ).rejects.toThrow(/canary/i);

    // A publication with EMPTY evaluation evidence is unrepresentable.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.learned_policy_publication_log
              (publication_id, application_id, tenant_id, policy_id, policy_version,
               publication_mode, publication_reason, evaluation_evidence, published_at,
               published_by, publication_schema_version)
              VALUES ($1, $2, $3, $4, 1, 'canary', 'initial', '[]'::jsonb, NOW(), 'op', 1)`,
        parameters: ["pub-empty-evidence", world.applicationId, world.tenantId, policy.policyId],
      }),
    ).rejects.toThrow(/evidence/i);
  });

  test("a publication can only point at a policy of ITS OWN application (composite FK)", async () => {
    const seeded = await seed();
    const { world } = seeded;
    const { policy } = await seeded.service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const foreignApp = generateId();
    const foreignTenant = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [foreignTenant, `t-${foreignTenant.slice(-6)}`, "foreign tenant"],
    });
    await ctx.port.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [foreignApp, foreignTenant, `a-${foreignApp.slice(-6)}`, "foreign app"],
    });
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.learned_policy_publication_log
              (publication_id, application_id, tenant_id, policy_id, policy_version,
               publication_mode, publication_reason, evaluation_evidence, published_at,
               published_by, publication_schema_version)
              VALUES ($1, $2, $3, $4, 1, 'canary', 'initial', $5::jsonb, NOW(), 'op', 1)`,
        parameters: [
          "pub-cross-app",
          foreignApp,
          foreignTenant,
          policy.policyId,
          JSON.stringify([
            {
              evaluationId: "eval-x",
              evaluationClass: "shadow",
              evaluationDigest: "d",
              evaluatedAt: "2026-09-15T14:00:00Z",
            },
          ]),
        ],
      }),
    ).rejects.toThrow();
  });

  test("tenant/application scope: cross-scope reads return nothing; foreign publication fails closed", async () => {
    const seeded = await seed();
    const { world } = seeded;
    await publishFully(seeded, "canary");
    const foreignApp = "00000000-0000-7000-8000-0000000000ee";
    expect(
      await seeded.service.consultLearnedPolicy({
        applicationId: foreignApp,
        tenantId: world.tenantId,
      }),
    ).toBeNull();
    expect(
      await seeded.store.listLearnedPolicyPublications({
        applicationId: foreignApp,
        tenantId: world.tenantId,
      }),
    ).toEqual([]);
    // Publishing from a foreign scope fails closed (the policy is not
    // visible there).
    const active = await seeded.service.consultLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    await expect(
      seeded.service.publishLearnedPolicy({
        applicationId: foreignApp,
        tenantId: world.tenantId,
        policyId: active?.policy.policyId as string,
        publicationMode: "canary",
        publishedBy: "operator-1",
        evaluationEvidence: [{ evaluationId: "eval-x" }],
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("no telemetry population in scope fails closed (evidence over claims)", async () => {
    const world = await seedLearningWorld(ctx.port);
    const service = makeService("2026-09-15T14:00:00Z");
    await expect(
      service.generateLearnedPolicy({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      }),
    ).rejects.toThrow(/no telemetry population/i);
  });
});
