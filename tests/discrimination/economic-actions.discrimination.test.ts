/**
 * Discrimination: the governed ECONOMIC-ACTION boundary (WORK-032,
 * ECO-001..ECO-008; ADR-0018). Every protection is proven by a mutant
 * that removes it — a protection only counts if its removal is REJECTED.
 *
 * M1..M25 mapping (mechanism: S = static source-mutant scan through the
 * shared `lib/economics-boundary` scanners — the architecture gate runs
 * the same scanner over the real tree, so it FAILS under exactly these
 * mutations; R = runtime red record over the REAL service/store/rails —
 * production blocks the scenario canonically, a constructed wiring/data
 * mutant exhibits the violation it prevents):
 *
 *   M1  credential-exposure          S: cardNumber/cardToken/apiKey field
 *                                     added to wire/serializer/rail-request/
 *                                     command contracts; dropped metadata
 *                                     scrub; opened create-route contract;
 *                                     client-supplied tenant scope
 *   M2  amount-substitution          S: amount-bounds check + amount
 *                                     fingerprint parts removed
 *                                     R: 10x-ceiling charge replay DENIED
 *                                     (amount-out-of-bounds), rail untouched;
 *                                     direct-rail red record
 *   M3  recipient-substitution       S: sameRecipient check removed
 *                                     R: corrupted-row recipient replay DENIED
 *   M4  currency-substitution        S: currency check removed
 *                                     R: corrupted-row currency replay DENIED
 *   M5  purpose-substitution         S: purpose check removed
 *                                     R: corrupted-row purpose replay DENIED
 *   M6  expiry-bypass                S: expiry check removed
 *                                     R: post-expiry charge/authorize →
 *                                     EXPIRED, rail untouched
 *   M7  replay-after-consumption     S: status check + single-use reuse
 *                                     policy removed
 *                                     R: second charge → canonical failure,
 *                                     exactly one rail charge; consumed
 *                                     authorization denied at the domain too
 *   M8  402-as-authorization         S: authorize/mint surface added to the
 *                                     machine-payment parser
 *                                     R: 402-seeded draft through the REAL
 *                                     policy denial → POLICY_DENIED;
 *                                     allow-all seam red record
 *   M9  settlement-as-verification   S: delivery-facts projector conflates
 *                                     settlement into deliveryCount; external
 *                                     settlement path mutates authority state
 *                                     R: REAL invariant evaluator over a
 *                                     settled-no-delivery bundle → FAIL;
 *                                     conflation projector red record
 *   M10 second-ledger                S: SQL store writes budgets.*; adapter
 *                                     CREATE TABLE; migration foreign table;
 *                                     idempotency-reuse dropped
 *   M11 budget-bypass                S: budget.reserve call removed
 *                                     R: budget denial → BUDGET_EXCEEDED,
 *                                     zero effects; permissive-budget red
 *                                     record (charge with no hold)
 *   M12 policy-bypass                S: policy gate deleted / moved after
 *                                     capability
 *                                     R: policy denial → POLICY_DENIED
 *                                     before capability/budget/rail;
 *                                     allow-all seam red record
 *   M13 capability-bypass            S: capability gate deleted
 *                                     R: unmet capability →
 *                                     CAPABILITY_UNAVAILABLE before budget;
 *                                     permissive seam red record
 *   M14 order-violation              S: rail charge before the durable
 *                                     executing transition; rail gate after
 *                                     the charge; capability after budget
 *                                     R: charge on a proposed action →
 *                                     INVALID_STATE_TRANSITION, zero rail
 *                                     charges
 *   M15 double-reservation           S: reservation-operation UNIQUE dropped
 *                                     R: second authorization mint rejected;
 *                                     uniqueness-blind store red record
 *   M16 idempotency-fingerprint      R: same key + mutated constraint →
 *                                     IDEMPOTENCY_KEY_REUSED; fingerprint-
 *                                     blind ledger red record (two durable
 *                                     operations under one key)
 *   M17 tenant-cross                 S: assertTenantRow removed; tenant
 *                                     substitution check removed
 *                                     R: cross-tenant command →
 *                                     TENANT_SCOPE_VIOLATION before any
 *                                     effect
 *   M18 application-cross            S: application substitution check
 *                                     removed
 *                                     R: cross-application command →
 *                                     TENANT_SCOPE_VIOLATION (invisible row);
 *                                     execution-substitution replay DENIED
 *   M19 rail-authority               S: authorize verb on the PaymentRail
 *                                     port; authority verbs/imports in the
 *                                     payment-rails integration tree
 *   M20 provider-leak                S: vendor identifier (stripe) in the
 *                                     core contracts and the API routes
 *   M21 learning-authorization       S: learning field on the pinned deps
 *                                     surface; learning import in the service
 *                                     R: admission inputs are learning-free;
 *                                     learning-informed admission red record
 *   M22 fail-open rail               S: every→some; strict true→truthy; gate
 *                                     removed
 *                                     R: constraint-blind rail refused
 *                                     BEFORE any charge
 *   M23 invalid-schema               S: purpose/currency vocabulary checks
 *                                     and the future-expiry check removed
 *                                     R: closed-vocabulary/amount/expiry
 *                                     violations rejected with zero durable
 *                                     rows
 *   M24 provenance-omitted           S: execution identity leaves the request
 *                                     fingerprint
 *                                     R: missing/malformed/unknown
 *                                     execution, tenant and application
 *                                     identities rejected
 *   M25 history-mutation             S: no-delete trigger, gapless-sequence
 *                                     guard and closed cause vocabulary
 *                                     removed from migration 0014
 *                                     R: terminal transition + out-of-sequence
 *                                     event physically rejected; lifecycle-
 *                                     blind store red record (settled →
 *                                     proposed rewrite)
 *
 * The scanners' honesty is proven first: the UNMUTATED real tree yields
 * zero violations from both the boundary scanner and the credential-
 * exposure scanner.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createConstraintBlindSimulatedRail,
  createSimulatedPaymentRail,
} from "../../src/integrations/payment-rails/public";
import type { BudgetAuthority, ReservationRecord } from "../../src/modules/budgets/public";
import type {
  InsertAuthorizationInput,
  InsertEventInput,
} from "../../src/modules/economics/ports/economic-store";
import type {
  AuthorizeEconomicActionCommand,
  ChargeEconomicActionCommand,
  CreateEconomicActionCommand,
  EconomicActionRecord,
  EconomicActionService,
  EconomicCapabilityAdmissionPort,
  EconomicPolicyAdmissionPort,
  EconomicStore,
  EconomicsIdempotencyArbitration,
  EconomicsIdempotencyPort,
  EconomicsIdempotencyScope,
  EconomicsTx,
  PaymentAuthorizationRecord,
} from "../../src/modules/economics/public";
import {
  createEconomicActionService,
  economicActionDraftFromSignal,
  evaluateAuthorizationUse,
  InMemoryEconomicStore,
  InMemoryEconomicsIdempotency,
  parsePaymentRequiredSignal,
} from "../../src/modules/economics/public";
import {
  createInvariantEvaluator,
  economicDeliveryFacts,
} from "../../src/modules/verification/public";
import { collectSourceFiles } from "../architecture/lib/collect";
import {
  MutableClock,
  RecordingCapabilityAdmission,
  RecordingPolicyAdmission,
} from "../unit/economics/fakes";
import {
  ACTOR,
  baseCreateInput,
  createInMemoryExecutions,
  InMemoryExecutionsIdempotency,
} from "../unit/executions/fakes";
import {
  ECONOMICS_CANONICAL_PATHS,
  economicsBoundaryViolations,
  economicsCredentialExposureViolations,
  hasCanonicalEconomicsBoundary,
  type SourceFile,
} from "./lib/economics-boundary";

const REPO_ROOT = join(process.cwd());
const MIGRATION_PATH = "src/platform/db/migrations/0014_economic_actions.sql";

// ---------------------------------------------------------------------------
// Real-tree loading + mutation helpers (the WORK-006/007 red-record pattern)
// ---------------------------------------------------------------------------

/** The REAL tree: every TypeScript file under src + migration 0014. */
function realTree(): SourceFile[] {
  const files = collectSourceFiles(REPO_ROOT);
  files.push({
    path: MIGRATION_PATH,
    content: readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8"),
  });
  return files;
}

/** Replace the FIRST occurrence — throws when the needle drifted (no vacuous mutants). */
function replaceOnce(source: string, needle: string, replacement: string): string {
  if (!source.includes(needle)) {
    throw new Error(`mutant needle not found in real source: ${JSON.stringify(needle)}`);
  }
  return source.replace(needle, replacement);
}

/** Replace EVERY occurrence — throws when none exist (no vacuous mutants). */
function replaceEvery(source: string, needle: string, replacement: string): string {
  const count = source.split(needle).length - 1;
  if (count === 0) {
    throw new Error(`mutant needle not found in real source: ${JSON.stringify(needle)}`);
  }
  return source.replaceAll(needle, replacement);
}

function mutate(
  tree: readonly SourceFile[],
  path: string,
  replacement: (content: string) => string,
): SourceFile[] {
  let mutated = false;
  const next = tree.map((file) => {
    if (file.path !== path) {
      return file;
    }
    mutated = true;
    return { ...file, content: replacement(file.content) };
  });
  if (!mutated) {
    throw new Error(`mutant target not in the real tree: ${path}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Static mutants (the shared scanners must flag each removal)
// ---------------------------------------------------------------------------

describe("discrimination: static boundary mutants (the shared economics scanner)", () => {
  test("scanner honesty: the unmutated real tree yields ZERO violations from both scanners", () => {
    const tree = realTree();
    expect(hasCanonicalEconomicsBoundary(tree)).toBe(true);
    expect(economicsBoundaryViolations(tree)).toEqual([]);
    expect(economicsCredentialExposureViolations(tree)).toEqual([]);
  });

  test("scanner honesty: the canonical protected surface files exist", () => {
    const paths = new Set(realTree().map((file) => file.path));
    for (const canonical of ECONOMICS_CANONICAL_PATHS) {
      expect(paths.has(canonical), canonical).toBe(true);
    }
  });

  test("M1 credential-exposure: credential fields, dropped scrubs, opened contracts and client scopes are rejected", () => {
    // A card-number field on the PUBLIC WIRE contract.
    const wire = mutate(realTree(), "src/shared/wire.ts", (content) =>
      replaceOnce(
        content,
        "  readonly railPreference: string | null;",
        "  readonly railPreference: string | null;\n  readonly cardNumber: string | null;",
      ),
    );
    expect(economicsCredentialExposureViolations(wire)).toContain(
      "economic-api-credential-field:src/shared/wire.ts",
    );

    // A card token emitted by the serializer.
    const serializerCard = mutate(realTree(), "src/api/serialization.ts", (content) =>
      replaceOnce(
        content,
        "    metadata: scrubSecretShapedKeys(record.metadata) as Readonly<Record<string, unknown>>,",
        "    metadata: scrubSecretShapedKeys(record.metadata) as Readonly<Record<string, unknown>>,\n    cardToken: null,",
      ),
    );
    expect(economicsCredentialExposureViolations(serializerCard)).toContain(
      "economic-api-credential-field:src/api/serialization.ts",
    );

    // The serializer stops scrubbing metadata (secret-shaped keys cross).
    // The needle is anchored to toWireEconomicAction's unique preceding
    // line — the identical scrub line also exists in toWireExecution,
    // and mutating THAT one would be a vacuous mutant for this scanner.
    const noScrub = mutate(realTree(), "src/api/serialization.ts", (content) =>
      replaceOnce(
        content,
        "    railPreference: record.railPreference,\n    metadata: scrubSecretShapedKeys(record.metadata) as Readonly<Record<string, unknown>>,",
        "    railPreference: record.railPreference,\n    metadata: record.metadata as Readonly<Record<string, unknown>>,",
      ),
    );
    expect(economicsCredentialExposureViolations(noScrub)).toContain(
      "economic-api-metadata-scrub-missing",
    );

    // The create route stops rejecting unknown keys (credential injection key).
    const openContract = mutate(realTree(), "src/api/routes/economic-actions.ts", (content) =>
      replaceOnce(content, "!CREATE_REQUEST_KEYS.includes(key)", "false"),
    );
    expect(economicsCredentialExposureViolations(openContract)).toContain(
      "economic-api-closed-contract-missing",
    );

    // The create route trusts a client-supplied tenant scope.
    const clientScope = mutate(realTree(), "src/api/routes/economic-actions.ts", (content) =>
      replaceOnce(
        content,
        "tenantId: identity.scope.tenantId",
        "tenantId: parsed.tenantId as string",
      ),
    );
    expect(economicsCredentialExposureViolations(clientScope)).toContain(
      "economic-api-server-derived-scope-missing",
    );

    // A credential field on the RAIL REQUEST contract (module side).
    const railCard = mutate(realTree(), "src/modules/economics/domain/rail.ts", (content) =>
      replaceOnce(
        content,
        "  readonly idempotencyKey: string;",
        "  readonly idempotencyKey: string;\n  readonly cardNumber?: string;",
      ),
    );
    expect(economicsBoundaryViolations(railCard)).toContain(
      "economic-rail-request-credential-field",
    );

    // A credential field on the COMMAND contract (module side).
    const commandKey = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.contracts.ts",
      (content) =>
        replaceOnce(
          content,
          "  readonly railPreference?: string;",
          "  readonly railPreference?: string;\n  readonly apiKey?: string;",
        ),
    );
    expect(economicsBoundaryViolations(commandKey)).toContain("economic-command-credential-field");
  });

  test("M2 amount-substitution: the amount-bounds firewall check and the amount fingerprint parts are load-bearing", () => {
    const noBounds = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) => replaceOnce(content, "amountWithinBounds(", "amountWithinBoundsRemoved("),
    );
    expect(economicsBoundaryViolations(noBounds)).toContain(
      "economic-substitution-check-missing:amount",
    );

    const noAmountFingerprint = mutate(
      realTree(),
      "src/modules/economics/domain/economic-action.ts",
      (content) =>
        replaceOnce(
          content,
          '    draft.amount.kind === "exact" ? draft.amount.microUsd : null,\n    draft.amount.kind === "range" ? draft.amount.minMicroUsd : null,\n    draft.amount.kind === "range" ? draft.amount.maxMicroUsd : null,\n',
          "",
        ),
    );
    expect(economicsBoundaryViolations(noAmountFingerprint)).toContain(
      "economic-fingerprint-amount-missing",
    );

    // The charge path itself must consult the substitution firewall.
    const noChargeFirewall = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) => replaceOnce(content, "evaluateAuthorizationUse(", "firewallBypassed("),
    );
    expect(economicsBoundaryViolations(noChargeFirewall)).toContain(
      "economic-charge-substitution-firewall-missing",
    );
  });

  test("M3 recipient-substitution: the recipient equality check and fingerprint part are load-bearing", () => {
    const noRecipient = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) =>
        replaceOnce(
          content,
          "sameRecipient(authorization.constraints.recipient, use.recipient)",
          "true",
        ),
    );
    expect(economicsBoundaryViolations(noRecipient)).toContain(
      "economic-substitution-check-missing:recipient",
    );

    const noFingerprintRecipient = mutate(
      realTree(),
      "src/modules/economics/domain/economic-action.ts",
      (content) => replaceOnce(content, "    draft.recipient.id,\n", ""),
    );
    expect(economicsBoundaryViolations(noFingerprintRecipient)).toContain(
      "economic-fingerprint-part-missing:draft.recipient.id",
    );
  });

  test("M4 currency-substitution: the currency check is load-bearing", () => {
    const noCurrency = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) =>
        replaceOnce(content, "authorization.constraints.currency !== use.currency", "false"),
    );
    expect(economicsBoundaryViolations(noCurrency)).toContain(
      "economic-substitution-check-missing:currency",
    );
  });

  test("M5 purpose-substitution: the purpose check is load-bearing", () => {
    const noPurpose = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) =>
        replaceOnce(content, "authorization.constraints.purpose !== use.purpose", "false"),
    );
    expect(economicsBoundaryViolations(noPurpose)).toContain(
      "economic-substitution-check-missing:purpose",
    );
  });

  test("M6 expiry-bypass: the authorization expiry check is load-bearing", () => {
    const noExpiry = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) =>
        replaceOnce(content, "Date.parse(authorization.expiresAt) <= now.getTime()", "false"),
    );
    expect(economicsBoundaryViolations(noExpiry)).toContain(
      "economic-substitution-check-missing:expiry",
    );
  });

  test("M7 replay-after-consumption: the status check and the single-use reuse policy are load-bearing", () => {
    const noStatus = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) => replaceOnce(content, 'authorization.status !== "active"', "false"),
    );
    expect(economicsBoundaryViolations(noStatus)).toContain(
      "economic-substitution-check-missing:status",
    );

    const reusable = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) => replaceEvery(content, '"single-use"', '"multi-use"'),
    );
    expect(economicsBoundaryViolations(reusable)).toContain(
      "economic-authorization-reuse-policy-missing",
    );
  });

  test("M8 402-as-authorization: an authorize/mint surface on the machine-payment parser is rejected", () => {
    const mintFunction = mutate(
      realTree(),
      "src/modules/economics/domain/machine-payment.ts",
      (content) =>
        `${content}\nexport function authorizeFromSignal(signal: PaymentRequiredSignal): string | null {\n  return signal.terms.payee.id;\n}\n`,
    );
    expect(economicsBoundaryViolations(mintFunction)).toContain(
      "economic-402-authorization-function",
    );

    const authorizationField = mutate(
      realTree(),
      "src/modules/economics/domain/machine-payment.ts",
      (content) =>
        replaceOnce(
          content,
          "  readonly advisory: true;",
          "  readonly advisory: true;\n  readonly authorization?: string;",
        ),
    );
    expect(economicsBoundaryViolations(authorizationField)).toContain(
      "economic-402-authorization-surface",
    );
  });

  test("M9 settlement-as-verification: settlement/delivery conflation and external-settlement authority are rejected", () => {
    const conflation = mutate(
      realTree(),
      "src/modules/verification/adapters/economic-delivery.ts",
      (content) =>
        replaceOnce(
          content,
          "deliveryCount: bundle.deliveries.length,",
          "deliveryCount: bundle.settlement ? 1 : bundle.deliveries.length,",
        ),
    );
    expect(economicsBoundaryViolations(conflation)).toContain(
      "economic-settlement-as-delivery-conflation",
    );

    const authorityMutation = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) =>
        replaceOnce(
          content,
          "        // CORRELATED EVIDENCE ONLY (ECO-006): an externally observed",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the needle carries a template literal as DATA
          '        await budget.settle({ actorId: command.actorId, applicationId: command.applicationId, tenantId: action.tenantId, operationId: authorization?.reservationOperationId ?? "external", actualAmountMicroUsd: command.settledAmountMicroUsd }, `${idempotencyKey}:settle`);\n        // CORRELATED EVIDENCE ONLY (ECO-006): an externally observed',
        ),
    );
    expect(economicsBoundaryViolations(authorityMutation)).toContain(
      "economic-external-settlement-budget-mutation",
    );
  });

  test("M10 second-ledger: foreign writes, adapter DDL, foreign tables and dropped idempotency reuse are rejected", () => {
    const foreignWrite = mutate(
      realTree(),
      "src/modules/economics/adapters/sql-economic-store.ts",
      (content) =>
        `${content}\nexport const ROGUE_LEDGER_WRITE = "INSERT INTO budgets.reservations (id) VALUES ('1')";\n`,
    );
    expect(economicsBoundaryViolations(foreignWrite)).toContain("economics-second-ledger-write");

    const noIdempotencyReuse = mutate(
      realTree(),
      "src/modules/economics/adapters/sql-economic-store.ts",
      (content) =>
        replaceEvery(
          content,
          "platform.idempotency_records",
          "economics.local_idempotency_records",
        ),
    );
    expect(economicsBoundaryViolations(noIdempotencyReuse)).toContain(
      "economics-idempotency-ledger-reuse-missing",
    );

    const adapterDdl = mutate(
      realTree(),
      "src/modules/economics/adapters/sql-economic-store.ts",
      (content) =>
        `${content}\nexport const ROGUE_DDL = "CREATE TABLE economics.rogue_ledger (id text PRIMARY KEY)";\n`,
    );
    expect(economicsBoundaryViolations(adapterDdl)).toContain("economics-adapter-creates-tables");

    const foreignTable = mutate(
      realTree(),
      MIGRATION_PATH,
      (content) => `${content}\nCREATE TABLE payments.ledger (id text PRIMARY KEY);\n`,
    );
    expect(economicsBoundaryViolations(foreignTable)).toContain(
      "economic-migration-foreign-table:CREATE TABLE payments.ledger",
    );
  });

  test("M11 budget-bypass: the budget reservation call is load-bearing", () => {
    const noReserve = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) => replaceOnce(content, "budget.reserve(", "unbudgetedReserve("),
    );
    expect(economicsBoundaryViolations(noReserve)).toContain("economic-budget-reserve-missing");
  });

  test("M12 policy-bypass: the policy gate deleted or moved after capability is rejected", () => {
    const noPolicy = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) => replaceOnce(content, "policy.evaluate(", "policyEvaluateRemoved("),
    );
    expect(economicsBoundaryViolations(noPolicy)).toContain("economic-policy-gate-missing");

    const policyLate = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) =>
        replaceOnce(
          content,
          "const policyDecision = await policy.evaluate({ action, actorId: command.actorId });",
          "const policyDecision = { allowed: true, evidence: {} } as const;",
        ).replace(
          "const capabilityDecision = await capabilities.resolve({ action, actorId: command.actorId });",
          "const capabilityDecision = await capabilities.resolve({ action, actorId: command.actorId });\n        const latePolicy = await policy.evaluate({ action, actorId: command.actorId });\n        void latePolicy;",
        ),
    );
    expect(economicsBoundaryViolations(policyLate)).toContain(
      "economic-policy-gate-after-capability",
    );
  });

  test("M13 capability-bypass: the capability gate deleted or moved after budget is rejected", () => {
    const noCapability = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) => replaceOnce(content, "capabilities.resolve(", "capabilitiesResolveRemoved("),
    );
    expect(economicsBoundaryViolations(noCapability)).toContain("economic-capability-gate-missing");

    const capabilityLate = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) =>
        replaceOnce(
          content,
          "const capabilityDecision = await capabilities.resolve({ action, actorId: command.actorId });",
          "const capabilityDecision = { satisfied: true, unmet: [] } as const;",
        ).replace(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the needle carries a template literal as DATA
          "            `${idempotencyKey}:reserve`,\n          );",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the replacement carries a template literal as DATA
          "            `${idempotencyKey}:reserve`,\n          );\n        const lateCapability = await capabilities.resolve({ action, actorId: command.actorId });\n        void lateCapability;",
        ),
    );
    expect(economicsBoundaryViolations(capabilityLate)).toContain(
      "economic-capability-gate-after-budget",
    );
  });

  test("M14 order-violation: rail charge before the durable transition, gate after the charge — rejected", () => {
    const chargeBeforeTransition = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) =>
        replaceOnce(
          content,
          '          ["authorized"],\n          "executing",',
          '          ["authorized"],\n          "precharged",',
        ),
    );
    expect(economicsBoundaryViolations(chargeBeforeTransition)).toContain(
      "economic-rail-charge-before-durable-transition",
    );

    const gateAfterCharge = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) =>
        replaceOnce(
          content,
          "      if (!railCanExpressConstraints(rail.capabilities)) {\n        throw new PlatformError({",
          "      if (false) {\n        throw new PlatformError({",
        ).replace(
          "        // Correlate the settlement observation (external evidence).",
          '        if (!railCanExpressConstraints(rail.capabilities)) {\n          throw new Error("late rail gate");\n        }\n        // Correlate the settlement observation (external evidence).',
        ),
    );
    expect(economicsBoundaryViolations(gateAfterCharge)).toContain(
      "economic-rail-gate-after-charge",
    );
  });

  test("M15 double-reservation: the reservation-operation UNIQUE constraint is load-bearing", () => {
    const noUnique = mutate(realTree(), MIGRATION_PATH, (content) =>
      replaceEvery(
        content,
        "payment_authorizations_reservation_key",
        "payment_authorizations_reservation_key_retired",
      ),
    );
    expect(economicsBoundaryViolations(noUnique)).toContain(
      "economic-migration-unique-missing:payment_authorizations_reservation_key",
    );
  });

  test("M17 tenant-cross: the per-path tenant assertion and the firewall tenant check are load-bearing", () => {
    const noTenantRow = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) =>
        replaceOnce(content, "        assertTenantRow(command, action);", "        void action;"),
    );
    expect(
      economicsBoundaryViolations(noTenantRow).some((violation) =>
        violation.startsWith("economic-tenant-check-missing"),
      ),
    ).toBe(true);

    const noTenantSubstitution = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) =>
        replaceOnce(content, "authorization.constraints.tenantId !== use.tenantId", "false"),
    );
    expect(economicsBoundaryViolations(noTenantSubstitution)).toContain(
      "economic-substitution-check-missing:tenant",
    );
  });

  test("M18 application-cross: the application substitution check is load-bearing", () => {
    const noApplication = mutate(
      realTree(),
      "src/modules/economics/domain/authorization.ts",
      (content) =>
        replaceOnce(
          content,
          "authorization.constraints.applicationId !== use.applicationId",
          "false",
        ),
    );
    expect(economicsBoundaryViolations(noApplication)).toContain(
      "economic-substitution-check-missing:application",
    );
  });

  test("M19 rail-authority: authority verbs and authority imports on the rail side are rejected", () => {
    const portVerb = mutate(realTree(), "src/modules/economics/domain/rail.ts", (content) =>
      replaceOnce(
        content,
        "  charge(request: RailPaymentRequest): Promise<RailSettlementObservation>;\n}",
        "  charge(request: RailPaymentRequest): Promise<RailSettlementObservation>;\n  authorize(request: RailPaymentRequest): Promise<unknown>;\n}",
      ),
    );
    expect(economicsBoundaryViolations(portVerb)).toContain(
      "economic-rail-authority-verb:authorize",
    );

    const rogueAdapter = [
      ...realTree(),
      {
        path: "src/integrations/payment-rails/adapters/rogue-authority.ts",
        content:
          'import { type BudgetAuthority } from "../../../modules/budgets/public";\nexport const rogueRailAuthority = async (budget: BudgetAuthority) =>\n  budget.reserve({ operationId: "x" } as never, "rogue-key");\n',
      },
    ];
    const violations = economicsBoundaryViolations(rogueAdapter);
    expect(violations).toContain(
      "economic-rail-authority-verbs:src/integrations/payment-rails/adapters/rogue-authority.ts",
    );
    expect(violations).toContain(
      "economic-rail-authority-import:src/integrations/payment-rails/adapters/rogue-authority.ts",
    );
  });

  test("M20 provider-leak: vendor identifiers in core contracts and API routes are rejected", () => {
    const vendorVocabulary = mutate(
      realTree(),
      "src/modules/economics/domain/vocabulary.ts",
      (content) => `${content}\nexport const STRIPE_RAIL_SLUG = "stripe";\n`,
    );
    expect(economicsBoundaryViolations(vendorVocabulary)).toContain(
      "economic-provider-leak:src/modules/economics/domain/vocabulary.ts",
    );

    const vendorRoute = mutate(
      realTree(),
      "src/api/routes/economic-actions.ts",
      (content) => `${content}\nexport const DEFAULT_PAYMENT_PROVIDER = "stripe";\n`,
    );
    expect(economicsBoundaryViolations(vendorRoute)).toContain(
      "economic-provider-leak:src/api/routes/economic-actions.ts",
    );
  });

  test("M21 learning-authorization: a learning seam on the pinned deps surface or an import is rejected", () => {
    const learningDeps = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.contracts.ts",
      (content) =>
        replaceOnce(
          content,
          '  readonly policy: import("../ports/policy-admission").EconomicPolicyAdmissionPort;',
          '  readonly policy: import("../ports/policy-admission").EconomicPolicyAdmissionPort;\n  readonly learning: import("../../learning/public").LearningTelemetry;',
        ),
    );
    expect(economicsBoundaryViolations(learningDeps)).toContain(
      "economic-service-deps-shape-changed",
    );

    const learningImport = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) =>
        replaceOnce(
          content,
          'import { economicOutcomeFacts } from "../domain/learning-facts";',
          'import { economicOutcomeFacts } from "../domain/learning-facts";\nimport { learningTelemetry } from "../../learning/public";',
        ),
    );
    expect(economicsBoundaryViolations(learningImport)).toContain(
      "economics-forbidden-module-import:src/modules/economics/application/economic-action-service.ts:learning",
    );
  });

  test("M22 fail-open: every→some, strict truthiness and a removed gate are rejected", () => {
    const some = mutate(realTree(), "src/modules/economics/domain/rail.ts", (content) =>
      replaceOnce(
        content,
        "REQUIRED_RAIL_CAPABILITY_KEYS.every(",
        "REQUIRED_RAIL_CAPABILITY_KEYS.some(",
      ),
    );
    expect(economicsBoundaryViolations(some)).toContain("economic-rail-fail-open-every-missing");

    const truthy = mutate(realTree(), "src/modules/economics/domain/rail.ts", (content) =>
      replaceOnce(content, "capabilities[key] === true", "Boolean(capabilities[key])"),
    );
    expect(economicsBoundaryViolations(truthy)).toContain(
      "economic-rail-fail-open-strict-true-missing",
    );

    const noGate = mutate(
      realTree(),
      "src/modules/economics/application/economic-action-service.ts",
      (content) =>
        replaceOnce(
          content,
          "if (!railCanExpressConstraints(rail.capabilities)) {",
          "if (false) {",
        ),
    );
    expect(economicsBoundaryViolations(noGate)).toContain("economic-rail-fail-open-gate-missing");
  });

  test("M23 invalid-schema: the closed vocabulary and future-expiry checks are load-bearing", () => {
    const noPurposeVocabulary = mutate(
      realTree(),
      "src/modules/economics/domain/economic-action.ts",
      (content) => replaceOnce(content, "isEconomicPurpose(draft.purpose)", "true"),
    );
    expect(economicsBoundaryViolations(noPurposeVocabulary)).toContain(
      "economic-purpose-vocabulary-check-missing",
    );

    const noCurrencyVocabulary = mutate(
      realTree(),
      "src/modules/economics/domain/economic-action.ts",
      (content) => replaceOnce(content, "isEconomicCurrency(draft.currency)", "true"),
    );
    expect(economicsBoundaryViolations(noCurrencyVocabulary)).toContain(
      "economic-currency-vocabulary-check-missing",
    );

    const noFutureExpiry = mutate(
      realTree(),
      "src/modules/economics/domain/economic-action.ts",
      (content) => replaceOnce(content, "expiresAt <= now.getTime()", "false"),
    );
    expect(economicsBoundaryViolations(noFutureExpiry)).toContain(
      "economic-expiry-future-check-missing",
    );
  });

  test("M24 provenance-omitted: the execution identity leaving the request fingerprint is rejected", () => {
    const noExecutionFingerprint = mutate(
      realTree(),
      "src/modules/economics/domain/economic-action.ts",
      (content) => replaceOnce(content, "    draft.executionId,\n", ""),
    );
    expect(economicsBoundaryViolations(noExecutionFingerprint)).toContain(
      "economic-fingerprint-part-missing:draft.executionId",
    );
  });

  test("M25 history-mutation: physical guard removal and cause-vocabulary drift are rejected", () => {
    const noDeleteGuard = mutate(realTree(), MIGRATION_PATH, (content) =>
      replaceEvery(content, "economic_actions_no_delete", "economic_actions_delete_allowed"),
    );
    expect(economicsBoundaryViolations(noDeleteGuard)).toContain(
      "economic-migration-guard-missing:economic_actions_no_delete",
    );

    const noGapless = mutate(realTree(), MIGRATION_PATH, (content) =>
      replaceEvery(
        content,
        "economic_action_events_gapless_sequence",
        "economic_action_events_gapped_sequence",
      ),
    );
    expect(economicsBoundaryViolations(noGapless)).toContain(
      "economic-migration-guard-missing:economic_action_events_gapless_sequence",
    );

    const causeDrift = mutate(realTree(), MIGRATION_PATH, (content) =>
      replaceOnce(
        content,
        "'platform', 'authorization', 'external', 'delivery-evidence', 'caller'",
        "'platform', 'authorization', 'external', 'delivery-evidence', 'caller', 'hunch'",
      ),
    );
    expect(economicsBoundaryViolations(causeDrift)).toContain(
      "economic-migration-cause-vocabulary-changed",
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime red records (constructed wiring/data mutants — the REAL service,
// REAL store, REAL idempotency ledger and REAL simulated rails)
// ---------------------------------------------------------------------------

interface DiscriminationWorldOptions {
  readonly store?: InMemoryEconomicStore;
  readonly idempotency?: (store: EconomicStore) => EconomicsIdempotencyPort;
  readonly policy?: EconomicPolicyAdmissionPort;
  readonly capability?: EconomicCapabilityAdmissionPort;
  readonly budget?: BudgetAuthority;
  /** Optional executions world (mutant demonstrations re-run journal work
   * under a replayed key — the executions ledger must permit re-run). */
  readonly executions?: ReturnType<typeof createInMemoryExecutions>;
}

interface DiscriminationWorld {
  readonly economics: EconomicActionService;
  readonly store: InMemoryEconomicStore;
  readonly policy: RecordingPolicyAdmission;
  readonly capability: RecordingCapabilityAdmission;
  readonly budget: FakeBudgetRecorder;
  readonly clock: MutableClock;
  readonly rail: ReturnType<typeof createSimulatedPaymentRail>;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly executionId: string;
  readonly expiresAt: string;
}

/** Recording budget authority (reserve/settle/release with deny switches). */
class FakeBudgetRecorder {
  readonly reserveCalls: { operationId?: string; amountMicroUsd?: string }[] = [];
  failReserve = false;
  readonly impl: BudgetAuthority = {
    reserve: async (command, _key) => {
      if (this.failReserve) {
        throw new (await import("../../src/shared/errors")).PlatformError({
          code: "BUDGET_EXCEEDED",
          message: "budget authority denied the reservation",
        });
      }
      this.reserveCalls.push(command);
      return { reservation: fakeReservation(command), converged: false, replayed: false };
    },
    settle: async (command, _key) => ({
      reservation: { ...fakeReservation(command), status: "settled" },
      converged: false,
      replayed: false,
    }),
    release: async (command, _key) => ({
      reservation: { ...fakeReservation(command), status: "released" },
      converged: false,
      replayed: false,
    }),
  };
}

function fakeReservation(command: {
  applicationId: string;
  tenantId: string;
  operationId: string;
}): ReservationRecord {
  return {
    id: `res-${command.operationId}`,
    applicationId: command.applicationId,
    tenantId: command.tenantId,
    executionId:
      "executionId" in command ? ((command as { executionId?: string }).executionId ?? "") : "",
    operationId: command.operationId,
    userId: "",
    fundingMode: "developer",
    sourceKind: "developer",
    walletId: null,
    amountMicroUsd: "125000",
    status: "active",
    settledAmountMicroUsd: null,
    monthKey: "2026-09",
    createdAt: "2026-09-15T12:00:00.000Z",
    finalizedAt: null,
  };
}

let worldCounter = 0;

async function discriminationWorld(
  options: DiscriminationWorldOptions = {},
): Promise<DiscriminationWorld> {
  worldCounter += 1;
  const applicationId = `00000000-0000-7000-8000-20000000${String(worldCounter).padStart(4, "0")}`;
  const executions = options.executions ?? createInMemoryExecutions();
  executions.store.seedApplication(applicationId, ACTOR.tenantId);
  const receipt = await executions.service.createExecution(
    baseCreateInput(applicationId),
    `discrimination-exec-${worldCounter}`,
    ACTOR,
  );

  const clock = new MutableClock();
  const store = options.store ?? new InMemoryEconomicStore();
  const budget = new FakeBudgetRecorder();
  // SINGLE instances: the service's admissions and the world's recorders
  // must be the same object, or the red records observe the wrong seam.
  const policy = options.policy ?? new RecordingPolicyAdmission();
  const capability = options.capability ?? new RecordingCapabilityAdmission();
  const economics = createEconomicActionService({
    store,
    idempotency: (options.idempotency ?? ((s) => new InMemoryEconomicsIdempotency(s)))(store),
    policy,
    capabilities: capability,
    budget: options.budget ?? budget.impl,
    executions: executions.service,
    generateId: executions.generateId,
    now: () => clock.now(),
  });
  const rail = createSimulatedPaymentRail({
    railId: `simulated-rail-${worldCounter}`,
    now: () => clock.now(),
  });

  return {
    economics,
    store,
    policy: policy as RecordingPolicyAdmission,
    capability: capability as RecordingCapabilityAdmission,
    budget,
    clock,
    rail,
    applicationId,
    tenantId: ACTOR.tenantId,
    actorId: ACTOR.actorId,
    executionId: receipt.executionId,
    expiresAt: new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString(),
  };
}

function createCommand(
  world: DiscriminationWorld,
  overrides: Partial<CreateEconomicActionCommand> = {},
): CreateEconomicActionCommand {
  return {
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    actorId: world.actorId,
    executionId: world.executionId,
    purpose: "purchase",
    recipient: { kind: "merchant", id: "merchant-42" },
    amount: { kind: "exact", microUsd: "125000" },
    currency: "usd",
    expiresAt: world.expiresAt,
    requiredCapabilities: [{ kind: "tool", name: "payment-processor" }],
    ...overrides,
  };
}

function authorizeCommand(
  world: DiscriminationWorld,
  economicActionId: string,
  overrides: Partial<AuthorizeEconomicActionCommand> = {},
): AuthorizeEconomicActionCommand {
  return {
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    actorId: world.actorId,
    economicActionId,
    ...overrides,
  };
}

function chargeCommand(
  world: DiscriminationWorld,
  economicActionId: string,
  overrides: Partial<ChargeEconomicActionCommand> = {},
): ChargeEconomicActionCommand {
  return {
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    actorId: world.actorId,
    economicActionId,
    ...overrides,
  };
}

/** Propose + authorize through the real service (the happy admission chain). */
async function authorizedAction(
  world: DiscriminationWorld,
  overrides: Partial<CreateEconomicActionCommand> = {},
  key = "discrimination",
): Promise<string> {
  const created = await world.economics.createEconomicAction(
    createCommand(world, overrides),
    `${key}:create`,
  );
  await world.economics.authorizeEconomicAction(
    authorizeCommand(world, created.action.id),
    `${key}:authorize`,
  );
  return created.action.id;
}

/**
 * A store whose getEconomicAction returns a SUBSTITUTED row once armed —
 * the durable-identity mutation the migration's immutable-identity
 * triggers forbid; arming AFTER authorization is the substitution replay.
 */
class SubstitutedActionStore extends InMemoryEconomicStore {
  private armed = false;
  constructor(private readonly substitute: (record: EconomicActionRecord) => EconomicActionRecord) {
    super();
  }
  arm(): void {
    this.armed = true;
  }
  override async getEconomicAction(
    applicationId: string,
    id: string,
  ): Promise<EconomicActionRecord | null> {
    const record = await super.getEconomicAction(applicationId, id);
    return record === null || !this.armed ? record : this.substitute(record);
  }
}

/** A fingerprint-blind idempotency ledger (M16 wiring mutant). */
class FingerprintBlindIdempotency implements EconomicsIdempotencyPort {
  private readonly seen = new Set<string>();
  constructor(private readonly store: EconomicStore) {}
  async arbitrate<T>(
    scope: EconomicsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    _requestFingerprint: string,
    work: (tx: EconomicsTx) => Promise<T>,
  ): Promise<EconomicsIdempotencyArbitration<T>> {
    const key = `${scope.actorId}:${scope.applicationId}:${operationName}:${idempotencyKey}`;
    const first = !this.seen.has(key);
    this.seen.add(key);
    // FINGERPRINT IGNORED: a different logical operation under the same
    // key just runs again (the exact bypass the durable ledger forbids).
    const outcome = await work({ store: this.store });
    return { outcome, replayed: !first };
  }
}

/** A uniqueness-blind authorization store (M15 wiring mutant). */
class UniquenessBlindStore extends InMemoryEconomicStore {
  override async insertAuthorization(
    input: InsertAuthorizationInput,
  ): Promise<PaymentAuthorizationRecord> {
    const record: PaymentAuthorizationRecord = {
      id: input.id,
      economicActionId: input.economicActionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      constraints: input.constraints as unknown as PaymentAuthorizationRecord["constraints"],
      status: input.status as PaymentAuthorizationRecord["status"],
      reservationOperationId: input.reservationOperationId,
      admissionEvidence: input.admissionEvidence,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: input.createdAt,
    };
    (
      this as unknown as { authorizations: Map<string, PaymentAuthorizationRecord> }
    ).authorizations.set(record.id, record);
    return record;
  }
}

/** A lifecycle-blind store (M25 wiring mutant: no frozen transition table). */
class LifecycleBlindStore extends InMemoryEconomicStore {
  override async transitionEconomicAction(
    applicationId: string,
    id: string,
    _from: readonly string[],
    to: string,
    _patch: Readonly<Record<string, unknown>>,
  ): Promise<EconomicActionRecord> {
    const current = await this.getEconomicAction(applicationId, id);
    if (current === null) {
      throw new Error("row missing");
    }
    const next = { ...current, status: to as EconomicActionRecord["status"] };
    (this as unknown as { actions: Map<string, EconomicActionRecord> }).actions.set(id, next);
    return next;
  }
}

describe("discrimination: runtime red records (substitution, replay, ordering, authority)", () => {
  test("R-M2 amount-substitution: a bounded authorization replayed against a 10x amount is DENIED before the rail; the rail itself is no guard", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(
      world,
      {
        amount: { kind: "range", minMicroUsd: "100000", maxMicroUsd: "250000" },
      },
      "m2",
    );

    await expect(
      world.economics.chargeEconomicAction(
        chargeCommand(world, actionId, { amountMicroUsd: "2500000" }),
        world.rail,
        "m2:charge",
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });

    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    expect(events.find((event) => event.type === "payment.rejected")?.reference).toMatchObject({
      denied: true,
      code: "amount-out-of-bounds",
    });
    expect(world.rail.charges).toHaveLength(0);
    expect((await world.economics.getEconomicAction(world.applicationId, actionId))?.status).toBe(
      "authorized",
    );

    // MUTANT (observed violation): handed the escalated amount directly —
    // the exact side effect the firewall blocks — the rail settles it.
    const observation = await world.rail.charge({
      economicActionId: actionId,
      authorizationId: "authorization-id",
      recipient: { kind: "merchant", id: "merchant-42" },
      amountMicroUsd: "2500000",
      currency: "usd",
      purpose: "purchase",
      expiresAt: world.expiresAt,
      idempotencyKey: "m2:direct-rail",
      correlationRef: actionId,
    });
    expect(observation.settledAmountMicroUsd).toBe("2500000");
  });

  test("R-M3 recipient-substitution: the authorization replayed against a mutated recipient row is DENIED", async () => {
    const store = new SubstitutedActionStore((record) => ({
      ...record,
      recipient: { kind: "wallet", id: "attacker-wallet-7" },
    }));
    const world = await discriminationWorld({ store });
    const actionId = await authorizedAction(world, {}, "m3");

    store.arm(); // the durable recipient row is rewritten post-issuance
    await expect(
      world.economics.chargeEconomicAction(chargeCommand(world, actionId), world.rail, "m3:charge"),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    expect(events.find((event) => event.type === "payment.rejected")?.reference).toMatchObject({
      code: "recipient-substitution",
    });
    expect(world.rail.charges).toHaveLength(0);
  });

  test("R-M4 currency-substitution: the authorization replayed against a mutated currency row is DENIED", async () => {
    const store = new SubstitutedActionStore((record) => ({ ...record, currency: "eur" }));
    const world = await discriminationWorld({ store });
    const actionId = await authorizedAction(world, {}, "m4");

    store.arm();
    await expect(
      world.economics.chargeEconomicAction(chargeCommand(world, actionId), world.rail, "m4:charge"),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    expect(events.find((event) => event.type === "payment.rejected")?.reference).toMatchObject({
      code: "currency-substitution",
    });
    expect(world.rail.charges).toHaveLength(0);
  });

  test("R-M5 purpose-substitution: the authorization replayed against a mutated purpose row is DENIED", async () => {
    const store = new SubstitutedActionStore((record) => ({ ...record, purpose: "transfer" }));
    const world = await discriminationWorld({ store });
    const actionId = await authorizedAction(world, {}, "m5");

    store.arm();
    await expect(
      world.economics.chargeEconomicAction(chargeCommand(world, actionId), world.rail, "m5:charge"),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    expect(events.find((event) => event.type === "payment.rejected")?.reference).toMatchObject({
      code: "purpose-substitution",
    });
    expect(world.rail.charges).toHaveLength(0);
  });

  test("R-M6 expiry-bypass: a post-expiry charge and a post-expiry authorization both fail closed", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m6");
    world.clock.advance(2 * 60 * 60 * 1000); // past the authorization expiry

    await expect(
      world.economics.chargeEconomicAction(chargeCommand(world, actionId), world.rail, "m6:charge"),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    expect(events.find((event) => event.type === "payment.rejected")?.reference).toMatchObject({
      code: "authorization-expired",
    });
    expect(world.rail.charges).toHaveLength(0);

    // An expired INTENT never even reaches the policy gate.
    const world2 = await discriminationWorld();
    const created = await world2.economics.createEconomicAction(createCommand(world2), "m6:create");
    world2.clock.advance(2 * 60 * 60 * 1000);
    await expect(
      world2.economics.authorizeEconomicAction(
        authorizeCommand(world2, created.action.id),
        "m6:auth",
      ),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    expect(
      (await world2.economics.getEconomicAction(world2.applicationId, created.action.id))?.status,
    ).toBe("expired");
    expect(world2.policy.calls).toHaveLength(0);
  });

  test("R-M7 replay-after-consumption: the second charge fails canonically and the rail charged exactly once", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m7");
    const charged = await world.economics.chargeEconomicAction(
      chargeCommand(world, actionId),
      world.rail,
      "m7:charge-1",
    );
    expect(charged.action.status).toBe("settled");
    expect(charged.authorization.status).toBe("consumed");

    // REPLAY with a fresh idempotency key: the terminal action refuses.
    await expect(
      world.economics.chargeEconomicAction(
        chargeCommand(world, actionId),
        world.rail,
        "m7:charge-2",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(world.rail.charges).toHaveLength(1);

    // The consumed authorization is denied by the domain firewall too.
    const evaluation = evaluateAuthorizationUse(
      charged.authorization,
      {
        economicActionId: actionId,
        recipient: { kind: "merchant", id: "merchant-42" },
        amountMicroUsd: "125000",
        currency: "usd",
        purpose: "purchase",
        executionId: world.executionId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      },
      world.clock.now(),
    );
    expect(evaluation).toMatchObject({ allowed: false, code: "authorization-not-active" });
  });

  test("R-M8 402-as-authorization: a parsed 402 signal is planning input only; the REAL policy denial blocks it", async () => {
    const parsed = parsePaymentRequiredSignal({
      statusCode: 402,
      url: "https://seller.example/report-42",
      body: {
        terms: {
          payeeKind: "merchant",
          payeeId: "merchant-42",
          amountMicroUsd: "125000",
          currency: "usd",
          resource: "report-42",
        },
      },
    });
    expect(parsed.parsed).toBe(true);
    if (!parsed.parsed) {
      throw new Error("the 402 fixture must parse");
    }
    expect(parsed.signal.advisory).toBe(true);
    const draft = economicActionDraftFromSignal(
      parsed.signal,
      {
        applicationId: "pending",
        tenantId: "pending",
        executionId: "pending",
        proposedBy: "pending",
      },
      { expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    );

    // PRODUCTION: the 402-seeded intent through the FULL chain — the REAL
    // policy admission denies it; a 402 NEVER authorizes. The denial is
    // journaled first, then thrown with the canonical code.
    const world = await discriminationWorld();
    world.policy.decision = { allowed: false, reason: "machine-resource purchase not permitted" };
    const created = await world.economics.createEconomicAction(
      createCommand(world, {
        purpose: draft.purpose,
        recipient: draft.recipient,
        amount: draft.amount,
        currency: draft.currency,
      }),
      "m8:create",
    );
    await expect(
      world.economics.authorizeEconomicAction(
        authorizeCommand(world, created.action.id),
        "m8:auth",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.budget.reserveCalls).toHaveLength(0);
    expect(world.rail.charges).toHaveLength(0);

    // MUTANT (observed violation): an allow-all admission wired at the
    // seam mints an authorization from the bare 402 signal.
    const mutantWorld = await discriminationWorld({
      policy: { evaluate: async () => ({ allowed: true }) },
    });
    const mutantCreated = await mutantWorld.economics.createEconomicAction(
      createCommand(mutantWorld, {
        purpose: draft.purpose,
        recipient: draft.recipient,
        amount: draft.amount,
        currency: draft.currency,
      }),
      "m8:mutant-create",
    );
    const outcome = await mutantWorld.economics.authorizeEconomicAction(
      authorizeCommand(mutantWorld, mutantCreated.action.id),
      "m8:mutant-auth",
    );
    expect(outcome.authorization).not.toBeNull();
  });

  test("R-M9 settlement-as-verification: a fully settled payment FAILS the delivery criterion (a mutant projector would PASS it)", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m9");
    await world.economics.chargeEconomicAction(
      chargeCommand(world, actionId),
      world.rail,
      "m9:charge",
    );
    const bundle = await world.economics.deliveryEvidence(world.applicationId, actionId);
    if (bundle === null) {
      throw new Error("the delivery-evidence bundle must exist");
    }
    // Payment fully settled; NOTHING delivered.
    expect(bundle.settlement?.status).toBe("confirmed");
    expect(bundle.deliveries).toEqual([]);

    const evaluator = createInvariantEvaluator("economic-delivery-discrimination");
    const criterion = {
      criterionId: "resource-delivered",
      version: 1,
      kind: "invariant" as const,
      required: true,
      description: "at least one delivery observation",
      definition: { assertions: [{ path: "deliveryCount", op: "gte", value: 1 }] },
    };
    const evidence = {
      target: { kind: "economic-delivery" as const, ref: actionId },
      facts: economicDeliveryFacts(bundle),
      evidenceRefs: [bundle.settlement?.id ?? "settlement"],
    };
    const context = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId: world.executionId,
      actorId: world.actorId,
    };

    const production = await evaluator.evaluate(evidence, criterion, context);
    expect(production.status).toBe("FAIL");

    // MUTANT (observed violation): a projector that counts the settlement
    // as delivery turns payment success into a delivery PASS.
    const conflated = { ...economicDeliveryFacts(bundle), deliveryCount: 1 };
    const mutant = await evaluator.evaluate({ ...evidence, facts: conflated }, criterion, context);
    expect(mutant.status).toBe("PASS");
  });

  test("R-M10 second-ledger: a successful charge settles through THE budget authority, not a local ledger", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m10");
    await world.economics.chargeEconomicAction(
      chargeCommand(world, actionId),
      world.rail,
      "m10:charge",
    );
    // ONE reservation, ONE settlement — both through the budget authority.
    expect(world.budget.reserveCalls).toHaveLength(1);
    expect(world.budget.reserveCalls[0]?.operationId).toBe(`econ-${actionId}`);
    // The settlement row is correlated evidence; the action terminal state
    // rides the economics tables only.
    const bundle = await world.economics.deliveryEvidence(world.applicationId, actionId);
    expect(bundle?.settlement?.settledAmountMicroUsd).toBe("125000");
    expect(bundle?.status).toBe("settled");
  });

  test("R-M11 budget-bypass: a denied reservation fails closed with zero effects; a permissive budget lets money move unheld", async () => {
    const world = await discriminationWorld();
    world.budget.failReserve = true;
    const created = await world.economics.createEconomicAction(createCommand(world), "m11:create");
    await expect(
      world.economics.authorizeEconomicAction(
        authorizeCommand(world, created.action.id),
        "m11:auth",
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(
      (await world.economics.getEconomicAction(world.applicationId, created.action.id))?.status,
    ).toBe("denied");
    expect(await world.store.listAuthorizationsOfApplication(world.applicationId)).toHaveLength(0);
    expect(world.rail.charges).toHaveLength(0);
    const events = await world.economics.listEconomicActionEvents(
      world.applicationId,
      created.action.id,
    );
    expect(events.find((event) => event.type === "action.denied")?.cause).toBe("budget");

    // MUTANT (observed violation): a permissive budget authority wired in —
    // the charge executes with NO hold at all.
    const permissive: BudgetAuthority = {
      reserve: async (command, _key) => ({
        reservation: fakeReservation(command),
        converged: false,
        replayed: false,
      }),
      settle: async (command, _key) => ({
        reservation: { ...fakeReservation(command), status: "settled" },
        converged: false,
        replayed: false,
      }),
      release: async (command, _key) => ({
        reservation: { ...fakeReservation(command), status: "released" },
        converged: false,
        replayed: false,
      }),
    };
    const mutantWorld = await discriminationWorld({ budget: permissive });
    const mutantActionId = await authorizedAction(mutantWorld, {}, "m11-mutant");
    const outcome = await mutantWorld.economics.chargeEconomicAction(
      chargeCommand(mutantWorld, mutantActionId),
      mutantWorld.rail,
      "m11:mutant-charge",
    );
    expect(outcome.action.status).toBe("settled"); // OBSERVED VIOLATION: unbudgeted money moved
    expect(outcome.settlement.settledAmountMicroUsd).toBe("125000");
  });

  test("R-M12 policy-bypass: the policy denial precedes capability, budget and rail; an allow-all seam is the violation", async () => {
    const world = await discriminationWorld();
    world.policy.decision = { allowed: false, reason: "purchase not permitted" };
    const created = await world.economics.createEconomicAction(createCommand(world), "m12:create");
    // The denial is journaled first, then thrown with the canonical code.
    await expect(
      world.economics.authorizeEconomicAction(
        authorizeCommand(world, created.action.id),
        "m12:auth",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.capability.calls).toHaveLength(0);
    expect(world.budget.reserveCalls).toHaveLength(0);
    expect(world.rail.charges).toHaveLength(0);
    const events = await world.economics.listEconomicActionEvents(
      world.applicationId,
      created.action.id,
    );
    expect(events.find((event) => event.type === "action.denied")?.cause).toBe("policy");

    // MUTANT (observed violation): allow-all admission wired at the seam.
    const mutantWorld = await discriminationWorld({
      policy: { evaluate: async () => ({ allowed: true }) },
    });
    const mutantId = await authorizedAction(mutantWorld, {}, "m12-mutant");
    const outcome = await mutantWorld.economics.chargeEconomicAction(
      chargeCommand(mutantWorld, mutantId),
      mutantWorld.rail,
      "m12:mutant-charge",
    );
    expect(outcome.action.status).toBe("settled"); // OBSERVED VIOLATION
  });

  test("R-M13 capability-bypass: an unmet capability precedes budget and rail; a permissive seam is the violation", async () => {
    const world = await discriminationWorld();
    world.capability.decision = { satisfied: false, unmet: ["payment-processor"] };
    const created = await world.economics.createEconomicAction(createCommand(world), "m13:create");
    // The denial is journaled first, then thrown with the canonical code.
    await expect(
      world.economics.authorizeEconomicAction(
        authorizeCommand(world, created.action.id),
        "m13:auth",
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(world.budget.reserveCalls).toHaveLength(0); // capability BEFORE budget
    expect(world.rail.charges).toHaveLength(0);
    const events = await world.economics.listEconomicActionEvents(
      world.applicationId,
      created.action.id,
    );
    expect(events.find((event) => event.type === "action.denied")?.cause).toBe("capability");

    // MUTANT (observed violation): an always-satisfied capability seam.
    const mutantWorld = await discriminationWorld({
      capability: { resolve: async () => ({ satisfied: true, unmet: [] }) },
    });
    const mutantId = await authorizedAction(mutantWorld, {}, "m13-mutant");
    const outcome = await mutantWorld.economics.chargeEconomicAction(
      chargeCommand(mutantWorld, mutantId),
      mutantWorld.rail,
      "m13:mutant-charge",
    );
    expect(outcome.action.status).toBe("settled"); // OBSERVED VIOLATION
  });

  test("R-M14 order-violation: a charge before the admission chain is unreachable (canonical failure, zero rail charges)", async () => {
    const world = await discriminationWorld();
    const created = await world.economics.createEconomicAction(createCommand(world), "m14:create");
    // The action is PROPOSED (policy/capability/budget never ran).
    await expect(
      world.economics.chargeEconomicAction(
        chargeCommand(world, created.action.id),
        world.rail,
        "m14:charge",
      ),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      message: expect.stringContaining("only an authorized action can be charged"),
    });
    expect(world.rail.charges).toHaveLength(0);
    expect(world.budget.reserveCalls).toHaveLength(0);

    // The full chain runs in order: ONE reservation before issuance,
    // bound to the action identity.
    const actionId = await authorizedAction(world, {}, "m14-order");
    expect(world.budget.reserveCalls).toHaveLength(1);
    expect(world.budget.reserveCalls[0]?.operationId).toBe(`econ-${actionId}`);
  });

  test("R-M15 double-reservation: a second authorization mint is rejected; a uniqueness-blind store exhibits the double hold", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m15");

    // PRODUCTION: the store refuses a second authorization for the action.
    const second: InsertAuthorizationInput = {
      id: "authorization-double-mint",
      economicActionId: actionId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      constraints: {},
      status: "active",
      reservationOperationId: `econ-${actionId}`,
      admissionEvidence: {},
      issuedAt: world.clock.now().toISOString(),
      expiresAt: world.expiresAt,
      createdAt: world.clock.now().toISOString(),
    };
    await expect(world.store.insertAuthorization(second)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    // Re-authorizing with a NEW idempotency key fails canonically; the
    // reservation happened exactly once.
    await expect(
      world.economics.authorizeEconomicAction(authorizeCommand(world, actionId), "m15:rekey"),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(world.budget.reserveCalls).toHaveLength(1);

    // MUTANT (observed violation): a uniqueness-blind store accepts the
    // second authorization — two holds for one action.
    const blind = new UniquenessBlindStore();
    const mutantWorld = await discriminationWorld({ store: blind });
    const mutantId = await authorizedAction(mutantWorld, {}, "m15-mutant");
    await blind.insertAuthorization({
      ...second,
      economicActionId: mutantId,
      applicationId: mutantWorld.applicationId,
      tenantId: mutantWorld.tenantId,
    });
    expect(await blind.listAuthorizationsOfApplication(mutantWorld.applicationId)).toHaveLength(2);
  });

  test("R-M16 idempotency-fingerprint-bypass: the same key with a mutated constraint fails IDEMPOTENCY_KEY_REUSED", async () => {
    const world = await discriminationWorld();
    await world.economics.createEconomicAction(createCommand(world), "m16-key");
    await expect(
      world.economics.createEconomicAction(
        createCommand(world, { amount: { kind: "exact", microUsd: "999999" } }),
        "m16-key",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // Exactly ONE durable operation under the key.
    expect(await world.store.listActionsOfApplication(world.applicationId)).toHaveLength(1);

    // MUTANT (observed violation): a fingerprint-blind ledger accepts the
    // second (different) operation under the same key. The executions
    // journal is deliberately re-run-permissive here (alwaysRunWork) so
    // the demonstration isolates the ECONOMICS ledger's blindness — the
    // executions ledger's own fingerprint rule is a separate defense.
    const mutantWorld = await discriminationWorld({
      idempotency: (store) => new FingerprintBlindIdempotency(store),
      executions: createInMemoryExecutions({
        idempotency: new InMemoryExecutionsIdempotency({ alwaysRunWork: true }),
      }),
    });
    await mutantWorld.economics.createEconomicAction(createCommand(mutantWorld), "m16-mutant-key");
    const second = await mutantWorld.economics.createEconomicAction(
      createCommand(mutantWorld, { amount: { kind: "exact", microUsd: "999999" } }),
      "m16-mutant-key",
    );
    expect(second.replayed).toBe(true); // the ledger "replayed" a DIFFERENT operation
    expect(
      await mutantWorld.store.listActionsOfApplication(mutantWorld.applicationId),
    ).toHaveLength(2); // OBSERVED VIOLATION: two durable operations under one key
  });

  test("R-M17 tenant-cross: a cross-tenant command is denied BEFORE any authority or side effect", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m17");

    await expect(
      world.economics.authorizeEconomicAction(
        authorizeCommand(world, actionId, { tenantId: "00000000-0000-7000-8000-0000000000dd" }),
        "m17:auth",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.economics.chargeEconomicAction(
        chargeCommand(world, actionId, { tenantId: "00000000-0000-7000-8000-0000000000dd" }),
        world.rail,
        "m17:charge",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(world.policy.calls).toHaveLength(1); // only the original authorize
    expect(world.budget.reserveCalls).toHaveLength(1);
    expect(world.rail.charges).toHaveLength(0);
  });

  test("R-M18 application-cross: a cross-application command sees nothing (indistinguishable from missing); execution substitution DENIED", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m18");

    // Cross-application: the row is invisible in the other application.
    await expect(
      world.economics.authorizeEconomicAction(
        authorizeCommand(world, actionId, {
          applicationId: "00000000-0000-7000-8000-2000999900001",
        }),
        "m18:auth",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(world.budget.reserveCalls).toHaveLength(1);
    expect(world.rail.charges).toHaveLength(0);

    // Execution substitution: the authorization is pinned to its execution.
    const store = new SubstitutedActionStore((record) => ({
      ...record,
      executionId: "00000000-0000-7000-8000-0000000000ff",
    }));
    const substitutionWorld = await discriminationWorld({ store });
    const substitutedId = await authorizedAction(substitutionWorld, {}, "m18-sub");
    store.arm();
    await expect(
      substitutionWorld.economics.chargeEconomicAction(
        chargeCommand(substitutionWorld, substitutedId),
        substitutionWorld.rail,
        "m18:charge",
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    const events = await substitutionWorld.economics.listEconomicActionEvents(
      substitutionWorld.applicationId,
      substitutedId,
    );
    expect(events.find((event) => event.type === "payment.rejected")?.reference).toMatchObject({
      code: "execution-substitution",
    });
  });

  test("R-M21 learning-authorization: the admission inputs are learning-free; a learning-informed seam is the violation", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m21");

    // PRODUCTION: the policy admission's ENTIRE input is {action, actorId}
    // — no learning fact/score can even reach a decision.
    expect(world.policy.calls).toHaveLength(1);
    expect(Object.keys(world.policy.calls[0] ?? {}).sort()).toEqual(["action", "actorId"]);
    const authorization = await world.store.getAuthorizationForAction(
      world.applicationId,
      actionId,
    );
    expect(authorization).not.toBeNull();
    expect(Object.keys((authorization as PaymentAuthorizationRecord).constraints).sort()).toEqual([
      "applicationId",
      "currency",
      "executionId",
      "expiresAt",
      "maxAmountMicroUsd",
      "minAmountMicroUsd",
      "purpose",
      "recipient",
      "requiredCapabilities",
      "reuse",
      "tenantId",
    ]);

    // MUTANT (observed violation): a learning-score-informed admission
    // wired at the seam authorizes what the real policy denies.
    const world2 = await discriminationWorld();
    world2.policy.decision = { allowed: false, reason: "not permitted by policy" };
    const denied = await world2.economics.createEconomicAction(createCommand(world2), "m21:create");
    await expect(
      world2.economics.authorizeEconomicAction(
        authorizeCommand(world2, denied.action.id),
        "m21:auth",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const learningInformed: EconomicPolicyAdmissionPort = {
      evaluate: async () => ({
        allowed: 0.99 > 0.5, // a fabricated learning score decides
        evidence: undefined,
      }),
    };
    const mutantWorld = await discriminationWorld({ policy: learningInformed });
    const mutantId = await authorizedAction(mutantWorld, {}, "m21-mutant");
    const outcome = await mutantWorld.economics.chargeEconomicAction(
      chargeCommand(mutantWorld, mutantId),
      mutantWorld.rail,
      "m21:mutant-charge",
    );
    expect(outcome.action.status).toBe("settled"); // OBSERVED VIOLATION: learning say-so moved money
  });

  test("R-M22 fail-open: a constraint-blind rail is refused BEFORE any charge", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m22");
    const blind = createConstraintBlindSimulatedRail("constraint-blind-rail");

    await expect(
      world.economics.chargeEconomicAction(chargeCommand(world, actionId), blind, "m22:charge"),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      message: expect.stringContaining("cannot express the required safety constraints"),
    });
    expect((await world.economics.getEconomicAction(world.applicationId, actionId))?.status).toBe(
      "authorized",
    );
    expect(world.budget.reserveCalls).toHaveLength(1); // the hold is untouched
  });

  test("R-M23 invalid-schema: closed-vocabulary, amount-shape and expiry violations are rejected with zero durable rows", async () => {
    const world = await discriminationWorld();
    const invalid: Partial<CreateEconomicActionCommand>[] = [
      { purpose: "bribery" }, // outside the closed purpose vocabulary
      { currency: "btc" }, // outside the closed currency vocabulary
      { recipient: { kind: "corporation", id: "x" } }, // outside the closed recipient vocabulary
      { amount: { kind: "exact", microUsd: "-5" } }, // negative amount
      { amount: { kind: "exact", microUsd: "12.5" } }, // fractional amount
      { amount: { kind: "range", minMicroUsd: "250000", maxMicroUsd: "100000" } }, // inverted range
      { expiresAt: "2020-01-01T00:00:00.000Z" }, // not in the future
    ];
    for (const [index, overrides] of invalid.entries()) {
      await expect(
        world.economics.createEconomicAction(createCommand(world, overrides), `m23-${index}`),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    }
    expect(await world.store.listActionsOfApplication(world.applicationId)).toHaveLength(0);
  });

  test("R-M24 provenance-omitted: missing, malformed and unknown provenance identities are rejected", async () => {
    const world = await discriminationWorld();
    const invalid: Partial<CreateEconomicActionCommand>[] = [
      { executionId: "" }, // no execution provenance
      { executionId: "not-a-uuid" }, // malformed execution identity
      { executionId: "00000000-0000-7000-8000-0000000000ef" }, // unknown execution
      { tenantId: "" }, // no tenant scope
      { applicationId: "" }, // no application scope
    ];
    for (const [index, overrides] of invalid.entries()) {
      await expect(
        world.economics.createEconomicAction(createCommand(world, overrides), `m24-${index}`),
      ).rejects.toThrow();
    }
    expect(await world.store.listActionsOfApplication(world.applicationId)).toHaveLength(0);
    // A well-formed command still passes (the rejections above are the
    // provenance gate, not a blanket refusal).
    const created = await world.economics.createEconomicAction(createCommand(world), "m24-ok");
    expect(created.action.executionId).toBe(world.executionId);
  });

  test("R-M25 history-mutation: terminal rows and the gapless event ledger are physically immutable; a lifecycle-blind store is the violation", async () => {
    const world = await discriminationWorld();
    const actionId = await authorizedAction(world, {}, "m25");
    await world.economics.chargeEconomicAction(
      chargeCommand(world, actionId),
      world.rail,
      "m25:charge",
    );
    expect((await world.economics.getEconomicAction(world.applicationId, actionId))?.status).toBe(
      "settled",
    );

    // A settled action cannot be rewritten.
    await expect(
      world.store.transitionEconomicAction(
        world.applicationId,
        actionId,
        ["settled"],
        "proposed",
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

    // Events are gapless per action: an out-of-sequence append is rejected.
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    const rogue: InsertEventInput = {
      eventId: "event-rogue",
      economicActionId: actionId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      sequence: events.length + 99,
      type: "action.recorded",
      cause: "caller",
      reference: {},
      payload: {},
      occurredAt: world.clock.now().toISOString(),
    };
    await expect(world.store.appendEvent(rogue)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });

    // No delete/update surface exists on the store port at all.
    const storeSurface = world.store as unknown as Record<string, unknown>;
    expect(storeSurface.deleteEconomicAction).toBeUndefined();
    expect(storeSurface.updateEconomicAction).toBeUndefined();
    expect(storeSurface.deleteEvent).toBeUndefined();

    // MUTANT (observed violation): a lifecycle-blind store rewrites the
    // settled action (history mutation).
    const mutantWorld = await discriminationWorld({ store: new LifecycleBlindStore() });
    const mutantId = await authorizedAction(mutantWorld, {}, "m25-mutant");
    await mutantWorld.economics.chargeEconomicAction(
      chargeCommand(mutantWorld, mutantId),
      mutantWorld.rail,
      "m25:mutant-charge",
    );
    expect(
      (await mutantWorld.economics.getEconomicAction(mutantWorld.applicationId, mutantId))?.status,
    ).toBe("settled");
    const rewritten = await mutantWorld.store.transitionEconomicAction(
      mutantWorld.applicationId,
      mutantId,
      ["settled"],
      "proposed",
      {},
    );
    expect(rewritten.status).toBe("proposed"); // OBSERVED VIOLATION: history rewritten
  });
});
