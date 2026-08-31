/**
 * Sandbox service (sandbox module application; WORK-012, ENV-001/ENV-002).
 *
 * THE admission chain + execution boundary for every sandbox execution.
 * The sandbox is an execution ENVIRONMENT, never a second execution
 * system: identity/tenant resolution and evidence ride the executions
 * module's ledger through the REQUIRED seam; policy, capability and
 * budget decisions happen in THEIR authorities through REQUIRED seams;
 * the frozen dispatch sequence of `IMPLEMENTATION.md` §7 governs:
 *
 * ```text
 * request
 *   → identity/tenant + execution binding       (executions ledger read)
 *   → environment resolution                    (the catalog: identity,
 *                                                specification, lifecycle)
 *   → POLICY admission                          (REQUIRED seam — the
 *                                                WORK-007 engine decides:
 *                                                isolation fact + hosts +
 *                                                secret refs)
 *   → CAPABILITY admission                      (REQUIRED seam — the
 *                                                WORK-005 registry decides
 *                                                the runtime capability)
 *   → BUDGET/resource admission                 (WORK-004 authority;
 *                                                fail-closed for costed
 *                                                environments; resource
 *                                                limits are mandatory and
 *                                                explicit — no unlimited
 *                                                host defaults)
 *   → durable admission bundle                  (sandbox row + immutable
 *                                                runtime metadata +
 *                                                execution.sandbox-admitted)
 *   → [dispatch] provider resolution            (kind → substrate adapter;
 *                                                no-execution completes
 *                                                structurally without any
 *                                                provider)
 *   → timeout-enforced substrate execution
 *   → durable evidence                          (outcome row finalization +
 *                                                execution.sandbox-completed)
 * → typed result
 * ```
 *
 * NO-EXECUTION IS FIRST CLASS (M17): a `no-execution` environment is
 * admitted like any other (policy still gates its secret declarations)
 * and its dispatch is a structural no-op that never consults a provider —
 * a plan that needs no runtime is never forced through one.
 *
 * Crash safety (`spec/contracts.md` idempotency rule, `IMPLEMENTATION.md`
 * §14): the sandbox row keyed by (application, sandbox key) IS the durable
 * outcome. Same key + same fingerprint replays; different fingerprint
 * fails `IDEMPOTENCY_KEY_REUSED`; concurrent duplicates converge on the
 * committed row. A crash between the dispatching claim and the outcome
 * leaves the honest `dispatching` row — re-dispatch fails closed as
 * `NON_CONVERGENT_EXTERNAL_EFFECT` rather than silently re-executing code
 * whose external effects cannot be proven idempotent.
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type { BudgetAuthority } from "../../budgets/public";
import type { ComputeEnvironmentRecord, SandboxRuntimeRequirement } from "../domain/environment";
import { kindExecutes } from "../domain/environment";
import type {
  SandboxCreateInput,
  SandboxExecutionRecord,
  SandboxPolicyEvidence,
  SandboxRuntimeMetadata,
  SandboxTask,
} from "../domain/sandbox";
import {
  isSandboxExecutionStatus,
  isTerminalSandboxStatus,
  SANDBOX_KEY_PATTERN,
  sandboxRequestFingerprint,
  validateSandboxTask,
} from "../domain/sandbox";
import type { SandboxAdmission } from "../ports/sandbox-admission";
import type { SandboxCapabilityResolution } from "../ports/sandbox-capability-gate";
import type { SandboxExecutionLedger } from "../ports/sandbox-ledger";
import type {
  SandboxExecutionObservation,
  SandboxProviderRegistry,
  SandboxRuntimeSpec,
} from "../ports/sandbox-provider";
import type { SandboxStore } from "../ports/sandbox-store";

export interface SandboxServiceDeps {
  readonly store: SandboxStore;
  /** REQUIRED policy admission seam — no default-allow exists by design. */
  readonly admission: SandboxAdmission;
  /** REQUIRED capability authority seam — no default/skip exists by design. */
  readonly capabilities: SandboxCapabilityResolution;
  /**
   * Budget authority (WORK-004 surface). OPTIONAL at construction, but a
   * COSTED environment (estimated cost > 0) fails closed when no authority
   * is wired — costed compute never executes unbudgeted.
   */
  readonly budgetAuthority?: BudgetAuthority;
  /** REQUIRED canonical execution event path — no no-op implementation exists. */
  readonly ledger: SandboxExecutionLedger;
  /** The substrate registry (kind → provider; consulted ONLY at dispatch). */
  readonly providers: SandboxProviderRegistry;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface SandboxService {
  createSandboxExecution(
    input: SandboxCreateInput,
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<SandboxExecutionRecord>;
  dispatchSandboxExecution(
    input: { readonly applicationId: string; readonly sandboxId: string },
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<SandboxExecutionRecord>;
  getSandbox(applicationId: string, sandboxId: string): Promise<SandboxExecutionRecord | null>;
  listSandboxesByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly SandboxExecutionRecord[]>;
}

/** Whether an error is the canonical idempotency key-reuse rejection. */
function isIdempotencyReuse(error: unknown): boolean {
  return error instanceof PlatformError && error.code === "IDEMPOTENCY_KEY_REUSED";
}

export function createSandboxService(deps: SandboxServiceDeps): SandboxService {
  const { store, admission, capabilities, budgetAuthority, ledger, providers } = deps;
  const iso = () => deps.now().toISOString();

  /** Reject a promise that does not settle within `timeoutMs`. */
  const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new PlatformError({
            code: "SANDBOX_ERROR",
            message: `sandbox execution exceeded its admitted timeout of ${timeoutMs}ms`,
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

  /**
   * Append one sandbox step event on the canonical ledger. Payloads are
   * DETERMINISTIC per logical sandbox (no timing values) so retries replay
   * the SAME envelope instead of colliding on the idempotency key.
   */
  const appendLedgerEvent = async (
    record: SandboxExecutionRecord,
    command: "sandbox-admitted" | "sandbox-denied" | "sandbox-completed",
    extraPayload: Readonly<Record<string, unknown>>,
    options: { readonly bind?: "admitted" | "completed" } = {},
  ) => {
    const outcome = await ledger.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.executionId,
        actor: {
          // The sandbox's own durable identity is the provenance actor:
          // the sandbox runtime acts on behalf of the requesting actor,
          // bound to the parent execution.
          actorId: record.id,
          tenantId: record.tenantId,
        },
        command,
        cause: "sandbox-execution",
        reference: {
          sandboxId: record.id,
          environmentId: record.environmentId,
          kind: record.kind,
          executionId: record.executionId,
          ...(record.runtimeMetadata.policyEvidence === null
            ? {}
            : { policy: record.runtimeMetadata.policyEvidence }),
          ...(record.budgetOperationId === null
            ? {}
            : { budgetOperationId: record.budgetOperationId }),
        },
        payload: {
          sandboxId: record.id,
          environmentId: record.environmentId,
          kind: record.kind,
          status: record.status,
          ...extraPayload,
        },
      },
      `${record.id}:${command}`,
    );
    if (options.bind !== undefined) {
      await store.bindLedgerSequence({
        applicationId: record.applicationId,
        sandboxKey: record.sandboxKey,
        phase: options.bind,
        sequence: outcome.sequence,
      });
    }
    return outcome;
  };

  /** Journal-then-fail denial: durable denied row + ledger envelope + typed error. */
  const denySandbox = async (
    applicationId: string,
    tenantId: string,
    executionId: string,
    environment: ComputeEnvironmentRecord,
    task: SandboxTask,
    fingerprint: string,
    idempotencyKey: string,
    denialClass: "policy" | "budget" | "capability",
    code: "POLICY_DENIED" | "BUDGET_EXCEEDED" | "CAPABILITY_UNAVAILABLE",
    reason: string,
    budgetOperationId: string | null,
  ): Promise<never> => {
    const sandboxId = deps.generateId();
    const deniedAt = iso();
    const metadata: SandboxRuntimeMetadata = {
      kind: environment.kind,
      environmentId: environment.id,
      environmentDigest: environment.specDigest,
      task,
      limits: environment.spec.limits,
      network: environment.spec.network,
      filesystem: environment.spec.filesystem,
      secretRefs: [...environment.spec.secrets.secretRefs],
      runtime: environment.spec.runtime,
      policyEvidence: null,
      capabilitySatisfaction: null,
      budgetOperationId,
    };
    const claim = await store.insertSandbox({
      id: sandboxId,
      applicationId,
      tenantId,
      executionId,
      sandboxKey: idempotencyKey,
      requestFingerprint: fingerprint,
      environmentId: environment.id,
      kind: environment.kind,
      status: "denied",
      runtimeMetadata: metadata as unknown as Readonly<Record<string, unknown>>,
      denialClass,
      denialCode: code,
      denialReason: reason,
      budgetOperationId,
      createdAt: deniedAt,
    });
    if (claim.claimed) {
      // Denied rows are insert-only terminal rows: no sequence binding is
      // written back (the envelope is findable by reference.sandboxId);
      // replays converge without a second envelope because the event
      // append is idempotent per key.
      await appendLedgerEvent(
        claim.record,
        "sandbox-denied",
        {
          denied: true,
          denialClass,
          code,
          reason,
        },
        { bind: undefined },
      );
    }
    throw new PlatformError({
      code,
      message: `sandbox admission denied (${denialClass}): ${reason}`,
      details: {
        sandboxId: claim.record.id,
        denialClass,
        reason,
        ...(budgetOperationId === null ? {} : { budgetOperationId }),
      },
    });
  };

  const createSandboxExecution = async (
    input: SandboxCreateInput,
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<SandboxExecutionRecord> => {
    // ----- 0. Pure request validation (no durable writes, no authority
    // calls; failures never claim the idempotency key). ---------------------
    if (!isUuid(input?.executionId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox creation requires a valid executionId (the parent execution)",
      });
    }
    if (!isUuid(input?.environmentId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox creation requires a valid environmentId (the compute environment)",
      });
    }
    if (!isUuid(actor.actorId) || !isUuid(actor.tenantId) || !isUuid(actor.applicationId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox creation requires a server-derived actor scope",
      });
    }
    if (typeof idempotencyKey !== "string" || !SANDBOX_KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox creation requires a non-empty printable idempotency key (max 200 chars)",
      });
    }
    const taskCheck = validateSandboxTask(input?.task);
    if (!taskCheck.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid sandbox task: ${taskCheck.reason}`,
      });
    }
    const task: SandboxTask = {
      command: input.task.command,
      args: [...input.task.args],
      publicEnv: { ...input.task.publicEnv },
    };

    const fingerprint = sandboxRequestFingerprint(
      actor.applicationId,
      input.executionId,
      actor.actorId,
      { executionId: input.executionId, environmentId: input.environmentId, task },
    );

    // ----- 1. Idempotent replay fast path. -----------------------------------
    const existing = await store.findSandboxByKey(actor.applicationId, idempotencyKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          details: { sandboxId: existing.id, environmentId: existing.environmentId },
        });
      }
      if (isTerminalSandboxStatus(existing.status)) {
        return replayOutcome(existing, true);
      }
      // admitted (or dispatching from a prior create that crashed between
      // the bundle and the envelope): converge — repair the admitted
      // envelope binding, then replay the committed state.
      if (existing.status === "admitted" && existing.ledgerAdmittedSequence === null) {
        const appended = await appendLedgerEvent(
          existing,
          "sandbox-admitted",
          admittedPayload(existing),
        );
        await store.bindLedgerSequence({
          applicationId: existing.applicationId,
          sandboxKey: existing.sandboxKey,
          phase: "admitted",
          sequence: appended.sequence,
        });
      }
      return replayOutcome(
        (await store.findSandboxByKey(actor.applicationId, idempotencyKey)) ?? existing,
        true,
      );
    }

    // ----- 2. Identity/tenant + execution binding (§7 step 1). --------------
    const execution = await ledger.getExecution(actor.applicationId, input.executionId);
    if (execution === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "execution not found in this application (missing or owned by another application)",
        details: { executionId: input.executionId },
      });
    }
    if (execution.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution belongs to a different tenant",
        details: { executionId: input.executionId },
      });
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no sandbox may be admitted on it`,
        details: { executionId: input.executionId, status: execution.status },
      });
    }

    // ----- 3. Environment resolution (the catalog). --------------------------
    const environment = await store.findEnvironment(actor.applicationId, input.environmentId);
    if (environment === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message:
          "compute environment not found in this application (missing or owned by another application)",
        details: { environmentId: input.environmentId },
      });
    }
    if (environment.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "compute environment belongs to a different tenant",
        details: { environmentId: environment.id },
      });
    }
    if (environment.status !== "available") {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `compute environment is not available for admission (status: ${environment.status})`,
        details: { environmentId: environment.id, status: environment.status },
      });
    }

    // ----- 4. POLICY admission (the gate — before anything durable). --------
    const decision = await admission.admit({
      tenantId: execution.tenantId,
      applicationId: actor.applicationId,
      executionId: input.executionId,
      kind: environment.kind,
      hosts: [...environment.spec.network.allowedHosts],
      secretRefs: [...environment.spec.secrets.secretRefs],
    });
    if (!decision.allowed) {
      await denySandbox(
        actor.applicationId,
        execution.tenantId,
        input.executionId,
        environment,
        task,
        fingerprint,
        idempotencyKey,
        "policy",
        "POLICY_DENIED",
        decision.reason,
        null,
      );
    }
    const policyEvidence: SandboxPolicyEvidence | null =
      "evidence" in decision && decision.evidence !== undefined ? decision.evidence : null;

    // ----- 5. CAPABILITY admission (the capabilities authority). -------------
    const runtime: SandboxRuntimeRequirement | null = environment.spec.runtime;
    let capabilitySatisfaction: string | null = null;
    if (runtime !== null) {
      const resolution = await capabilities.resolve({
        requirements: [
          {
            id: runtime.capabilityId,
            kind: "runtime",
            ...(runtime.minVersion === undefined ? {} : { minVersion: runtime.minVersion }),
          },
        ],
      });
      if (!resolution.satisfied) {
        const unmet = resolution.unmet
          .map((entry) => `${entry.requirementId}(${entry.reason})`)
          .join(", ");
        await denySandbox(
          actor.applicationId,
          execution.tenantId,
          input.executionId,
          environment,
          task,
          fingerprint,
          idempotencyKey,
          "capability",
          "CAPABILITY_UNAVAILABLE",
          `runtime capability requirement cannot be satisfied: ${unmet}`,
          null,
        );
      }
      const satisfaction = resolution.satisfied ? resolution.satisfactions[0] : undefined;
      capabilitySatisfaction =
        satisfaction === undefined
          ? null
          : `${satisfaction.claimId}@${satisfaction.claimVersion} (${satisfaction.evidenceKind}:${satisfaction.evidenceReference})`;
    }

    // ----- 6. BUDGET/resource admission (fail-closed for costed compute). ----
    const costed = environment.spec.cost.estimatedCostMicroUsd !== "0";
    const budgetOperationId = costed ? `sandbox-execution:${idempotencyKey}` : null;
    if (costed && budgetAuthority === undefined) {
      await denySandbox(
        actor.applicationId,
        execution.tenantId,
        input.executionId,
        environment,
        task,
        fingerprint,
        idempotencyKey,
        "budget",
        "BUDGET_EXCEEDED",
        "environment declares a non-zero cost estimate but no budget authority is wired; costed compute never executes unbudgeted",
        null,
      );
    }
    if (costed && budgetAuthority !== undefined) {
      try {
        await budgetAuthority.reserve(
          {
            actorId: actor.actorId,
            applicationId: actor.applicationId,
            tenantId: execution.tenantId,
            executionId: input.executionId,
            operationId: budgetOperationId ?? `sandbox-execution:${idempotencyKey}`,
            userId: execution.userId ?? "",
            amountMicroUsd: environment.spec.cost.estimatedCostMicroUsd,
          },
          idempotencyKey,
        );
      } catch (error) {
        if (error instanceof PlatformError && error.code === "BUDGET_EXCEEDED") {
          await denySandbox(
            actor.applicationId,
            execution.tenantId,
            input.executionId,
            environment,
            task,
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

    // ----- 7. Durable admission bundle (ONE identity, immutable metadata). ---
    const sandboxId = deps.generateId();
    const metadata: SandboxRuntimeMetadata = {
      kind: environment.kind,
      environmentId: environment.id,
      environmentDigest: environment.specDigest,
      task,
      limits: environment.spec.limits,
      network: environment.spec.network,
      filesystem: environment.spec.filesystem,
      secretRefs: [...environment.spec.secrets.secretRefs],
      runtime: environment.spec.runtime,
      policyEvidence,
      capabilitySatisfaction,
      budgetOperationId,
    };
    const claim = await store.insertSandbox({
      id: sandboxId,
      applicationId: actor.applicationId,
      tenantId: execution.tenantId,
      executionId: input.executionId,
      sandboxKey: idempotencyKey,
      requestFingerprint: fingerprint,
      environmentId: environment.id,
      kind: environment.kind,
      status: "admitted",
      runtimeMetadata: metadata as unknown as Readonly<Record<string, unknown>>,
      denialClass: null,
      denialCode: null,
      denialReason: null,
      budgetOperationId,
      createdAt: iso(),
    });
    if (!claim.claimed) {
      // A concurrent duplicate owns the key: converge on its committed state.
      return replayOutcome(claim.record, true);
    }
    let record = claim.record;

    // ----- 8. Ledger admission evidence (idempotent per sandbox identity). ---
    const appended = await appendLedgerEvent(record, "sandbox-admitted", admittedPayload(record));
    record =
      (await store.bindLedgerSequence({
        applicationId: record.applicationId,
        sandboxKey: record.sandboxKey,
        phase: "admitted",
        sequence: appended.sequence,
      })) ?? record;
    return record;
  };

  const admittedPayload = (record: SandboxExecutionRecord): Readonly<Record<string, unknown>> => ({
    task: {
      command: record.runtimeMetadata.task.command,
      args: [...record.runtimeMetadata.task.args],
      publicEnv: { ...record.runtimeMetadata.task.publicEnv },
    },
    limits: record.runtimeMetadata.limits,
    network: record.runtimeMetadata.network,
    filesystem: record.runtimeMetadata.filesystem,
    secretRefs: [...record.runtimeMetadata.secretRefs],
    runtime: record.runtimeMetadata.runtime,
    policyEvidence: record.runtimeMetadata.policyEvidence,
    capabilitySatisfaction: record.runtimeMetadata.capabilitySatisfaction,
    budgetOperationId: record.runtimeMetadata.budgetOperationId,
  });

  /** Replay a committed record as the caller-visible outcome. */
  const replayOutcome = (
    record: SandboxExecutionRecord,
    replayed: boolean,
  ): SandboxExecutionRecord => {
    void replayed;
    if (record.status === "denied") {
      // Journal-then-fail: the denial is durable; the same logical request
      // replays the same typed canonical denial.
      throw new PlatformError({
        code: record.denialCode ?? "SANDBOX_ERROR",
        message:
          `sandbox admission was denied (${record.denialClass}): ${record.denialReason ?? ""}`.trim(),
        details: {
          sandboxId: record.id,
          denialClass: record.denialClass,
          reason: record.denialReason,
        },
      });
    }
    return record;
  };

  const dispatchSandboxExecution = async (
    input: { readonly applicationId: string; readonly sandboxId: string },
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<SandboxExecutionRecord> => {
    if (!isUuid(input?.applicationId) || !isUuid(input?.sandboxId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox dispatch requires applicationId and sandboxId",
      });
    }
    if (!isUuid(actor.actorId) || !isUuid(actor.tenantId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox dispatch requires a server-derived actor scope",
      });
    }

    // ----- 1. Scope-guarded resolution (single-dispatch semantics: the row
    // itself is the idempotency anchor — a sandbox executes ONCE). ----------
    const found = await store.findSandbox(input.applicationId, input.sandboxId);
    if (found === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "sandbox not found in this application (missing or owned by another application)",
        details: { sandboxId: input.sandboxId },
      });
    }
    if (found.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "sandbox belongs to a different tenant",
        details: { sandboxId: found.id },
      });
    }
    if (found.status === "denied") {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "a denied sandbox cannot be dispatched",
        details: { sandboxId: found.id },
      });
    }
    if (isTerminalSandboxStatus(found.status)) {
      // completed/failed: the FIRST dispatch's outcome IS the durable
      // outcome — every later dispatch replays it (no re-execution).
      return found;
    }
    if (found.status === "dispatching") {
      // Honest unknown outcome from a prior attempt that crashed between
      // the durable claim and the outcome (§14): sandbox code execution
      // cannot be proven idempotent — fail closed instead of re-executing.
      throw new PlatformError({
        code: "NON_CONVERGENT_EXTERNAL_EFFECT",
        message:
          "a previous dispatch of this sandbox left an unknown external outcome (dispatching); the sandbox fails closed instead of re-executing",
        details: { sandboxId: found.id },
      });
    }

    // ----- 2. Parent-execution re-check (a terminal execution runs nothing).
    const execution = await ledger.getExecution(found.applicationId, found.executionId);
    if (execution === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "parent execution not found in this application",
        details: { executionId: found.executionId },
      });
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no sandbox may dispatch on it`,
        details: { executionId: found.executionId, status: execution.status },
      });
    }

    // ----- 3. Durable intent (one-shot admitted → dispatching claim). --------
    const claim = await store.claimDispatching(found.applicationId, found.sandboxKey);
    const record = claim.claimed ? claim.record : claim.record;
    if (!claim.claimed) {
      if (isTerminalSandboxStatus(record.status)) {
        return record; // a concurrent dispatcher finalized first — replay it
      }
      if (record.status === "dispatching") {
        throw new PlatformError({
          code: "NON_CONVERGENT_EXTERNAL_EFFECT",
          message:
            "a concurrent dispatch owns this sandbox and is still dispatching; sandbox execution fails closed instead of double-dispatching",
          details: { sandboxId: record.id },
        });
      }
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `sandbox cannot dispatch from status ${record.status}`,
        details: { sandboxId: record.id, status: record.status },
      });
    }
    const dispatchedAt = iso();
    const started = Date.now();

    // ----- 4. Runtime resolution from the IMMUTABLE admitted snapshot. ------
    const metadata = record.runtimeMetadata;
    const spec: SandboxRuntimeSpec = {
      sandboxId: record.id,
      applicationId: record.applicationId,
      tenantId: record.tenantId,
      executionId: record.executionId,
      kind: metadata.kind,
      task: metadata.task,
      limits: metadata.limits,
      network: metadata.network,
      filesystem: metadata.filesystem,
      secretRefs: [...metadata.secretRefs],
    };

    let observation: SandboxExecutionObservation;
    if (!kindExecutes(metadata.kind)) {
      // NO-EXECUTION IS FIRST CLASS (M17): nothing runs — no provider is
      // consulted, no runtime is required; the sandbox completes
      // structurally with the honest no-execution observation.
      observation = {
        outcomeClass: "sandbox-success",
        outputDigest: null,
        output: { noExecution: true },
        usageMicroUsd: "0",
        failure: null,
      };
    } else {
      // Capability-before-provider held at admission; the provider registry
      // is dispatch infrastructure: an unwired substrate FAILS CLOSED.
      const provider = providers.providerFor(metadata.kind);
      if (provider === null) {
        const failure = {
          outcomeClass: "sandbox-failure" as const,
          outputDigest: null,
          output: null,
          usageMicroUsd: null,
          failure: {
            failureClass: "runtime-unavailable" as const,
            message: `no runtime provider is wired for environment kind "${metadata.kind}"; the sandbox fails closed rather than executing without the required isolation substrate`,
            retryable: false,
          },
        };
        return finalize(record, failure, dispatchedAt, started);
      }
      const timeoutMs = metadata.limits?.executionTimeoutMs ?? 60_000;
      try {
        observation = await withTimeout(provider.execute(spec), timeoutMs);
      } catch (error) {
        // A thrown error is a sandbox-axis failure (typed SANDBOX_ERROR
        // upstream); policy/capability/budget denials were decided BEFORE
        // dispatch by the authorities and never take this path.
        const timedOut =
          error instanceof PlatformError &&
          error.details !== undefined &&
          (error.details as Record<string, unknown>).timeoutMs === timeoutMs;
        observation = {
          outcomeClass: "sandbox-failure",
          outputDigest: null,
          output: null,
          usageMicroUsd: null,
          failure: {
            failureClass: timedOut ? "timeout" : "adapter-error",
            message: error instanceof Error ? error.message : String(error),
            retryable: timedOut,
          },
        };
      }
    }

    return finalize(record, observation, dispatchedAt, started);
  };

  /** Post-execution half: evidence envelope → guarded finalization → budget. */
  const finalize = async (
    claimed: SandboxExecutionRecord,
    observation: SandboxExecutionObservation,
    dispatchedAt: string,
    started: number,
  ): Promise<SandboxExecutionRecord> => {
    const completedAt = iso();
    const durationMs = Date.now() - started;
    const status: "completed" | "failed" =
      observation.outcomeClass === "sandbox-success" ? "completed" : "failed";

    // Ledger completion evidence FIRST (deterministic payload; idempotent
    // per sandbox identity): appending before the row finalizes keeps the
    // binding writable (terminal rows are immutable) and makes a terminal
    // row WITHOUT its completion event unreachable — a crash after the
    // event leaves the row honestly `dispatching`.
    let completedSequence: number | null = null;
    const current =
      (await store.findSandboxByKey(claimed.applicationId, claimed.sandboxKey)) ?? claimed;
    if (current.ledgerCompletedSequence === null) {
      try {
        const appended = await appendLedgerEvent(current, "sandbox-completed", {
          outcomeClass: observation.outcomeClass,
          status,
          outputDigest: observation.outputDigest,
          ...(observation.failure === null
            ? {}
            : {
                failureClass: observation.failure.failureClass,
                failureMessage: observation.failure.message,
              }),
          ...(observation.usageMicroUsd === null
            ? {}
            : { usageMicroUsd: observation.usageMicroUsd }),
        });
        completedSequence = appended.sequence;
      } catch (error) {
        if (!isIdempotencyReuse(error)) {
          throw error;
        }
        // The winner's envelope already recorded this logical completion;
        // converge (the envelope is findable by reference.sandboxId).
      }
    } else {
      completedSequence = current.ledgerCompletedSequence;
    }

    // Guarded outcome recording (first writer wins; duplicates converge).
    const finalized = await store.recordOutcome({
      applicationId: claimed.applicationId,
      sandboxKey: claimed.sandboxKey,
      status,
      outcomeClass: observation.outcomeClass,
      failureClass: observation.failure?.failureClass ?? null,
      failureMessage: observation.failure?.message ?? null,
      retryable: observation.failure?.retryable ?? false,
      outputDigest: observation.outputDigest,
      usageMicroUsd: observation.usageMicroUsd ?? null,
      dispatchedAt,
      completedAt,
      durationMs,
      completedLedgerSequence: completedSequence,
    });

    // Budget settlement: actual usage once on success; release the unspent
    // hold on failure (idempotent per operationId; reconciliation by key —
    // the replay fast path re-attempts it on crash).
    if (budgetAuthority !== undefined && finalized.budgetOperationId !== null) {
      try {
        if (finalized.status === "completed") {
          await budgetAuthority.settle(
            {
              actorId: claimed.id,
              applicationId: claimed.applicationId,
              tenantId: finalized.tenantId,
              operationId: finalized.budgetOperationId,
              actualAmountMicroUsd: finalized.usageMicroUsd ?? "0",
            },
            `${finalized.sandboxKey}:settle`,
          );
        } else {
          await budgetAuthority.release(
            {
              actorId: claimed.id,
              applicationId: claimed.applicationId,
              tenantId: finalized.tenantId,
              operationId: finalized.budgetOperationId,
            },
            `${finalized.sandboxKey}:release`,
          );
        }
      } catch {
        // Settlement/release is idempotent per operationId; a failure here
        // must not erase the durable sandbox outcome.
      }
    }
    return finalized;
  };

  return {
    createSandboxExecution,
    dispatchSandboxExecution,
    async getSandbox(applicationId, sandboxId) {
      return store.findSandbox(applicationId, sandboxId);
    },
    async listSandboxesByExecution(applicationId, executionId) {
      return store.listSandboxesByExecution(applicationId, executionId);
    },
  };
}

export { isSandboxExecutionStatus };
