/**
 * Integration — human approval intake over REAL PostgreSQL
 * (WORK-045 / D-04, acceptance criteria 4; checkpoint contracts
 * IDENTITY-IDEMPOTENCY, EXECUTION-PROVENANCE).
 *
 * Proves over the real database:
 *
 *  - an approval decision is durable, tenant-scoped and attributable
 *    (the approver identity is recorded on the durable notification);
 *  - approve resumes the governed execution (WAITING_HUMAN ->
 *    RUNNING through the single write path);
 *  - reject cancels the governed execution (WAITING_HUMAN ->
 *    CANCELLED through the frozen cancel command — never a bypass);
 *  - the first decision is authoritative: a conflicting later
 *    decision is refused with bounded conflict evidence;
 *  - a repeated identical decision replays the durable outcome
 *    (duplicate convergence);
 *  - an approval without attribution is refused (fail-closed);
 *  - forged scope is refused (tenant isolation);
 *  - approvals are for approval waits: an approval claim against a
 *    callback wait is refused (the kinds never mix);
 *  - the decision travels to the provider signal (zeck.approval with
 *    the decision) — reference-only.
 */

import { expect, test } from "vitest";
import {
  ApprovalConflictError,
  NotificationScopeError,
  StaleNotificationError,
  UnbackedNotificationError,
} from "../../../src/platform/workflow/engine";
import { WorkflowConfigError } from "../../../src/platform/workflow/port";
import { definePgSuite } from "./harness";
import { HUMAN_APPROVER_ID, seedWorkflowWorld } from "./workflow-world";

definePgSuite("human approval intake (WORK-045 D-04)", (ctx) => {
  const world = () => seedWorkflowWorld(ctx.port);

  async function armedHumanWait(suffix: string) {
    const w = await world();
    const executionId = await w.createWaitingExecution(suffix, "human");
    const outcomes = (await w.coordinator.armWaitingExecutions(50)).filter(
      (o) => o.wait.executionId === executionId,
    );
    return { w, executionId, wait: outcomes[0]?.wait };
  }

  const approvalInput = (
    w: Awaited<ReturnType<typeof world>>,
    executionId: string,
    overrides?: Partial<{
      decision: "approve" | "reject";
      notificationKey: string;
      approverId: string;
      tenantId: string;
    }>,
  ) => ({
    applicationId: w.applicationId,
    tenantId: overrides?.tenantId ?? w.tenantId,
    executionId,
    approverId: overrides?.approverId ?? HUMAN_APPROVER_ID,
    decision: overrides?.decision ?? ("approve" as const),
    notificationKey: overrides?.notificationKey ?? "approval-1",
  });

  test("approve resumes the governed execution (WAITING_HUMAN to RUNNING)", async () => {
    const { w, executionId, wait } = await armedHumanWait("approve");
    const outcome = await w.coordinator.recordApproval(approvalInput(w, executionId));
    expect(outcome.state).toBe("settled");
    expect(outcome.effect).toBe("applied");
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    expect(w.transport.eventsOf(wait?.providerInstanceId ?? "")).toEqual(["zeck.approval"]);
  });

  test("reject cancels the governed execution through the frozen cancel command", async () => {
    const { w, executionId } = await armedHumanWait("reject");
    const outcome = await w.coordinator.recordApproval(
      approvalInput(w, executionId, { decision: "reject", notificationKey: "approval-reject" }),
    );
    expect(outcome.state).toBe("settled");
    expect(outcome.effect).toBe("applied");
    expect(await w.statusOf(executionId)).toBe("CANCELLED");
  });

  test("the decision is durable, attributable and digest-only", async () => {
    const { w, executionId } = await armedHumanWait("attributable");
    await w.coordinator.recordApproval(
      approvalInput(w, executionId, {
        decision: "reject",
        notificationKey: "approval-attr",
        approverId: "approver-alice-42",
      }),
    );
    const rows = await ctx.port.execute<{
      kind: string;
      decision: string;
      approver_id: string;
      payload_digest: string;
    }>({
      sql: `SELECT n.kind, n.decision, n.approver_id, n.payload_digest
FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id
WHERE wt.execution_id = $1 AND n.outcome = 'accepted'`,
      parameters: [executionId],
    });
    expect(rows.rows[0]?.kind).toBe("approval");
    expect(rows.rows[0]?.decision).toBe("reject");
    expect(rows.rows[0]?.approver_id).toBe("approver-alice-42");
    expect(rows.rows[0]?.payload_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("the first decision is authoritative: conflicting later decisions are refused", async () => {
    const { w, executionId } = await armedHumanWait("conflict");
    const first = await w.coordinator.recordApproval(
      approvalInput(w, executionId, { decision: "approve", notificationKey: "approval-first" }),
    );
    expect(first.effect).toBe("applied");
    // A conflicting decision is refused even though the wait already
    // settled (the durable decision cannot be displaced). The wait is
    // terminal: the refusal writes no rows (bounded history).
    await expect(
      w.coordinator.recordApproval(
        approvalInput(w, executionId, {
          decision: "reject",
          notificationKey: "approval-conflict",
        }),
      ),
    ).rejects.toThrow(ApprovalConflictError);
    expect(await w.statusOf(executionId)).toBe("RUNNING");
  });

  test("a conflicting decision racing an in-flight resolution leaves bounded evidence", async () => {
    const { w, executionId } = await armedHumanWait("conflict-race");
    const wait = await w.liveWait(executionId, "approval");
    // The resolution is in flight: the accepted notification is
    // durably recorded but the effect has not yet applied (the wait
    // is still armed). A conflicting decision now...
    await w.store.recordNotification(
      {
        waitId: wait?.id ?? "",
        notificationKey: "approval-winner",
        kind: "approval",
        decision: "approve",
        approverId: HUMAN_APPROVER_ID,
        payloadDigest: "b".repeat(64),
        outcome: "accepted",
        detail: null,
      },
      { maxPayloadBytes: 4096, maxRetainedNotifications: 32 },
    );
    // ...and the wait is signaled (the effect is pending).
    await w.store.markSignaled(wait?.id ?? "", {
      stage: "effect",
      attemptNo: 1,
      outcome: "accepted",
      detail: "resolution recorded: approval",
    });
    await expect(
      w.coordinator.recordApproval(
        approvalInput(w, executionId, {
          decision: "reject",
          notificationKey: "approval-raced",
        }),
      ),
    ).rejects.toThrow(ApprovalConflictError);
    // ...leaves the bounded conflict evidence on the LIVE wait.
    const conflicts = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id
WHERE wt.execution_id = $1 AND n.outcome = 'refused-conflict'`,
      parameters: [executionId],
    });
    expect(conflicts.rows[0]?.count).toBe("1");
    // And the authority is untouched (the winning decision applies
    // through recovery).
    const report = await w.coordinator.recoverPending(50);
    expect(report.effectsApplied).toBe(1);
    expect(await w.statusOf(executionId)).toBe("RUNNING");
  });

  test("a repeated identical decision replays the durable outcome (convergence)", async () => {
    const { w, executionId } = await armedHumanWait("replay");
    const first = await w.coordinator.recordApproval(
      approvalInput(w, executionId, { notificationKey: "approval-same" }),
    );
    expect(first.effect).toBe("applied");
    // The duplicate (same key, same decision) is late: refused
    // stale with zero durable writes (nothing new happened).
    await expect(
      w.coordinator.recordApproval(
        approvalInput(w, executionId, { notificationKey: "approval-same" }),
      ),
    ).rejects.toThrow(StaleNotificationError);
    expect(await w.statusOf(executionId)).toBe("RUNNING");
    const accepted = await ctx.port.execute<{ count: string }>({
      sql: `SELECT count(*) AS count FROM workflow_orchestration.notifications n
JOIN workflow_orchestration.waits wt ON wt.id = n.wait_id
WHERE wt.execution_id = $1 AND n.outcome = 'accepted'`,
      parameters: [executionId],
    });
    expect(accepted.rows[0]?.count).toBe("1");
  });

  test("approvals without attribution are refused fail-closed", async () => {
    const { w, executionId } = await armedHumanWait("no-approver");
    await expect(
      w.coordinator.recordApproval(approvalInput(w, executionId, { approverId: "   " })),
    ).rejects.toThrow(WorkflowConfigError);
    expect(await w.statusOf(executionId)).toBe("WAITING_HUMAN");
  });

  test("forged scope is refused (tenant isolation)", async () => {
    const { w, executionId } = await armedHumanWait("scope");
    await expect(
      w.coordinator.recordApproval(
        approvalInput(w, executionId, {
          tenantId: "00000000-0000-7000-8000-0000000000ff",
        }),
      ),
    ).rejects.toThrow(NotificationScopeError);
    expect(await w.statusOf(executionId)).toBe("WAITING_HUMAN");
  });

  test("approval claims against callback waits are refused (kinds never mix)", async () => {
    const w = await world();
    const executionId = await w.createWaitingExecution("kind-mix", "user");
    await w.coordinator.armWaitingExecutions(50);
    // The live wait is a callback wait: an approval intake has no
    // live approval wait to resolve.
    await expect(w.coordinator.recordApproval(approvalInput(w, executionId))).rejects.toThrow(
      UnbackedNotificationError,
    );
    expect(await w.statusOf(executionId)).toBe("WAITING_USER");
  });
});
