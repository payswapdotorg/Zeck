/**
 * Real-PostgreSQL learned-policy concurrency proofs (WORK-020;
 * migration 0017): the durable boundaries under parallel callers.
 *
 * Required-test mapping (the Work Order's concurrency/crash axis):
 *  - concurrent policy GENERATION converges on ONE durable version
 *    (the UNIQUE (application, policy_version) arbitration + the
 *    population-fingerprint replay); no duplicate versions, every
 *    caller holds the winner;
 *  - concurrent EVALUATION retries converge on the content-derived
 *    evaluation identity (exactly one durable row);
 *  - concurrent PUBLICATION of the SAME logical request converges on
 *    one journal entry (the content-derived publication identity);
 *  - concurrent publication of DISTINCT requests all land in the
 *    journal, serialize through publication_seq, and the LATEST entry
 *    is the single active pointer;
 *  - retry convergence after a lost race (the loser re-reads the
 *    durable winner — crash-safe convergence, no version churn).
 */

import { expect, test } from "vitest";
import {
  createLearnedPolicyService,
  createNodeDigest,
  type LearnedPolicyService,
  SqlLearnedPolicyStore,
} from "../../../src/modules/learning/public";
import { definePgSuite } from "./harness";
import { generateId, seedLearningWorld, telemetryFor } from "./learning-world";

const PARALLEL = 8;

definePgSuite("learning learned-policy concurrency (real PostgreSQL)", (ctx) => {
  async function seedPopulation(): Promise<{
    readonly world: Awaited<ReturnType<typeof seedLearningWorld>>;
    readonly makeService: (at: string) => LearnedPolicyService;
    readonly store: SqlLearnedPolicyStore;
  }> {
    const world = await seedLearningWorld(ctx.port);
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
    const store = new SqlLearnedPolicyStore(ctx.port);
    return {
      world,
      store,
      // A FIXED clock per service: the identity of every learned-policy
      // record is content-derived (the population fingerprint / the
      // evaluation basis / the publication request), so parallel
      // callers of the SAME logical request produce the SAME identity
      // and converge — the clock is not part of the replay identity.
      makeService: (at: string) =>
        createLearnedPolicyService({
          store,
          digest: createNodeDigest(),
          generateId,
          now: () => new Date(at),
        }),
    };
  }

  test("concurrent GENERATION converges on ONE durable version (N=8)", async () => {
    const seeded = await seedPopulation();
    const { world } = seeded;
    const services = Array.from({ length: PARALLEL }, () =>
      seeded.makeService("2026-09-15T14:00:00Z"),
    );
    const results = await Promise.all(
      services.map((service) =>
        service.generateLearnedPolicy({
          applicationId: world.applicationId,
          tenantId: world.tenantId,
        }),
      ),
    );
    // Every caller holds the SAME durable policy.
    const ids = new Set(results.map((result) => result.policy.policyId));
    expect(ids.size).toBe(1);
    for (const result of results) {
      expect(result.policy.policyVersion).toBe(1);
    }
    // At least one caller replayed (the winner landed; the rest
    // converged through the fingerprint replay or the arbitration).
    expect(results.some((result) => result.replayed)).toBe(true);
    // Exactly ONE durable row for the application.
    const rows = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM learning.learned_planning_policies
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(String(rows.rows[0]?.count)).toBe("1");
  });

  test("a lost generation race converges on the durable winner (no version churn after conflict)", async () => {
    const seeded = await seedPopulation();
    const { world } = seeded;
    const first = await seeded
      .makeService("2026-09-15T14:00:00Z")
      .generateLearnedPolicy({ applicationId: world.applicationId, tenantId: world.tenantId });
    expect(first.replayed).toBe(false);
    // A "late" caller (its own clock; the same population) converges.
    const late = await seeded
      .makeService("2026-09-15T16:00:00Z")
      .generateLearnedPolicy({ applicationId: world.applicationId, tenantId: world.tenantId });
    expect(late.replayed).toBe(true);
    expect(late.policy.policyId).toBe(first.policy.policyId);
    const rows = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM learning.learned_planning_policies
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(String(rows.rows[0]?.count)).toBe("1");
  });

  test("concurrent EVALUATION retries converge on the content-derived identity (N=8)", async () => {
    const seeded = await seedPopulation();
    const { world } = seeded;
    const service = seeded.makeService("2026-09-15T14:00:00Z");
    const { policy } = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        service.evaluateLearnedPolicy({
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          policyId: policy.policyId,
          evaluationClass: "shadow",
        }),
      ),
    );
    const ids = new Set(results.map((result) => result.evaluation.evaluationId));
    expect(ids.size).toBe(1);
    expect(results.some((result) => result.replayed)).toBe(true);
    const rows = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM learning.learned_policy_evaluations
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(String(rows.rows[0]?.count)).toBe("1");
  });

  test("concurrent publication of the SAME request converges on one journal entry (N=8)", async () => {
    const seeded = await seedPopulation();
    const { world } = seeded;
    const service = seeded.makeService("2026-09-15T14:00:00Z");
    const { policy } = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const { evaluation } = await service.evaluateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    const publications = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        service.publishLearnedPolicy({
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          policyId: policy.policyId,
          publicationMode: "canary",
          publishedBy: "operator-1",
          evaluationEvidence: [{ evaluationId: evaluation.evaluationId }],
        }),
      ),
    );
    expect(new Set(publications.map((entry) => entry.publicationId)).size).toBe(1);
    const journal = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM learning.learned_policy_publication_log
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(String(journal.rows[0]?.count)).toBe("1");
  });

  test("concurrent DISTINCT publications all land, serialize, and leave ONE active pointer (N=8)", async () => {
    const seeded = await seedPopulation();
    const { world } = seeded;
    const service = seeded.makeService("2026-09-15T14:00:00Z");
    const { policy } = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const { evaluation } = await service.evaluateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    // Distinct logical requests: distinct operators (the publication
    // identity is content-derived, so distinct actors → distinct ids).
    const publications = await Promise.all(
      Array.from({ length: PARALLEL }, (_, index) =>
        service.publishLearnedPolicy({
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          policyId: policy.policyId,
          publicationMode: "canary",
          publishedBy: `operator-${index}`,
          evaluationEvidence: [{ evaluationId: evaluation.evaluationId }],
        }),
      ),
    );
    expect(new Set(publications.map((entry) => entry.publicationId)).size).toBe(PARALLEL);

    // ALL entries landed; journal order is the serialization.
    const journal = await ctx.port.execute<{
      readonly publication_id: string;
      readonly seq: string;
    }>({
      sql: `SELECT publication_id, publication_seq::text AS seq
            FROM learning.learned_policy_publication_log
            WHERE application_id = $1 ORDER BY publication_seq ASC`,
      parameters: [world.applicationId],
    });
    expect(journal.rows).toHaveLength(PARALLEL);

    // The LATEST entry is the single active pointer.
    const active = await seeded.store.getActiveLearnedPolicyPublication({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const lastSeq = Number(journal.rows[PARALLEL - 1]?.seq);
    const activeSeq = Number(
      (
        await ctx.port.execute<{ readonly seq: string }>({
          sql: `SELECT publication_seq::text AS seq FROM learning.learned_policy_publication_log
                WHERE publication_id = $1`,
          parameters: [active?.publicationId],
        })
      ).rows[0]?.seq,
    );
    expect(activeSeq).toBe(lastSeq);
    expect(journal.rows.map((row) => row.publication_id)).toContain(active?.publicationId);
  });

  test("publication is crash-safe under a lost insert race: the retried request converges", async () => {
    const seeded = await seedPopulation();
    const { world } = seeded;
    const service = seeded.makeService("2026-09-15T14:00:00Z");
    const { policy } = await service.generateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    const { evaluation } = await service.evaluateLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    const first = await service.publishLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: evaluation.evaluationId }],
    });
    // A "crash-restart" retry with the SAME logical request (a fresh
    // service instance, same content) converges on the same entry.
    const retry = await seeded.makeService("2026-09-15T15:00:00Z").publishLearnedPolicy({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: evaluation.evaluationId }],
    });
    expect(retry.publicationId).toBe(first.publicationId);
    const journal = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM learning.learned_policy_publication_log
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(String(journal.rows[0]?.count)).toBe("1");
  });
});
