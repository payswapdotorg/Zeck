/**
 * In-flight coalescing tests (WORK-052 AC 4): the PURE decision
 * (lead/join/independent; deterministic oldest-leader selection;
 * join-age window; structural equivalence) and the MECHANISM (one
 * leader, N joiners observing the leader's EXACT outcome; failure
 * fan-out as identical failures; no stale joins after settle;
 * bounded groups).
 */

import { describe, expect, test } from "vitest";
import { ContextEconomicsError } from "../../../../src/platform/context-economics/catalog";
import type { InFlightCandidate } from "../../../../src/platform/context-economics/coalesce";
import {
  decideCoalescing,
  deriveEquivalenceKey,
  InFlightCoalescer,
} from "../../../../src/platform/context-economics/coalesce";
import { nodeDigest, OTHER_TENANT_SCOPE, permissivePolicy, SCOPE } from "./helpers";

const NOW = 1_800_000_000_000;
const WORK = { kind: "summarize", input: "artifact-9" };

function candidates(
  entries: Array<{
    executionId: string;
    key: ReturnType<typeof deriveEquivalenceKey>;
    started: number;
  }>,
): InFlightCandidate[] {
  return entries.map((entry) => ({
    executionId: entry.executionId,
    equivalenceKey: entry.key,
    startedAtEpochMs: entry.started,
  }));
}

describe("the pure coalescing decision", () => {
  test("no equivalent in-flight work → lead", () => {
    const key = deriveEquivalenceKey(SCOPE, WORK, nodeDigest);
    const decision = decideCoalescing({
      candidates: [],
      equivalenceKey: key,
      policy: permissivePolicy(),
      nowEpochMs: NOW,
    });
    expect(decision.kind).toBe("lead");
  });

  test("equivalent fresh work exists → join onto the OLDEST leader (deterministic)", () => {
    const key = deriveEquivalenceKey(SCOPE, WORK, nodeDigest);
    const decision = decideCoalescing({
      candidates: candidates([
        { executionId: "exec-b", key, started: NOW - 10_000 },
        { executionId: "exec-a", key, started: NOW - 10_000 },
        { executionId: "exec-c", key, started: NOW - 1_000 },
      ]),
      equivalenceKey: key,
      policy: permissivePolicy(),
      nowEpochMs: NOW,
    });
    expect(decision.kind).toBe("join");
    if (decision.kind === "join") {
      // Oldest start; tie broken by the lexicographically smallest id.
      expect(decision.leaderExecutionId).toBe("exec-a");
      expect(decision.leaderStartedAtEpochMs).toBe(NOW - 10_000);
    }
  });

  test("a non-equivalent (other tenant) in-flight group is invisible: lead", () => {
    const mine = deriveEquivalenceKey(SCOPE, WORK, nodeDigest);
    const theirs = deriveEquivalenceKey(OTHER_TENANT_SCOPE, WORK, nodeDigest);
    const decision = decideCoalescing({
      candidates: candidates([{ executionId: "exec-x", key: theirs, started: NOW - 1_000 }]),
      equivalenceKey: mine,
      policy: permissivePolicy(),
      nowEpochMs: NOW,
    });
    // Cross-tenant equivalence is unrepresentable: the keys differ.
    expect(decision.kind).toBe("lead");
  });

  test("an expired leader is fail-closed: no join onto too-old work → lead", () => {
    const key = deriveEquivalenceKey(SCOPE, WORK, nodeDigest);
    const decision = decideCoalescing({
      candidates: candidates([{ executionId: "exec-old", key, started: NOW - 120_000 }]),
      equivalenceKey: key,
      policy: permissivePolicy(),
      nowEpochMs: NOW,
    });
    expect(decision.kind).toBe("lead");
  });

  test("policy denial → independent with policy-coalesce-denied (fail-closed recorded)", () => {
    const key = deriveEquivalenceKey(SCOPE, WORK, nodeDigest);
    const decision = decideCoalescing({
      candidates: candidates([{ executionId: "exec-y", key, started: NOW - 1_000 }]),
      equivalenceKey: key,
      policy: { ...permissivePolicy(), coalescingAllowed: false },
      nowEpochMs: NOW,
    });
    expect(decision.kind).toBe("independent");
    if (decision.kind === "independent") {
      expect(decision.reason).toBe("policy-coalesce-denied");
    }
  });

  test("an equivalence key of the WRONG class → independent (identity precondition)", () => {
    const decision = decideCoalescing({
      candidates: [],
      equivalenceKey: {
        ...deriveEquivalenceKey(SCOPE, WORK, nodeDigest),
        keyClass: "memo-entry",
      },
      policy: permissivePolicy(),
      nowEpochMs: NOW,
    });
    expect(decision.kind).toBe("independent");
    if (decision.kind === "independent") {
      expect(decision.reason).toBe("equivalence-key-invalid");
    }
  });

  test("deterministic: identical inputs → the identical decision", () => {
    const key = deriveEquivalenceKey(SCOPE, WORK, nodeDigest);
    const input = {
      candidates: candidates([
        { executionId: "exec-b", key, started: NOW - 5_000 },
        { executionId: "exec-a", key, started: NOW - 5_000 },
      ]),
      equivalenceKey: key,
      policy: permissivePolicy(),
      nowEpochMs: NOW,
    };
    expect(decideCoalescing(input)).toEqual(decideCoalescing(input));
  });

  test("bounded input: too many candidates is a typed rejection", () => {
    const key = deriveEquivalenceKey(SCOPE, WORK, nodeDigest);
    expect(() =>
      decideCoalescing({
        candidates: candidates(
          Array.from({ length: 1025 }, (index) => ({
            executionId: `exec-${index}`,
            key,
            started: NOW,
          })),
        ),
        equivalenceKey: key,
        policy: permissivePolicy(),
        nowEpochMs: NOW,
      }),
    ).toThrow(ContextEconomicsError);
  });
});

describe("the coalescing mechanism (InFlightCoalescer)", () => {
  test("concurrent equivalent work: ONE leader, N joiners, the EXACT same outcome", async () => {
    const coalescer = new InFlightCoalescer();
    let executions = 0;
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        coalescer.join(SCOPE, WORK, nodeDigest, async () => {
          executions += 1;
          await Promise.resolve();
          return { value: "the-leader-outcome", stamp: 42 };
        }),
      ),
    );
    // Exactly ONE execution of the work.
    expect(executions).toBe(1);
    const leaders = outcomes.filter((outcome) => outcome.role === "leader");
    const joiners = outcomes.filter((outcome) => outcome.role === "joiner");
    expect(leaders).toHaveLength(1);
    expect(joiners).toHaveLength(7);
    // Every participant observed the leader's EXACT outcome value.
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe(leaders[0]?.outcome);
    }
    expect(leaders[0]?.joinerCount).toBe(7);
    expect(joiners[0]?.joinerCount).toBe(7);
    // The group is removed after settle.
    expect(coalescer.inFlightGroups).toBe(0);
  });

  test("FAILURE FAN-OUT: the leader's rejection reaches every joiner as the same failure", async () => {
    const coalescer = new InFlightCoalescer();
    const leaderError = new Error("leader exploded");
    let executions = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        coalescer.join(SCOPE, WORK, nodeDigest, async () => {
          executions += 1;
          await Promise.resolve();
          throw leaderError;
        }),
      ),
    );
    expect(executions).toBe(1);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBe(leaderError);
      }
    }
    expect(coalescer.inFlightGroups).toBe(0);
  });

  test("no stale joins: a caller AFTER settle starts a fresh group", async () => {
    const coalescer = new InFlightCoalescer();
    let executions = 0;
    const first = await coalescer.join(SCOPE, WORK, nodeDigest, async () => {
      executions += 1;
      return "first";
    });
    expect(first.role).toBe("leader");
    expect(first.joinerCount).toBe(0);
    // A later caller for the same key: fresh group, fresh execution.
    const second = await coalescer.join(SCOPE, WORK, nodeDigest, async () => {
      executions += 1;
      return "second";
    });
    expect(second.role).toBe("leader");
    expect(second.outcome).toBe("second");
    expect(executions).toBe(2);
  });

  test("different semantics coexist as separate groups (no cross-work coalescing)", async () => {
    const coalescer = new InFlightCoalescer();
    let executions = 0;
    const outcomes = await Promise.all([
      coalescer.join(SCOPE, WORK, nodeDigest, async () => {
        executions += 1;
        return "work-a";
      }),
      coalescer.join(SCOPE, { kind: "summarize", input: "artifact-10" }, nodeDigest, async () => {
        executions += 1;
        return "work-b";
      }),
    ]);
    expect(executions).toBe(2);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["work-a", "work-b"]);
  });

  test("cross-tenant identical semantics NEVER coalesce (structural key isolation)", async () => {
    const coalescer = new InFlightCoalescer();
    let executions = 0;
    const outcomes = await Promise.all([
      coalescer.join(SCOPE, WORK, nodeDigest, async () => {
        executions += 1;
        return "tenant-a-result";
      }),
      coalescer.join(OTHER_TENANT_SCOPE, WORK, nodeDigest, async () => {
        executions += 1;
        return "tenant-b-result";
      }),
    ]);
    expect(executions).toBe(2);
    expect(outcomes[0]?.outcome).toBe("tenant-a-result");
    expect(outcomes[1]?.outcome).toBe("tenant-b-result");
  });

  test("the invalid scope fails closed (no group is created)", async () => {
    const coalescer = new InFlightCoalescer();
    await expect(
      coalescer.join(
        { tenantId: "not-a-uuid", applicationId: SCOPE.applicationId },
        WORK,
        nodeDigest,
        async () => "never",
      ),
    ).rejects.toThrow(ContextEconomicsError);
    expect(coalescer.inFlightGroups).toBe(0);
  });

  test("a leader error mid-work still removes the group (no torn state)", async () => {
    const coalescer = new InFlightCoalescer();
    await expect(
      coalescer.join(SCOPE, WORK, nodeDigest, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The group was removed synchronously at settle: a fresh join leads.
    let executed = false;
    const fresh = await coalescer.join(SCOPE, WORK, nodeDigest, async () => {
      executed = true;
      return "fresh";
    });
    expect(executed).toBe(true);
    expect(fresh.role).toBe("leader");
  });
});
