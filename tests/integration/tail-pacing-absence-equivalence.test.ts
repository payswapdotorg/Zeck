/**
 * Integration: the PCL-002 absence-equivalence proof over the REAL wired
 * stack (ACR-010 §4; work order PCL-002 — the wiring discipline,
 * default-off and absence-equivalent).
 *
 * THE PROOF (the PCR-002/PCS-003 pattern — the traced execution/decision
 * table, sha256-pinned): the baseline traced table of the real wired
 * stack — the PPR-027 mediated execution pipeline (the real seeded API
 * world, the real executions authority through the public transitions,
 * the real model gateway, the real rail machinery, the real synthetic
 * supply transport) driven through the deterministic draw profiles — was
 * captured at the PCL-002 BASE COMMIT (ba29f617 — the PCL-001
 * delivered-records head) BEFORE any PCL-002 change, and pinned by its
 * sha256 digest. THIS suite re-drives the SAME real wired stack at HEAD
 * with NO pacing configuration authored anywhere (the PCL-002 tail
 * mechanics are default-off: no configuration object is constructed, no
 * resolver is armed — nothing in the stack addresses the pacing plane)
 * and proves the traced table is BYTE-IDENTICAL to the captured baseline:
 *
 *   - with no configuration authored, every existing call site, test and
 *     evidence record is byte-identical to today (ACR-010 §4);
 *   - the deterministic projection excludes wall-clock latencies and
 *     generated identities (uuids, timestamps) — exactly the PCR-002
 *     honesty-anchor projection discipline (the observable dispatch
 *     sequence + the governed ledger + the terminal statuses);
 *   - the table is a pure function of the deterministic draw profiles:
 *     re-computation within the same tree is byte-identical.
 *
 * The PCL-002 mechanics DISCRIMINATION (each dimension on/off via the
 * declared configuration only) is proven in
 * tests/discrimination/tail-pacing.discrimination.test.ts — over the
 * same real seam vocabulary, with the configuration authored.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { composeExperimentStack, type ExperimentStack } from "../../experiments/ppr-027/compose";
import type { SubjectDefinition, SubjectEdge } from "../../experiments/ppr-027/config";
import { drawnFault } from "../../experiments/ppr-027/transport";
import { ACTOR_ID } from "../unit/api/world";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// The hermetic fixtures (the PCR-002 integration suite's own discipline)
// ---------------------------------------------------------------------------

const EDGE: SubjectEdge = { edgeId: "edge-1", surface: "text-generation", modalityClass: "text" };

const SUBJECT: SubjectDefinition = {
  subjectId: "pcl-002-absence-equivalence",
  name: "PCL-002 absence-equivalence subject",
  repository: "pcl-002/absence-equivalence",
  upstreamRevision: "integration",
  integrationRevision: "integration",
  evidenceRecord: "pcl-002-absence-equivalence",
  requestCountBasis: "resolved-corpus-narrative",
  tokenTotalsBasis: "resolved-corpus-narrative",
  edges: [EDGE],
  tasks: [],
  certifiedTotals: { requests: 0, inputTokens: 0, outputTokens: 0 },
};

const WORKLOAD = { edgeId: "edge-1", inputTokens: 500, outputTokens: 200 };

type FaultShape = "retryable" | "non-retryable" | "clean";

function faultShapeOf(transportStreamKey: string, attempt: number, providerId: string): FaultShape {
  const fault = drawnFault({
    providerId,
    edge: EDGE,
    request: WORKLOAD,
    streamKey: transportStreamKey,
    attempt,
  });
  if (fault === null) {
    return "clean";
  }
  return fault.retryable ? "retryable" : "non-retryable";
}

/**
 * Scan for a DISTINCT task stream key whose draw profile matches the
 * wanted shapes, in order (the transport's draws are pure functions of
 * (streamKey, attempt, providerId) — scanned, never guessed; the entries
 * address the TRANSPORT stream key `${taskStreamKey}:d${occurrence}` —
 * the physical-dispatch occurrence suffix). Each scan EXCLUDES the keys
 * already taken by earlier scans — the drives' idempotency keys derive
 * from the task stream key, so two drives sharing a key would REPLAY
 * the first execution instead of driving a fresh one (the idempotency
 * discipline — a collision is a silently degenerate table, never a
 * proof).
 */
function streamKeyWithProfile(
  wanted: readonly {
    occurrence: number;
    attempt: number;
    providerId: string;
    shape: FaultShape;
  }[],
  taken: ReadonlySet<string> = new Set(),
): string {
  for (let index = 0; index < 200_000; index += 1) {
    const candidate = `pcl002-${index}`;
    if (taken.has(candidate)) {
      continue;
    }
    if (
      wanted.every(
        (entry) =>
          faultShapeOf(`${candidate}:d${entry.occurrence}`, entry.attempt, entry.providerId) ===
          entry.shape,
      )
    ) {
      return candidate;
    }
  }
  throw new Error("no stream key matched the wanted draw profile");
}

/**
 * The four-execution battery (the traced posture's full decision table
 * across the round-robin): the first attempts address supply-a, supply-b,
 * supply-c, supply-a in drive order; the ONE policy retry of drive 2
 * fails over b→a under the round-robin's post-increment indexing:
 *  1. a CLEAN first attempt on supply-a (no retry);
 *  2. a RETRYABLE first-attempt failure on supply-b whose ONE failover
 *     retry (to supply-a) succeeds (the traced posture's recovery);
 *  3. a NON-RETRYABLE first-attempt failure on supply-c (no retry — the
 *     honest terminal);
 *  4. a CLEAN first attempt on supply-a again (the round-robin wraps).
 */
/** The drive battery in order (the table's rows, deterministic; keys distinct). */
const TAKEN_KEYS = new Set<string>();
const nextKey = (
  wanted: readonly {
    occurrence: number;
    attempt: number;
    providerId: string;
    shape: FaultShape;
  }[],
): string => {
  const key = streamKeyWithProfile(wanted, TAKEN_KEYS);
  TAKEN_KEYS.add(key);
  return key;
};
const CLEAN_A_KEY = nextKey([
  { occurrence: 1, attempt: 1, providerId: "supply-a", shape: "clean" },
]);
const RETRYABLE_B_KEY = nextKey([
  { occurrence: 2, attempt: 1, providerId: "supply-b", shape: "retryable" },
  { occurrence: 2, attempt: 2, providerId: "supply-a", shape: "clean" },
]);
const NON_RETRYABLE_C_KEY = nextKey([
  { occurrence: 3, attempt: 1, providerId: "supply-c", shape: "non-retryable" },
]);
const CLEAN_A_AGAIN_KEY = nextKey([
  { occurrence: 4, attempt: 1, providerId: "supply-a", shape: "clean" },
]);

const DRIVES: readonly { readonly label: string; readonly streamKey: string }[] = [
  { label: "clean-a", streamKey: CLEAN_A_KEY },
  { label: "retryable-b-failover-a", streamKey: RETRYABLE_B_KEY },
  { label: "non-retryable-c", streamKey: NON_RETRYABLE_C_KEY },
  { label: "clean-a-again", streamKey: CLEAN_A_AGAIN_KEY },
];

const NO_OP_SLEEPER = async (): Promise<void> => {};

/**
 * THE TRACED EXECUTION/DECISION TABLE (the deterministic projection): for
 * every driven execution, in drive order — the label, the terminal
 * governed status, the FULL governed ledger projection (event type +
 * command + cause — the single write path's append-only truth; generated
 * identities and wall-clock timestamps excluded), and the observable
 * dispatch sequence (provider addressed, attempt number, outcome, usage,
 * cost, policy-retry flag — the dispatch-facts journal's projection for
 * that execution). A pure function of the deterministic draw profiles.
 */
async function tracedTable(stack: ExperimentStack): Promise<string> {
  const executions = stack.world.executions;
  const lines: string[] = [];
  for (const entry of DRIVES) {
    const receipt = await executions.createExecution(
      {
        applicationId: stack.applicationId,
        task: {
          kind: "ppr-027.workload",
          edgeId: "edge-1",
          surface: "text-generation",
          role: "text",
          inputTokens: WORKLOAD.inputTokens,
          outputTokens: WORKLOAD.outputTokens,
          streamKey: entry.streamKey,
        },
        constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 30_000 },
        metadata: { origin: "pcl-002-absence-equivalence", streamKey: entry.streamKey },
      },
      `pcl-002-absence-equivalence-${entry.streamKey}`,
      { actorId: ACTOR_ID, tenantId: stack.world.tenantId },
    );
    const final = await executions.getExecution(stack.applicationId, receipt.executionId);
    const ledger = await executions.listEvents(stack.applicationId, receipt.executionId);
    const dispatch = stack
      .dispatchFacts()
      .filter((fact) => fact.executionId === receipt.executionId)
      .map((fact) => ({
        providerId: fact.providerId,
        attempt: fact.attempt,
        outcome: fact.outcome,
        usage: fact.usage,
        costNanoUsd: fact.costNanoUsd,
        policyRetry: fact.policyRetry,
      }));
    lines.push(
      [
        entry.label,
        final?.status ?? "UNKNOWN",
        JSON.stringify(ledger.map((event) => [event.type, event.command, event.cause ?? null])),
        JSON.stringify(dispatch),
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

describe("the PCL-002 absence-equivalence proof over the real wired stack (ACR-010 §4)", () => {
  test("with NO pacing configuration authored, the traced table is byte-identical to the captured BASELINE (sha256-pinned)", {
    timeout: 120_000,
  }, async () => {
    // NO pacing configuration is authored anywhere: the stack is
    // composed exactly as the base commit composed it (the PCL-002
    // plane is default-off — nothing addresses it).
    const stack = await composeExperimentStack({
      subject: SUBJECT,
      providerConfig: "multi",
      providerIds: ["supply-a", "supply-b", "supply-c"],
      retryCooldownMs: 1,
      sleeper: NO_OP_SLEEPER,
    });
    try {
      const table = await tracedTable(stack);
      // Byte-identical re-computation within the same stack: the
      // second pass replays the SAME create idempotency keys — the
      // executions replay their durable outcomes (no second drive),
      // and the table is a pure function of the durable records.
      const replay = await tracedTable(stack);
      expect(replay).toBe(table);
      if (process.env.PCL_002_PRINT_TABLE === "1") {
        console.log(`PCL-002-TABLE-BEGIN\n${table}PCL-002-TABLE-END`);
      }
      // The pinned BASELINE digest — captured at the base commit
      // ba29f617 (the PCL-001 delivered-records head) BEFORE the
      // PCL-002 change, with the traced decision table above (clean
      // first attempt / the one-failover-retry recovery / the honest
      // non-retryable terminal / the round-robin wrap). This pin is
      // the byte-identity claim: with no configuration authored, HEAD
      // reproduces the base table byte-for-byte.
      expect(sha256(table)).toBe(
        "0bb3686eaedf723352d023d51ddc0ac2353ebe949088cb9098e84505d24dba4c",
      );
    } finally {
      await stack.close();
    }
  });
});
