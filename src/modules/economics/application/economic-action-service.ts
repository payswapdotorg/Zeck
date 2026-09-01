/**
 * Economic action service (economics module application; WORK-032,
 * ECO-001..ECO-008; ADR-0018).
 *
 * THE GOVERNED ECONOMIC-ACTION BOUNDARY — the implementation principle
 * made executable:
 *
 * ```text
 * Agent/Developer intent (createEconomicAction — intent ONLY)
 *   -> Policy (REQUIRED admission port — the hard authorization boundary)
 *   -> Capability admission (REQUIRED port — the capabilities authority)
 *   -> Budget reservation (the budgets module's BudgetAuthority — the
 *      canonical spending-control authority; ONE reservation operation
 *      per action, `econ-<actionId>`, so double-counting and a second
 *      financial ledger are unrepresentable)
 *   -> Bounded payment authorization issuance (authorize — constraints
 *      hard-pinned from the intent)
 *   -> Payment rail adapter (charge — injected per call, replaceable,
 *      refused when it cannot express the required safety constraints)
 *   -> Settlement correlation (charge/recordExternalSettlement —
 *      correlated external evidence, never a Zeck truth source)
 *   -> Delivery evidence (recordDeliveryObservation — evidence for the
 *      verification authority, which ALONE decides whether delivery
 *      happened)
 *   -> Evidence (append-only per-action event ledger + the canonical
 *      executions ledger through the executions step-event seam)
 *   -> Learning (economicOutcomeFacts — pure neutral projection; the
 *      admission chain has NO learning input at all)
 * ```
 *
 * NOT `Agent -> Stripe API`: no rail is named in the core contracts, no
 * credential crosses any boundary, no LLM evaluates a deterministic
 * constraint, and no external side effect happens before the full
 * policy -> capability -> budget chain has authorized the action.
 *
 * Ordering is mechanical: the rail charge is reachable ONLY from the
 * `authorized` action status (which is reachable only through the full
 * admission chain), the durable `executing` transition + dispatched
 * event commit BEFORE the rail call (journal-then-dispatch), and every
 * use of a bounded authorization is re-evaluated deterministically
 * (substitution/replay firewall — `evaluateAuthorizationUse`).
 *
 * Idempotency (`spec/contracts.md` "Idempotency response rule"): every
 * mutating operation carries a caller key; the durable idempotency
 * record commits atomically with the guarded writes; same key + same
 * fingerprint replays, same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`, concurrent duplicates converge through the
 * store's unique-index arbitration.
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type { RecordStepEventInput } from "../../executions/public";
import { constraintsOfAction, evaluateAuthorizationUse } from "../domain/authorization";
import type { EconomicCapabilityRequirement } from "../domain/capabilities";
import type { EconomicActionDraft, EconomicActionRecord } from "../domain/economic-action";
import {
  economicActionCanTransition,
  economicActionFingerprintParts,
  validateEconomicActionDraft,
} from "../domain/economic-action";
import { economicOutcomeFacts } from "../domain/learning-facts";
import type { RailSettlementObservation } from "../domain/rail";
import { railCanExpressConstraints } from "../domain/rail";
import type {
  EconomicCurrency,
  EconomicPurpose,
  RecipientKind,
  RecipientReference,
} from "../domain/vocabulary";
import { canonicalEconomicFingerprint, type EconomicsTx } from "../ports/economic-idempotency";
import type {
  EconomicActionService,
  EconomicActionServiceDeps,
  EconomicCommandScope,
} from "./economic-action-service.contracts";

export type {
  AuthorizeEconomicActionCommand,
  AuthorizeEconomicActionOutcome,
  ChargeEconomicActionCommand,
  ChargeEconomicActionOutcome,
  CreateEconomicActionCommand,
  CreateEconomicActionOutcome,
  EconomicActionService,
  EconomicActionServiceDeps,
  EconomicCommandScope,
  EconomicDeliveryEvidenceBundle,
  EconomicExecutionLedger,
  RecordDeliveryObservationCommand,
  RecordDeliveryOutcome,
  RecordExternalSettlementCommand,
  RecordExternalSettlementOutcome,
} from "./economic-action-service.contracts";

/** The single reservation operation prefix: one budget hold per action. */
const RESERVATION_OPERATION_PREFIX = "econ-";

const CREATE_OPERATION = "economics.create-action";
const AUTHORIZE_OPERATION = "economics.authorize-action";
const CHARGE_OPERATION = "economics.charge-action";
const EXTERNAL_SETTLEMENT_OPERATION = "economics.record-external-settlement";
const DELIVERY_OPERATION = "economics.record-delivery";

export function createEconomicActionService(
  deps: EconomicActionServiceDeps,
): EconomicActionService {
  const { store, idempotency, policy, capabilities, budget, executions, generateId, now } = deps;

  const iso = () => now().toISOString();

  const validationError = (message: string): PlatformError =>
    new PlatformError({ code: "CAPABILITY_UNAVAILABLE", message });

  const assertTenantRow = (command: EconomicCommandScope, row: { tenantId: string }): void => {
    if (row.tenantId !== command.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "economic action belongs to a different tenant",
        details: { applicationId: command.applicationId },
      });
    }
  };

  /** Journal one economics-domain event on the action's own append-only ledger. */
  const journal = async (
    tx: EconomicsTx,
    action: Pick<EconomicActionRecord, "id" | "applicationId" | "tenantId">,
    type: string,
    cause: string,
    reference: Readonly<Record<string, unknown>>,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const events = await tx.store.listEvents(action.applicationId, action.id);
    const sequence = events.length + 1;
    await tx.store.appendEvent({
      eventId: generateId(),
      economicActionId: action.id,
      applicationId: action.applicationId,
      tenantId: action.tenantId,
      sequence,
      type,
      cause,
      reference,
      payload,
      occurredAt: iso(),
    });
  };

  /**
   * Mirror the material boundary events onto the canonical executions
   * ledger (executions-owned step-event vocabulary; its own idempotency
   * arbitration converges on retries; its own scope enforcement binds the
   * action to its execution/application/tenant identity).
   */
  const journalToExecutionLedger = async (
    command: EconomicCommandScope,
    action: Pick<EconomicActionRecord, "id" | "executionId" | "applicationId">,
    ledgerCommand: RecordStepEventInput["command"],
    cause: string,
    reference: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
  ): Promise<void> => {
    await executions.recordStepEvent(
      {
        executionId: action.executionId,
        applicationId: action.applicationId,
        actor: { actorId: command.actorId, tenantId: command.tenantId },
        command: ledgerCommand,
        cause,
        reference: { economicActionId: action.id, ...reference },
        payload: { economicActionId: action.id },
      },
      `${idempotencyKey}:execution-ledger`,
    );
  };

  return {
    async createEconomicAction(command, idempotencyKey) {
      const draft: EconomicActionDraft = {
        applicationId: command.applicationId,
        tenantId: command.tenantId,
        executionId: command.executionId,
        proposedBy: command.actorId,
        purpose: command.purpose as EconomicPurpose,
        recipient: {
          kind: command.recipient.kind as RecipientKind,
          id: command.recipient.id,
        } as RecipientReference,
        amount: command.amount,
        currency: command.currency as EconomicCurrency,
        expiresAt: command.expiresAt,
        requiredCapabilities:
          command.requiredCapabilities as readonly EconomicCapabilityRequirement[],
        ...(command.railPreference === undefined ? {} : { railPreference: command.railPreference }),
        ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
      };
      if (!isUuid(command.executionId)) {
        throw validationError("executionId must be a valid execution identity");
      }
      const issues = validateEconomicActionDraft(draft, now());
      if (issues.length > 0) {
        throw validationError(
          `economic action draft rejected: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`,
        );
      }
      const fingerprint = canonicalEconomicFingerprint(economicActionFingerprintParts(draft));
      const actionId = generateId();
      const createdAt = iso();

      const work = async (tx: EconomicsTx): Promise<{ actionId: string }> => {
        // Execution binding + identity evidence on the canonical ledger
        // FIRST (its scope enforcement is the tenant/application check).
        await journalToExecutionLedger(
          command,
          { id: actionId, executionId: command.executionId, applicationId: command.applicationId },
          "economic-action-recorded",
          "economic-intent",
          { status: "proposed", purpose: command.purpose },
          idempotencyKey,
        );
        const action = await tx.store.insertEconomicAction({
          id: actionId,
          applicationId: command.applicationId,
          tenantId: command.tenantId,
          executionId: command.executionId,
          proposedBy: command.actorId,
          purpose: command.purpose,
          recipientKind: command.recipient.kind,
          recipientId: command.recipient.id,
          amountKind: command.amount.kind,
          amountMinMicroUsd:
            command.amount.kind === "exact" ? command.amount.microUsd : command.amount.minMicroUsd,
          amountMaxMicroUsd:
            command.amount.kind === "exact" ? command.amount.microUsd : command.amount.maxMicroUsd,
          currency: command.currency,
          expiresAt: command.expiresAt,
          requiredCapabilities: command.requiredCapabilities as Readonly<Record<string, unknown>[]>,
          railPreference: command.railPreference ?? null,
          metadata: command.metadata ?? {},
          status: "proposed",
          idempotencyKey,
          createdAt,
          updatedAt: createdAt,
        });
        await journal(
          tx,
          action,
          "action.recorded",
          "economic-intent",
          { executionId: action.executionId, purpose: action.purpose },
          { status: "proposed" },
        );
        return { actionId: action.id };
      };

      const { outcome, replayed } = await idempotency.arbitrate(
        { actorId: command.actorId, applicationId: command.applicationId },
        CREATE_OPERATION,
        idempotencyKey,
        fingerprint,
        work,
      );
      const action = await store.getEconomicAction(command.applicationId, outcome.actionId);
      if (action === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "created economic action row disappeared (rows are never deleted)",
        });
      }
      return { action, replayed };
    },

    async authorizeEconomicAction(command, idempotencyKey) {
      if (!isUuid(command.economicActionId)) {
        throw validationError("economicActionId must be a valid identity");
      }
      const fingerprint = canonicalEconomicFingerprint([
        AUTHORIZE_OPERATION,
        command.applicationId,
        command.economicActionId,
      ]);
      const authorizationId = generateId();

      const work = async (
        tx: EconomicsTx,
      ): Promise<{
        authorizationId: string | null;
        denied?: { cause: "policy" | "capability" | "budget"; reason: string };
      }> => {
        const action = await tx.store.getEconomicAction(
          command.applicationId,
          command.economicActionId,
        );
        if (action === null) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message:
              "economic action not found in this application (missing or owned by another application)",
            details: { economicActionId: command.economicActionId },
          });
        }
        assertTenantRow(command, action);
        if (!economicActionCanTransition(action.status, "authorized")) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: `economic action is ${action.status}; only a proposed action can be authorized`,
            details: { economicActionId: action.id, status: action.status },
          });
        }
        // Expired intents never authorize (lazy expiry — deterministic).
        if (Date.parse(action.expiresAt) <= now().getTime()) {
          const expired = await tx.store.transitionEconomicAction(
            command.applicationId,
            action.id,
            ["proposed"],
            "expired",
            { updatedAt: iso() },
          );
          await journal(
            tx,
            expired,
            "authorization.expired",
            "platform",
            { status: "expired" },
            {
              status: "expired",
            },
          );
          return { authorizationId: null };
        }

        // 1. POLICY — the hard authorization boundary, consulted FIRST.
        const policyDecision = await policy.evaluate({ action, actorId: command.actorId });
        if (!policyDecision.allowed) {
          const reason = policyDecision.reason ?? "policy admission denied the economic action";
          const deniedAction = await tx.store.transitionEconomicAction(
            command.applicationId,
            action.id,
            ["proposed"],
            "denied",
            {
              updatedAt: iso(),
              metadata: { ...action.metadata, denialCause: "policy", denialReason: reason },
            },
          );
          await journal(
            tx,
            deniedAction,
            "action.denied",
            "policy",
            { denied: true, reason },
            {
              denied: true,
              cause: "policy",
              reason,
            },
          );
          await journalToExecutionLedger(
            command,
            deniedAction,
            "economic-action-denied",
            "policy",
            { denied: true, reason },
            idempotencyKey,
          );
          return { authorizationId: null, denied: { cause: "policy", reason } };
        }

        // 2. CAPABILITY — the capability authority resolves the action's
        //    required capabilities before any money is held.
        const capabilityDecision = await capabilities.resolve({ action, actorId: command.actorId });
        if (!capabilityDecision.satisfied) {
          const reason = `required capabilities unmet: ${capabilityDecision.unmet.join(", ")}`;
          const deniedAction = await tx.store.transitionEconomicAction(
            command.applicationId,
            action.id,
            ["proposed"],
            "denied",
            {
              updatedAt: iso(),
              metadata: { ...action.metadata, denialCause: "capability", denialReason: reason },
            },
          );
          await journal(
            tx,
            deniedAction,
            "action.denied",
            "capability",
            { denied: true, reason },
            {
              denied: true,
              cause: "capability",
              reason,
            },
          );
          await journalToExecutionLedger(
            command,
            deniedAction,
            "economic-action-denied",
            "capability",
            { denied: true, reason },
            idempotencyKey,
          );
          return { authorizationId: null, denied: { cause: "capability", reason } };
        }

        // 3. BUDGET — the canonical spending-control authority: ONE
        //    reservation operation per action (`econ-<actionId>`), ceiling =
        //    the action's maximum amount. The budgets module owns all
        //    arbitration; a denial fails closed here (journal-then-fail).
        const reservationOperationId = `${RESERVATION_OPERATION_PREFIX}${action.id}`;
        try {
          await budget.reserve(
            {
              actorId: command.actorId,
              applicationId: command.applicationId,
              tenantId: action.tenantId,
              executionId: action.executionId,
              operationId: reservationOperationId,
              amountMicroUsd:
                action.amount.kind === "exact" ? action.amount.microUsd : action.amount.maxMicroUsd,
            },
            `${idempotencyKey}:reserve`,
          );
        } catch (error) {
          if (error instanceof PlatformError && error.code === "BUDGET_EXCEEDED") {
            const reason = error.message;
            const deniedAction = await tx.store.transitionEconomicAction(
              command.applicationId,
              action.id,
              ["proposed"],
              "denied",
              {
                updatedAt: iso(),
                metadata: { ...action.metadata, denialCause: "budget", denialReason: reason },
              },
            );
            await journal(
              tx,
              deniedAction,
              "action.denied",
              "budget",
              { denied: true, reason },
              {
                denied: true,
                cause: "budget",
                reason,
              },
            );
            await journalToExecutionLedger(
              command,
              deniedAction,
              "economic-action-denied",
              "budget",
              { denied: true, reason },
              idempotencyKey,
            );
            return { authorizationId: null, denied: { cause: "budget", reason } };
          }
          throw error;
        }

        // 4. AUTHORIZATION ISSUANCE — only after the full chain.
        const issuedAt = iso();
        const constraints = constraintsOfAction(action);
        const authorization = await tx.store.insertAuthorization({
          id: authorizationId,
          economicActionId: action.id,
          applicationId: action.applicationId,
          tenantId: action.tenantId,
          constraints: constraints as unknown as Readonly<Record<string, unknown>>,
          status: "active",
          reservationOperationId,
          admissionEvidence:
            (policyDecision.evidence as unknown as Readonly<Record<string, unknown>> | undefined) ??
            {},
          issuedAt,
          expiresAt: action.expiresAt,
          createdAt: issuedAt,
        });
        const authorizedAction = await tx.store.transitionEconomicAction(
          command.applicationId,
          action.id,
          ["proposed"],
          "authorized",
          { updatedAt: issuedAt },
        );
        await journal(
          tx,
          authorizedAction,
          "authorization.issued",
          "platform",
          {
            authorizationId: authorization.id,
            reservationOperationId,
            policy: policyDecision.evidence,
          },
          { status: "authorized", authorizationId: authorization.id },
        );
        await journalToExecutionLedger(
          command,
          authorizedAction,
          "economic-action-authorized",
          "platform",
          { authorizationId: authorization.id, reservationOperationId },
          idempotencyKey,
        );
        return { authorizationId: authorization.id };
      };

      const { outcome, replayed } = await idempotency.arbitrate(
        { actorId: command.actorId, applicationId: command.applicationId },
        AUTHORIZE_OPERATION,
        idempotencyKey,
        fingerprint,
        work,
      );

      // A durably-recorded denial surfaces as the typed canonical error
      // AFTER its records committed (journal-then-fail).
      if (outcome.denied !== undefined) {
        const code =
          outcome.denied.cause === "policy"
            ? "POLICY_DENIED"
            : outcome.denied.cause === "capability"
              ? "CAPABILITY_UNAVAILABLE"
              : "BUDGET_EXCEEDED";
        throw new PlatformError({
          code,
          message: `economic action authorization denied (${outcome.denied.cause}): ${outcome.denied.reason}`,
          details: { economicActionId: command.economicActionId, cause: outcome.denied.cause },
        });
      }
      const action = await store.getEconomicAction(command.applicationId, command.economicActionId);
      if (action === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "economic action row disappeared",
        });
      }
      if (outcome.authorizationId === null) {
        // Lazy-expiry path: the intent expired before authorization.
        if (action.status !== "expired") {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "authorization was not issued but the action is not expired",
          });
        }
        throw new PlatformError({
          code: "EXPIRED",
          message: "economic action expired before authorization",
          details: { economicActionId: action.id, expiresAt: action.expiresAt },
        });
      }
      const authorization = await store.getAuthorizationById(
        command.applicationId,
        outcome.authorizationId,
      );
      if (authorization === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "authorization row disappeared",
        });
      }
      return { action, authorization, replayed };
    },

    async chargeEconomicAction(command, rail, idempotencyKey) {
      if (!isUuid(command.economicActionId)) {
        throw validationError("economicActionId must be a valid identity");
      }
      // The rail is an injected, replaceable adapter: it must be able to
      // express the REQUIRED safety constraints or the charge fails
      // closed BEFORE anything happens (the fail-closed requirement).
      if (!railCanExpressConstraints(rail.capabilities)) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `payment rail "${rail.railId}" cannot express the required safety constraints (recipient pinning, amount ceiling, currency pinning, expiry) — failing closed`,
          details: { railId: rail.railId },
        });
      }
      const fingerprint = canonicalEconomicFingerprint([
        CHARGE_OPERATION,
        command.applicationId,
        command.economicActionId,
        rail.railId,
        command.amountMicroUsd ?? null,
      ]);
      const settlementId = generateId();

      const work = async (
        tx: EconomicsTx,
      ): Promise<{
        settlementId: string;
        authorizationId: string;
      }> => {
        const action = await tx.store.getEconomicAction(
          command.applicationId,
          command.economicActionId,
        );
        if (action === null) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message:
              "economic action not found in this application (missing or owned by another application)",
            details: { economicActionId: command.economicActionId },
          });
        }
        assertTenantRow(command, action);
        if (action.status !== "authorized") {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: `economic action is ${action.status}; only an authorized action can be charged (the full policy -> capability -> budget chain must precede any external side effect)`,
            details: { economicActionId: action.id, status: action.status },
          });
        }
        const authorization = await tx.store.getAuthorizationForAction(
          command.applicationId,
          action.id,
        );
        if (authorization === null) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: "authorized action carries no bounded payment authorization",
            details: { economicActionId: action.id },
          });
        }
        const amountMicroUsd =
          command.amountMicroUsd ??
          (action.amount.kind === "exact" ? action.amount.microUsd : undefined);
        if (amountMicroUsd === undefined) {
          throw validationError(
            "range-bounded economic actions require an explicit amountMicroUsd on charge",
          );
        }
        // DETERMINISTIC substitution/replay firewall (pure, no LLM).
        const evaluation = evaluateAuthorizationUse(
          authorization,
          {
            economicActionId: action.id,
            recipient: action.recipient,
            amountMicroUsd,
            currency: action.currency,
            purpose: action.purpose,
            executionId: action.executionId,
            applicationId: action.applicationId,
            tenantId: action.tenantId,
          },
          now(),
        );
        if (!evaluation.allowed) {
          await journal(
            tx,
            action,
            "payment.rejected",
            "authorization",
            { denied: true, code: evaluation.code },
            { denied: true, code: evaluation.code, detail: evaluation.detail },
          );
          throw new PlatformError({
            code:
              evaluation.code === "authorization-expired"
                ? "EXPIRED"
                : evaluation.code === "tenant-substitution"
                  ? "TENANT_SCOPE_VIOLATION"
                  : "AUTHORIZATION_DENIED",
            message: `bounded payment authorization refused the charge: ${evaluation.code} (${evaluation.detail})`,
            details: { code: evaluation.code, economicActionId: action.id },
          });
        }

        // JOURNAL-THEN-DISPATCH: the durable executing transition and the
        // dispatched event commit BEFORE the rail side effect.
        const dispatchedAt = iso();
        const executingAction = await tx.store.transitionEconomicAction(
          command.applicationId,
          action.id,
          ["authorized"],
          "executing",
          { updatedAt: dispatchedAt },
        );
        await journal(
          tx,
          executingAction,
          "payment.dispatched",
          "rail",
          { railId: rail.railId, authorizationId: authorization.id, amountMicroUsd },
          { railId: rail.railId, amountMicroUsd, status: "executing" },
        );

        // THE EXTERNAL SIDE EFFECT — after the full chain, inside the
        // same idempotent transaction; the rail's own idempotency key
        // (the correlation ref) converges retried charges.
        const observation: RailSettlementObservation = await rail.charge({
          economicActionId: action.id,
          authorizationId: authorization.id,
          recipient: action.recipient,
          amountMicroUsd,
          currency: action.currency,
          purpose: action.purpose,
          expiresAt: authorization.expiresAt,
          idempotencyKey: `${action.id}:${idempotencyKey}`,
          correlationRef: action.id,
        });

        // Correlate the settlement observation (external evidence).
        const settlement = await tx.store.insertSettlement({
          id: settlementId,
          economicActionId: action.id,
          authorizationId: authorization.id,
          applicationId: action.applicationId,
          tenantId: action.tenantId,
          railId: observation.railId,
          railTransactionRef: observation.railTransactionRef,
          status:
            observation.status === "succeeded"
              ? "confirmed"
              : observation.status === "failed"
                ? "failed"
                : "observed",
          settledAmountMicroUsd: observation.settledAmountMicroUsd,
          currency: observation.currency,
          observedAt: observation.observedAt,
          evidenceDigest: digestOfEvidence(observation.evidence),
          recordedAt: iso(),
        });
        await journal(
          tx,
          executingAction,
          "settlement.correlated",
          "rail",
          {
            settlementId: settlement.id,
            railId: settlement.railId,
            railTransactionRef: settlement.railTransactionRef,
            status: settlement.status,
          },
          { railTransactionRef: settlement.railTransactionRef, status: settlement.status },
        );

        // Budget settlement through THE authority (actual observed amount;
        // the budgets module owns exactly-once semantics). A failed charge
        // releases the unused hold once.
        if (observation.status === "succeeded") {
          await budget.settle(
            {
              actorId: command.actorId,
              applicationId: command.applicationId,
              tenantId: action.tenantId,
              operationId: authorization.reservationOperationId,
              actualAmountMicroUsd: observation.settledAmountMicroUsd,
            },
            `${idempotencyKey}:settle`,
          );
        } else {
          await budget.release(
            {
              actorId: command.actorId,
              applicationId: command.applicationId,
              tenantId: action.tenantId,
              operationId: authorization.reservationOperationId,
            },
            `${idempotencyKey}:release`,
          );
        }

        // Single-use authorization: consumed by exactly this charge.
        const consumedAuthorization = await tx.store.transitionAuthorization(
          command.applicationId,
          authorization.id,
          ["active"],
          "consumed",
          { consumedAt: iso() },
        );
        await journal(
          tx,
          executingAction,
          "authorization.consumed",
          "platform",
          { authorizationId: consumedAuthorization.id },
          { authorizationId: consumedAuthorization.id, status: "consumed" },
        );

        const terminalStatus = observation.status === "succeeded" ? "settled" : "failed";
        // JOURNAL-THEN-MUTATE for the terminal transition: the executions
        // ledger mirror rides the executions service's OWN transaction
        // (its own idempotency arbitration), so it must run BEFORE the
        // terminal row write — a SECOND in-transaction UPDATE of the
        // action row makes the arbitration transaction hold a FOR KEY
        // SHARE on the referenced executions row (PostgreSQL FK check),
        // which would block the ledger write's row lock and deadlock the
        // charge against itself on real PostgreSQL. The mirror is
        // status-preserving evidence (the executions lifecycle is never
        // moved by it), so journaling it first is exactly the
        // journal-then-dispatch discipline the charge path already uses.
        await journalToExecutionLedger(
          command,
          executingAction,
          terminalStatus === "settled" ? "economic-action-settled" : "economic-action-failed",
          "rail",
          { settlementId: settlement.id, railId: settlement.railId },
          idempotencyKey,
        );
        const terminalAction = await tx.store.transitionEconomicAction(
          command.applicationId,
          action.id,
          ["executing"],
          terminalStatus,
          { updatedAt: iso() },
        );
        await journal(
          tx,
          terminalAction,
          "settlement.correlated",
          "rail",
          { settlementId: settlement.id, finalStatus: terminalStatus },
          { finalStatus: terminalStatus },
        );
        return { settlementId: settlement.id, authorizationId: authorization.id };
      };

      const { outcome, replayed } = await idempotency.arbitrate(
        { actorId: command.actorId, applicationId: command.applicationId },
        CHARGE_OPERATION,
        idempotencyKey,
        fingerprint,
        work,
      );
      const action = await store.getEconomicAction(command.applicationId, command.economicActionId);
      const authorization = await store.getAuthorizationById(
        command.applicationId,
        outcome.authorizationId,
      );
      const settlement = await store.getSettlementForAction(
        command.applicationId,
        command.economicActionId,
      );
      if (action === null || authorization === null || settlement === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "charged action state disappeared",
        });
      }
      return { action, authorization, settlement, replayed };
    },

    async recordExternalSettlement(command, idempotencyKey) {
      if (!isUuid(command.economicActionId)) {
        throw validationError("economicActionId must be a valid identity");
      }
      const fingerprint = canonicalEconomicFingerprint([
        EXTERNAL_SETTLEMENT_OPERATION,
        command.applicationId,
        command.economicActionId,
        command.railId,
        command.railTransactionRef,
        command.status,
        command.settledAmountMicroUsd,
        command.currency,
        command.observedAt,
        command.evidenceDigest,
      ]);
      const settlementId = generateId();
      const work = async (tx: EconomicsTx): Promise<{ settlementId: string }> => {
        const action = await tx.store.getEconomicAction(
          command.applicationId,
          command.economicActionId,
        );
        if (action === null) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message:
              "economic action not found in this application (missing or owned by another application)",
            details: { economicActionId: command.economicActionId },
          });
        }
        assertTenantRow(command, action);
        const authorization = await tx.store.getAuthorizationForAction(
          command.applicationId,
          action.id,
        );
        // CORRELATED EVIDENCE ONLY (ECO-006): an externally observed
        // settlement NEVER settles the budget, consumes an authorization
        // or transitions the action — those are authority decisions, and
        // no external rail record is a second Zeck truth source.
        const settlement = await tx.store.insertSettlement({
          id: settlementId,
          economicActionId: action.id,
          authorizationId: authorization?.id ?? null,
          applicationId: action.applicationId,
          tenantId: action.tenantId,
          railId: command.railId,
          railTransactionRef: command.railTransactionRef,
          status: command.status,
          settledAmountMicroUsd: command.settledAmountMicroUsd,
          currency: command.currency,
          observedAt: command.observedAt,
          evidenceDigest: command.evidenceDigest,
          recordedAt: iso(),
        });
        await journal(
          tx,
          action,
          "settlement.externally-recorded",
          "external",
          { settlementId: settlement.id, railId: settlement.railId },
          { status: settlement.status, source: "external" },
        );
        return { settlementId: settlement.id };
      };
      const { outcome, replayed } = await idempotency.arbitrate(
        { actorId: command.actorId, applicationId: command.applicationId },
        EXTERNAL_SETTLEMENT_OPERATION,
        idempotencyKey,
        fingerprint,
        work,
      );
      const settlement = await store.getSettlementForAction(
        command.applicationId,
        command.economicActionId,
      );
      if (settlement === null || settlement.id !== outcome.settlementId) {
        // Converge on the durable row for the same external reference.
        const byRef = await store.findSettlementByRef(
          command.applicationId,
          command.railId,
          command.railTransactionRef,
        );
        if (byRef === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "recorded external settlement row disappeared",
          });
        }
        return { settlement: byRef, replayed: true };
      }
      return { settlement, replayed };
    },

    async recordDeliveryObservation(command, idempotencyKey) {
      if (!isUuid(command.economicActionId)) {
        throw validationError("economicActionId must be a valid identity");
      }
      const fingerprint = canonicalEconomicFingerprint([
        DELIVERY_OPERATION,
        command.applicationId,
        command.economicActionId,
        command.kind,
        command.digest,
        command.contentRef,
        command.observedAt,
      ]);
      const deliveryId = generateId();
      const work = async (tx: EconomicsTx): Promise<{ deliveryId: string }> => {
        const action = await tx.store.getEconomicAction(
          command.applicationId,
          command.economicActionId,
        );
        if (action === null) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message:
              "economic action not found in this application (missing or owned by another application)",
            details: { economicActionId: command.economicActionId },
          });
        }
        assertTenantRow(command, action);
        const delivery = await tx.store.insertDelivery({
          id: deliveryId,
          economicActionId: action.id,
          applicationId: action.applicationId,
          tenantId: action.tenantId,
          kind: command.kind,
          digest: command.digest,
          contentRef: command.contentRef,
          observedAt: command.observedAt,
          recordedAt: iso(),
        });
        await journal(
          tx,
          action,
          "delivery.recorded",
          "delivery-evidence",
          { deliveryId: delivery.id, kind: delivery.kind, digest: delivery.digest },
          { kind: delivery.kind },
        );
        return { deliveryId: delivery.id };
      };
      const { outcome, replayed } = await idempotency.arbitrate(
        { actorId: command.actorId, applicationId: command.applicationId },
        DELIVERY_OPERATION,
        idempotencyKey,
        fingerprint,
        work,
      );
      const deliveries = await store.listDeliveries(
        command.applicationId,
        command.economicActionId,
      );
      const delivery = deliveries.find((row) => row.id === outcome.deliveryId);
      if (delivery === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "recorded delivery row disappeared",
        });
      }
      return { delivery, replayed };
    },

    async getEconomicAction(applicationId, id) {
      return store.getEconomicAction(applicationId, id);
    },

    async listEconomicActionEvents(applicationId, economicActionId) {
      return store.listEvents(applicationId, economicActionId);
    },

    async deliveryEvidence(applicationId, economicActionId) {
      const action = await store.getEconomicAction(applicationId, economicActionId);
      if (action === null) {
        return null;
      }
      const settlement = await store.getSettlementForAction(applicationId, economicActionId);
      const deliveries = await store.listDeliveries(applicationId, economicActionId);
      return {
        economicActionId: action.id,
        executionId: action.executionId,
        applicationId: action.applicationId,
        tenantId: action.tenantId,
        status: action.status,
        settlement,
        deliveries,
      };
    },

    async economicOutcomeFacts(applicationId) {
      const actions = await store.listActionsOfApplication(applicationId);
      const authorizations = await store.listAuthorizationsOfApplication(applicationId);
      const settlements = await store.listSettlementsOfApplication(applicationId);
      const deliveries = await store.listDeliveriesOfApplication(applicationId);
      return economicOutcomeFacts(actions, settlements, authorizations, deliveries);
    },
  };
}

/** Deterministic digest over neutral rail evidence (no raw payloads stored). */
function digestOfEvidence(evidence: Readonly<Record<string, unknown>>): string {
  const canonical = JSON.stringify(
    Object.keys(evidence)
      .sort()
      .map((key) => [key, evidence[key]]),
  );
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}
