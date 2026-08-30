/**
 * Governed tool runtime (tools module application; WORK-010, TOL-001).
 *
 * THE admission chain + execution boundary for every tool invocation. The
 * runtime is NOT a general-purpose function executor: an invocation is
 * explicitly typed, bound to a parent execution, and admitted through the
 * frozen authority chain before any adapter receives work:
 *
 * ```text
 * request
 *   → identity/tenant + execution binding       (executions ledger read)
 *   → tool admission input resolution           (tool registry)
 *   → POLICY admission                          (REQUIRED seam — the
 *                                                WORK-007 engine decides)
 *   → BUDGET/resource admission                 (WORK-004 authority;
 *                                                fail-closed for costed
 *                                                tools with no authority)
 *   → CAPABILITY admission                      (REQUIRED seam — the
 *                                                WORK-005 registry decides)
 *   → durable intent                            (invocation row +
 *                                                execution.tool-requested)
 *   → adapter execution                         (timeout-enforced)
 *   → normalized observation                    (output-schema validated)
 *   → durable evidence                          (invocation row outcome +
 *                                                execution.tool-result)
 *   → typed result
 * ```
 *
 * The order follows `IMPLEMENTATION.md` §7 (identity/tenant → effective
 * policy → budget reservation → capability resolution → dispatch), the
 * repository-canonical dispatch sequence — the same order the models
 * gateway implements at its seam. No external side effect (adapter
 * execution) can occur before every admission has allowed the dispatch;
 * the durable-intent row is the auditable execution boundary of §14.
 *
 * Authority preservation (Work Order "do not create a second …"):
 *   - policy: decided ONLY by the `ToolAdmission` seam (the policies
 *     module's engine behind it); this file holds no decision logic;
 *   - capability: decided ONLY by the `ToolCapabilityResolution` seam
 *     (the capabilities registry behind it);
 *   - budget: reserve/settle/release ONLY through the WORK-004
 *     `BudgetAuthority`; a costed tool with no wired authority fails
 *     closed (deny-by-default, never silently unbudgeted execution);
 *   - tenant: the server-derived execution binding + composite-keyed
 *     durable rows (TENANT_SCOPE_VIOLATION before any side effect);
 *   - execution lifecycle: untouched — step events ride the executions
 *     module's ledger through `recordStepEvent` (status-preserving);
 *   - evidence: tool outcomes are OBSERVATIONS on the tool axis
 *     (`tool-success`/`tool-failure` — never verification PASS/FAIL and
 *     never provider classes); tool failure surfaces as canonical
 *     `TOOL_ERROR`, distinct from POLICY_DENIED / BUDGET_EXCEEDED /
 *     CAPABILITY_UNAVAILABLE / TENANT_SCOPE_VIOLATION / PROVIDER_ERROR.
 *
 * Idempotency & crash safety (`spec/contracts.md` idempotency rule, §14):
 * the invocation row keyed by (application, caller idempotency key) IS the
 * durable outcome. Same key + same fingerprint replays the same outcome;
 * same key + different fingerprint fails `IDEMPOTENCY_KEY_REUSED`;
 * concurrent duplicates converge on the committed row (registry-resolved
 * adapters may re-execute only for contract-idempotent tools — safe by the
 * contract's own declaration); a crash between durable intent and outcome
 * leaves the honest `dispatching` row: contract-idempotent tools converge
 * by re-execution on retry, non-idempotent tools FAIL CLOSED as
 * `NON_CONVERGENT_EXTERNAL_EFFECT` rather than silently guessing.
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type { BudgetAuthority } from "../../budgets/public";
import type {
  ToolDenialClass,
  ToolInvocationRecord,
  ToolInvocationRequest,
  ToolInvocationResult,
  ToolOutcomeClass,
  ToolPolicyEvidence,
} from "../domain/invocation";
import { checkAgainstSchema } from "../domain/schema";
import type { ToolContract } from "../domain/tool";
import type { ExecutionLedger } from "../ports/execution-ledger";
import type { ToolAdapter } from "../ports/tool-adapter";
import type { ToolAdmission } from "../ports/tool-admission";
import type { ToolCapabilityResolution } from "../ports/tool-capability-gate";
import type { ToolInvocationStore } from "../ports/tool-invocation-store";
import type { ToolRegistry } from "../ports/tool-registry";

/** Canonical request fingerprint (deterministic JSON, sorted keys). */
export function toolRequestFingerprint(request: ToolInvocationRequest): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]);
    }
    return value;
  };
  return JSON.stringify([
    "tools.invoke",
    request.applicationId,
    request.executionId,
    request.actor.actorId,
    request.toolId,
    canonical(request.input),
    request.inputArtifactRefs ?? [],
  ]);
}

export interface ToolRuntimeDeps {
  readonly registry: ToolRegistry;
  /** REQUIRED policy admission seam — no default-allow exists by design. */
  readonly admission: ToolAdmission;
  /** REQUIRED capability authority seam — no default/skip exists by design. */
  readonly capabilities: ToolCapabilityResolution;
  /**
   * Budget authority (WORK-004 surface). OPTIONAL at construction, but a
   * COSTED tool (estimatedMicroUsd > 0) fails closed when no authority is
   * wired — costed work never executes unbudgeted.
   */
  readonly budgetAuthority?: BudgetAuthority;
  readonly store: ToolInvocationStore;
  /** REQUIRED canonical execution event path — no no-op implementation exists. */
  readonly ledger: ExecutionLedger;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** One-way digest of the validated input (provenance without retention). */
  readonly hashInput: (input: Readonly<Record<string, unknown>>) => string;
}

export interface ToolRuntime {
  invoke(request: ToolInvocationRequest, idempotencyKey: string): Promise<ToolInvocationResult>;
  getInvocation(applicationId: string, invocationId: string): Promise<ToolInvocationRecord | null>;
  listInvocationsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly ToolInvocationRecord[]>;
}

const INVOKE_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

export function createToolRuntime(deps: ToolRuntimeDeps): ToolRuntime {
  const { registry, admission, capabilities, budgetAuthority, store, ledger } = deps;

  const iso = () => deps.now().toISOString();

  const resultOf = (record: ToolInvocationRecord, replayed: boolean): ToolInvocationResult => ({
    invocationId: record.id,
    executionId: record.executionId,
    applicationId: record.applicationId,
    toolId: record.toolId,
    toolVersion: record.toolVersion,
    capabilityId: record.capabilityId,
    status: record.status,
    outcomeClass: record.outcomeClass,
    output: record.output,
    outputArtifacts: record.outputArtifacts,
    failureClass: record.failureClass,
    retryable: record.retryable,
    durationMs: record.durationMs,
    ledgerRequestedSequence: record.ledgerRequestedSequence,
    ledgerEvidenceSequence: record.ledgerResultSequence,
    replayed,
  });

  /** Replay a committed terminal record as the caller-visible outcome. */
  const replayOutcome = (record: ToolInvocationRecord, replayed: boolean): ToolInvocationResult => {
    if (record.status === "denied") {
      // Journal-then-fail: the denial is durable; the same logical request
      // replays the same typed canonical denial (WORK-007 precedent).
      throw new PlatformError({
        code: denialCodeOf(record),
        message:
          `tool invocation was denied (${record.denialClass}): ${record.denialReason ?? ""}`.trim(),
        details: {
          invocationId: record.id,
          denialClass: record.denialClass,
          reason: record.denialReason,
        },
      });
    }
    return resultOf(record, replayed);
  };

  const denialCodeOf = (record: ToolInvocationRecord) => {
    switch (record.denialClass) {
      case "policy":
        return "POLICY_DENIED" as const;
      case "budget":
        return "BUDGET_EXCEEDED" as const;
      default:
        return "CAPABILITY_UNAVAILABLE" as const;
    }
  };

  /** Durable journal-then-fail denial record + ledger event + typed error. */
  const denyInvocation = async (
    request: ToolInvocationRequest,
    contract: ToolContract,
    fingerprint: string,
    idempotencyKey: string,
    denialClass: ToolDenialClass,
    code: "POLICY_DENIED" | "BUDGET_EXCEEDED" | "CAPABILITY_UNAVAILABLE",
    reason: string,
    budgetOperationId: string | null,
  ): Promise<never> => {
    const invocationId = deps.generateId();
    const requestedAt = iso();
    const claim = await store.recordDenied({
      id: invocationId,
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      executionId: request.executionId,
      invocationKey: idempotencyKey,
      requestFingerprint: fingerprint,
      toolId: request.toolId,
      toolVersion: contract.version,
      capabilityId: contract.capability.id,
      inputDigest: deps.hashInput(request.input),
      inputArtifacts: [...(request.inputArtifactRefs ?? [])],
      denialClass,
      denialCode: code,
      denialReason: reason,
      requestedAt,
    });
    if (claim.claimed) {
      // The durable denial evidence binds to the canonical execution ledger
      // (journal-then-fail). Denied rows are insert-only terminal rows, so
      // no sequence binding is written back (the envelope is findable by
      // reference.invocationId); replays converge without a second envelope
      // because the event append is idempotent per key.
      await appendLedgerEvent(
        claim.record,
        "tool-denied",
        {
          denied: true,
          denialClass,
          code,
          reason,
        },
        { bind: false },
      );
    }
    throw new PlatformError({
      code,
      message: `tool invocation denied (${denialClass}): ${reason}`,
      details: {
        invocationId: claim.record.id,
        denialClass,
        reason,
        ...(budgetOperationId === null ? {} : { budgetOperationId }),
      },
    });
  };

  const appendLedgerEvent = async (
    record: ToolInvocationRecord,
    command: "tool-requested" | "tool-result" | "tool-denied",
    extraPayload: Readonly<Record<string, unknown>>,
    options: { readonly bind?: boolean } = {},
  ) => {
    // NOTE: event payloads are DETERMINISTIC per logical invocation (no
    // timing values) so retries of the same invocation replay the SAME
    // envelope instead of colliding on the idempotency key. Timing evidence
    // lives on the invocation row, which converges first-writer-wins.
    const outcome = await ledger.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.executionId,
        actor: {
          // The invocation's own durable identity is the provenance actor:
          // the tool runtime acts on behalf of the requesting actor, bound
          // to the parent execution.
          actorId: record.id,
          tenantId: record.tenantId,
        },
        command,
        cause: "tool-invocation",
        reference: {
          invocationId: record.id,
          toolId: record.toolId,
          toolVersion: record.toolVersion,
          capabilityId: record.capabilityId,
          inputDigest: record.inputDigest,
          ...(record.policyEvidence === null ? {} : { policy: record.policyEvidence }),
          ...(record.budgetOperationId === null
            ? {}
            : { budgetOperationId: record.budgetOperationId }),
        },
        payload: {
          invocationId: record.id,
          toolId: record.toolId,
          status: record.status,
          ...extraPayload,
        },
      },
      `${record.id}:${command}`,
    );
    if (options.bind !== false) {
      await store.bindLedgerSequence({
        applicationId: record.applicationId,
        invocationKey: record.invocationKey,
        phase: command === "tool-requested" ? "requested" : "result",
        sequence: outcome.sequence,
      });
    }
    return outcome;
  };

  /**
   * Budget reconciliation on replay: a crash after the durable outcome but
   * before settlement leaves an active reservation; the SAME logical
   * request retry converges it (settle/release are idempotent per key).
   */
  const reconcileBudget = async (record: ToolInvocationRecord): Promise<void> => {
    if (budgetAuthority === undefined || record.budgetOperationId === null) {
      return;
    }
    try {
      if (record.status === "succeeded") {
        await budgetAuthority.settle(
          {
            actorId: record.id,
            applicationId: record.applicationId,
            tenantId: record.tenantId,
            operationId: record.budgetOperationId,
            actualAmountMicroUsd: record.usageMicroUsd ?? "0",
          },
          `${record.invocationKey}:settle`,
        );
      } else if (record.status === "tool-failed") {
        await budgetAuthority.release(
          {
            actorId: record.id,
            applicationId: record.applicationId,
            tenantId: record.tenantId,
            operationId: record.budgetOperationId,
          },
          `${record.invocationKey}:release`,
        );
      }
    } catch {
      // Settlement/release is idempotent per operationId; a failure here
      // must not mask the replayed outcome (reconciliation by key).
    }
  };

  const invoke = async (
    request: ToolInvocationRequest,
    idempotencyKey: string,
  ): Promise<ToolInvocationResult> => {
    // ----- 0. Pure request validation (no durable writes, no authority
    // calls; failures never claim the idempotency key). ---------------------
    if (!isUuid(request.applicationId)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "tool invocation requires a valid applicationId",
      });
    }
    if (!isUuid(request.executionId)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "tool invocation requires a valid executionId (the parent execution)",
      });
    }
    if (!isUuid(request.actor.actorId) || !isUuid(request.actor.tenantId)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "tool invocation requires a server-derived actor scope",
      });
    }
    if (typeof idempotencyKey !== "string" || !INVOKE_KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "tool invocation requires a non-empty printable idempotency key (max 200 chars)",
      });
    }
    if (
      request.input === null ||
      typeof request.input !== "object" ||
      Array.isArray(request.input)
    ) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "tool invocation input must be a JSON object",
      });
    }
    if (
      request.inputArtifactRefs !== undefined &&
      (!Array.isArray(request.inputArtifactRefs) ||
        request.inputArtifactRefs.some((ref) => typeof ref !== "string" || ref.length === 0))
    ) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "inputArtifactRefs must be an array of non-empty reference strings",
      });
    }

    const fingerprint = toolRequestFingerprint(request);

    // ----- 1. Idempotent replay / crash-recovery fast path. -----------------
    const existing = await store.findByKey(request.applicationId, idempotencyKey);
    let recovery: ToolInvocationRecord | null = null;
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          details: { invocationId: existing.id, toolId: existing.toolId },
        });
      }
      if (existing.status !== "dispatching") {
        await reconcileBudget(existing);
        return replayOutcome(existing, true);
      }
      // Honest unknown outcome from a previous attempt that crashed between
      // durable intent and outcome recording (§14): converge or fail closed.
      const resolved = await registry.resolve(request.toolId);
      if (resolved === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `tool ${request.toolId} is not registered`,
        });
      }
      if (!resolved.contract.execution.idempotent) {
        throw new PlatformError({
          code: "NON_CONVERGENT_EXTERNAL_EFFECT",
          message:
            "a previous attempt of this non-idempotent tool invocation left an unknown external outcome (dispatching); the invocation fails closed instead of re-executing",
          details: { invocationId: existing.id, toolId: existing.toolId },
        });
      }
      // Contract-idempotent: continue the SAME logical invocation.
      recovery = existing;
      return executeAdmitted(
        request,
        resolved.contract,
        resolved.adapter,
        fingerprint,
        idempotencyKey,
        recovery,
      );
    }

    // ----- 2. Identity/tenant + execution binding (§7 step 1). --------------
    const execution = await ledger.getExecution(request.applicationId, request.executionId);
    if (execution === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "execution not found in this application (missing or owned by another application)",
        details: { executionId: request.executionId },
      });
    }
    if (execution.tenantId !== request.actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution belongs to a different tenant",
        details: { executionId: request.executionId },
      });
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no tool may be invoked on it`,
        details: { executionId: request.executionId, status: execution.status },
      });
    }

    // ----- 3. Tool admission input resolution (the registry). ---------------
    const registered = await registry.resolve(request.toolId);
    if (registered === null) {
      // Unregistered tools cannot be invoked by construction: there is no
      // adapter to dispatch and no contract to admit.
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `tool ${request.toolId} is not registered (unregistered tools cannot be invoked)`,
        details: { toolId: request.toolId },
      });
    }
    const contract = registered.contract;

    const inputCheck = checkAgainstSchema(contract.inputSchema, request.input);
    if (!inputCheck.ok) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `tool input violates the ${contract.toolId} input contract: ${inputCheck.reason}`,
        details: { toolId: contract.toolId, field: inputCheck.field ?? null },
      });
    }

    // ----- 4. POLICY admission (the gate — before anything durable). --------
    const decision = await admission.admit({
      tenantId: execution.tenantId,
      applicationId: request.applicationId,
      executionId: request.executionId,
      toolId: contract.toolId,
      hosts: [...contract.network.hosts],
      secretRefs: [...contract.secrets.refs],
    });
    if (!decision.allowed) {
      await denyInvocation(
        request,
        contract,
        fingerprint,
        idempotencyKey,
        "policy",
        "POLICY_DENIED",
        decision.reason,
        null,
      );
    }
    let policyEvidence: ToolPolicyEvidence | null = null;
    if ("evidence" in decision && decision.evidence !== undefined) {
      policyEvidence = decision.evidence;
    }

    // ----- 5. BUDGET/resource admission (fail-closed for costed tools). -----
    const costed = contract.cost.estimatedMicroUsd !== "0";
    const budgetOperationId = costed ? `tool-invocation:${idempotencyKey}` : null;
    if (costed && budgetAuthority === undefined) {
      await denyInvocation(
        request,
        contract,
        fingerprint,
        idempotencyKey,
        "budget",
        "BUDGET_EXCEEDED",
        "tool declares a non-zero cost estimate but no budget authority is wired; costed tools never execute unbudgeted",
        null,
      );
    }
    if (costed && budgetAuthority !== undefined) {
      try {
        await budgetAuthority.reserve(
          {
            actorId: request.actor.actorId,
            applicationId: request.applicationId,
            tenantId: execution.tenantId,
            executionId: request.executionId,
            operationId: budgetOperationId ?? `tool-invocation:${idempotencyKey}`,
            userId: execution.userId ?? "",
            amountMicroUsd: contract.cost.estimatedMicroUsd,
          },
          idempotencyKey,
        );
      } catch (error) {
        if (error instanceof PlatformError && error.code === "BUDGET_EXCEEDED") {
          await denyInvocation(
            request,
            contract,
            fingerprint,
            idempotencyKey,
            "budget",
            "BUDGET_EXCEEDED",
            error.message,
            budgetOperationId,
          );
        }
        throw error;
      }
    }

    // ----- 6. CAPABILITY admission (the capabilities authority). ------------
    const resolution = await capabilities.resolve({
      requirements: [
        {
          id: contract.capability.id,
          kind: contract.capability.kind,
          ...(contract.capability.minVersion === undefined
            ? {}
            : { minVersion: contract.capability.minVersion }),
        },
      ],
    });
    if (!resolution.satisfied) {
      const unmet = resolution.unmet
        .map((entry) => `${entry.requirementId}(${entry.reason})`)
        .join(", ");
      if (budgetAuthority !== undefined && budgetOperationId !== null) {
        // The reservation was placed but capability admission refused:
        // release it — no spend will be incurred.
        try {
          await budgetAuthority.release(
            {
              actorId: request.actor.actorId,
              applicationId: request.applicationId,
              tenantId: execution.tenantId,
              operationId: budgetOperationId,
            },
            `${idempotencyKey}:capability-release`,
          );
        } catch {
          // Release is idempotent per operation; a failure here must not
          // mask the canonical capability denial (reconciliation by key).
        }
      }
      await denyInvocation(
        request,
        contract,
        fingerprint,
        idempotencyKey,
        "capability",
        "CAPABILITY_UNAVAILABLE",
        `tool capability requirement cannot be satisfied: ${unmet}`,
        budgetOperationId,
      );
    }
    const satisfaction = resolution.satisfied ? resolution.satisfactions[0] : undefined;
    const capabilitySatisfaction =
      satisfaction === undefined
        ? null
        : `${satisfaction.claimId}@${satisfaction.claimVersion} (${satisfaction.evidenceKind}:${satisfaction.evidenceReference})`;

    // ----- 7. Durable intent + adapter execution + evidence. ----------------
    return executeAdmitted(
      request,
      contract,
      registered.adapter,
      fingerprint,
      idempotencyKey,
      null,
      {
        policyEvidence,
        budgetOperationId,
        capabilitySatisfaction,
      },
    );
  };

  /**
   * The post-admission half: durable intent (§14 boundary), ledger event,
   * timeout-enforced adapter execution, normalization, guarded outcome
   * recording, ledger result event, budget settlement, typed result.
   * `recovery` non-null ⇒ continuing a previously-admitted dispatching
   * invocation (admissions are NOT re-evaluated — the original admission
   * evidence on the row stands).
   */
  const executeAdmitted = async (
    request: ToolInvocationRequest,
    contract: ToolContract,
    adapter: ToolAdapter,
    fingerprint: string,
    idempotencyKey: string,
    recovery: ToolInvocationRecord | null,
    admitted?: {
      readonly policyEvidence: ToolPolicyEvidence | null;
      readonly budgetOperationId: string | null;
      readonly capabilitySatisfaction: string | null;
    },
  ): Promise<ToolInvocationResult> => {
    // 7a. Durable intent (single claim; concurrent duplicates converge).
    const invocationId = recovery?.id ?? deps.generateId();
    const requestedAt = recovery?.requestedAt ?? iso();
    const claim = recovery ?? null;
    let record: ToolInvocationRecord;
    if (claim !== null) {
      record = claim;
    } else {
      const outcome = await store.claimDispatching({
        id: invocationId,
        applicationId: request.applicationId,
        tenantId: request.actor.tenantId,
        executionId: request.executionId,
        invocationKey: idempotencyKey,
        requestFingerprint: fingerprint,
        toolId: contract.toolId,
        toolVersion: contract.version,
        capabilityId: contract.capability.id,
        inputDigest: deps.hashInput(request.input),
        inputArtifacts: [...(request.inputArtifactRefs ?? [])],
        budgetOperationId: admitted?.budgetOperationId ?? null,
        policyEvidence: admitted?.policyEvidence ?? null,
        capabilitySatisfaction: admitted?.capabilitySatisfaction ?? null,
        requestedAt,
      });
      if (!outcome.claimed) {
        // A concurrent duplicate owns the key: converge on its committed
        // state (terminal → replay; dispatching → continue/execute under
        // the SAME identity — contract-idempotent by the recovery rule).
        const existing = outcome.record;
        if (existing.status !== "dispatching") {
          return replayOutcome(existing, true);
        }
        if (!contract.execution.idempotent) {
          throw new PlatformError({
            code: "NON_CONVERGENT_EXTERNAL_EFFECT",
            message:
              "a concurrent duplicate owns this invocation key and is still dispatching; non-idempotent tools fail closed instead of double-dispatching",
            details: { invocationId: existing.id, toolId: contract.toolId },
          });
        }
        record = existing;
      } else {
        record = outcome.record;
      }
    }

    // 7b. Ledger intent event (idempotent per invocation identity).
    if (record.ledgerRequestedSequence === null) {
      const appended = await appendLedgerEvent(record, "tool-requested", {
        inputArtifacts: [...(request.inputArtifactRefs ?? [])],
        deterministic: contract.execution.deterministic,
      });
      record = { ...record, ledgerRequestedSequence: appended.sequence };
    }

    // 7c. Adapter execution with the contract's timeout discipline.
    const dispatchedAt = iso();
    const started = Date.now();
    let observation: Awaited<ReturnType<ToolAdapter["execute"]>>;
    try {
      observation = await withTimeout(
        adapter.execute(
          { invocationId: record.id, contract, input: request.input },
          {
            tenantId: record.tenantId,
            applicationId: record.applicationId,
            executionId: record.executionId,
            timeoutMs: contract.execution.timeoutMs,
          },
        ),
        contract.execution.timeoutMs,
      );
    } catch (error) {
      // A thrown error is a tool-axis failure (typed TOOL_ERROR) — provider
      // errors, policy denials and authorization failures never take this
      // path: those were decided BEFORE dispatch, by the authorities. The
      // runtime's own timeout deadline surfaces as the `timeout` class;
      // anything else the adapter threw is an `adapter-error` observation.
      const timedOut =
        error instanceof PlatformError &&
        error.details !== undefined &&
        (error.details as Record<string, unknown>).timeoutMs === contract.execution.timeoutMs;
      observation = {
        kind: "tool-failure",
        failure: {
          failureClass: timedOut ? "timeout" : "adapter-error",
          message: error instanceof Error ? error.message : String(error),
          retryable: timedOut,
        },
      };
    }

    // 7d. Normalization (output contract enforced by the RUNTIME).
    const completedAt = iso();
    const durationMs = Date.now() - started;
    let status: "succeeded" | "tool-failed";
    let outcomeClass: ToolOutcomeClass;
    let output: Readonly<Record<string, unknown>> | null;
    let outputArtifacts: readonly string[];
    let failureClass: ToolInvocationRecord["failureClass"] = null;
    let failureMessage: string | null = null;
    let retryable = false;
    let usageMicroUsd: string | null = null;

    if (observation.kind === "tool-success") {
      const outputCheck = checkAgainstSchema(contract.outputSchema, observation.output);
      if (!outputCheck.ok) {
        status = "tool-failed";
        outcomeClass = "tool-failure";
        output = null;
        outputArtifacts = [];
        failureClass = "output-contract";
        failureMessage = `adapter output violates the ${contract.toolId} output contract: ${outputCheck.reason}`;
        retryable = false;
      } else {
        status = "succeeded";
        outcomeClass = "tool-success";
        output = observation.output;
        outputArtifacts = [...(observation.artifacts ?? [])];
        usageMicroUsd = observation.usageMicroUsd ?? "0";
      }
    } else {
      status = "tool-failed";
      outcomeClass = "tool-failure";
      output = null;
      outputArtifacts = [];
      failureClass = observation.failure.failureClass;
      failureMessage = observation.failure.message;
      retryable = observation.failure.retryable;
    }

    // 7e. Ledger result event FIRST (deterministic payload; idempotent per
    // invocation identity). Appending before the row finalizes keeps the
    // binding writable (terminal rows are immutable) and makes a
    // terminal row WITHOUT its result event unreachable: a crash after
    // the event leaves the row honestly `dispatching`, and the retry
    // re-appends (replay) then finalizes. A concurrent duplicate whose
    // observation differs collides on the idempotency key — tolerated: the
    // winner's envelope stands and both writers converge on one durable
    // row outcome below.
    if (record.ledgerResultSequence === null) {
      try {
        const appended = await appendLedgerEvent(record, "tool-result", {
          outcomeClass,
          outputArtifacts: [...outputArtifacts],
          ...(failureClass === null ? {} : { failureClass }),
          ...(usageMicroUsd === null ? {} : { usageMicroUsd }),
        });
        record = { ...record, ledgerResultSequence: appended.sequence };
      } catch (error) {
        if (!isIdempotencyReuse(error)) {
          throw error;
        }
        // The winner's envelope already recorded this logical invocation's
        // result; converge (binding stays null — the envelope is findable
        // by reference.invocationId on the ledger).
      }
    }

    // 7f. Guarded outcome recording (first writer wins; duplicates converge).
    const finalized = await store.recordOutcome({
      applicationId: request.applicationId,
      invocationKey: idempotencyKey,
      status,
      outcomeClass,
      output,
      outputArtifacts,
      failureClass,
      failureMessage,
      retryable,
      usageMicroUsd,
      dispatchedAt,
      completedAt,
      durationMs,
    });
    // A converged duplicate adopted the winning writer's outcome (its own
    // dispatch timestamp was not the one committed).
    const converged = finalized.dispatchedAt !== dispatchedAt;

    // 7g. Budget settlement: actual usage once on success; release the
    // unspent hold on tool failure (no spend was incurred by the tool).
    if (budgetAuthority !== undefined && finalized.budgetOperationId !== null) {
      try {
        if (finalized.status === "succeeded") {
          await budgetAuthority.settle(
            {
              actorId: request.actor.actorId,
              applicationId: request.applicationId,
              tenantId: finalized.tenantId,
              operationId: finalized.budgetOperationId,
              actualAmountMicroUsd: finalized.usageMicroUsd ?? "0",
            },
            `${idempotencyKey}:settle`,
          );
        } else {
          await budgetAuthority.release(
            {
              actorId: request.actor.actorId,
              applicationId: request.applicationId,
              tenantId: finalized.tenantId,
              operationId: finalized.budgetOperationId,
            },
            `${idempotencyKey}:release`,
          );
        }
      } catch {
        // Settlement/release is idempotent per operationId; a failure here
        // must not erase the durable tool outcome (reconciliation by key —
        // the replay fast path re-attempts it).
      }
    }

    return resultOf(finalized, recovery !== null || converged);
  };

  return {
    invoke,
    async getInvocation(applicationId, invocationId) {
      return store.findById(applicationId, invocationId);
    },
    async listInvocationsByExecution(applicationId, executionId) {
      return store.listByExecution(applicationId, executionId);
    },
  };
}

/** Whether an error is the canonical idempotency key-reuse rejection. */
function isIdempotencyReuse(error: unknown): boolean {
  return error instanceof PlatformError && error.code === "IDEMPOTENCY_KEY_REUSED";
}

/** Reject a promise that does not settle within `timeoutMs` (tool axis). */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new PlatformError({
          code: "TOOL_ERROR",
          message: `tool execution exceeded its declared timeout of ${timeoutMs}ms`,
          retryable: true,
          details: { timeoutMs },
        }),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
