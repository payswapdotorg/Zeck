/**
 * Shared economics-boundary scanner (WORK-032, ECO-001..ECO-008).
 *
 * One definition of the governed ECONOMIC-ACTION boundary, two uses —
 * the architecture gate over the REAL src tree
 * (tests/architecture/economic-boundary.test.ts), and the discrimination
 * proofs over synthetic source mutations
 * (tests/discrimination/economics.discrimination.test.ts — the
 * WORK-006/007/010 scanner pattern: a protection only counts if its
 * removal is REJECTED).
 *
 * The boundary under protection (WORK-032 architecture invariants /
 * ADR-0018):
 *
 *   1. `economic-fingerprint-*` — MATERIAL economic constraints
 *      participate in the request fingerprint (recipient, amount bounds,
 *      currency, purpose, expiry, scope identities, capabilities, rail
 *      preference): a mutated constraint is a different logical
 *      operation.
 *   2. `economic-substitution-*` — the deterministic authorization
 *      firewall checks EVERY substitution class (status/single-use,
 *      expiry, action identity, recipient, currency, purpose, amount
 *      bounds, execution, application, tenant).
 *   3. `economic-order-*` — the admission chain order policy ->
 *      capability -> budget.reserve -> authorization issuance; the rail
 *      charge only AFTER the durable `executing` transition (journal
 *      then dispatch); the fail-closed rail capability gate BEFORE the
 *      charge.
 *   4. `economic-tenant-check` — every mutation path asserts the tenant
 *      row before any effect.
 *   5. `economic-rail-fail-open` — a rail that cannot express the
 *      required safety constraints must be refused (railCanExpress
 *      uses a strict every-constraint gate).
 *   6. `economic-rail-authority-verbs` — payment rails hold NO Zeck
 *      authority: no authority verbs on the rail contract, none in the
 *      payment-rails integration tree.
 *   7. `economic-provider-leak` — no payment-vendor identifier in the
 *      core contracts (domain/application/ports/public + API surface);
 *      rails stay behind the adapter boundary.
 *   8. `economic-credential-field` — no credential-shaped FIELD exists
 *      on the rail request, the authorization, the machine-payment
 *      signal, the action contract or the API wire serializers.
 *   9. `economics-imports-*` — the module consumes policy/budget/
 *      capability/execution authorities through their PUBLIC barrels
 *      only, never imports learning or verification, and its inner
 *      layers never touch the platform.
 *  10. `economics-second-ledger-*` — NO second financial ledger: the SQL
 *      adapter writes ONLY economics.* tables and REUSES
 *      platform.idempotency_records; migration 0014 creates no table
 *      outside the economics schema.
 *  11. `economic-learning-seam` — the service dependency surface stays
 *      pinned (no learning seam can be wired in).
 *  12. `economic-external-settlement-nonauthority` — the out-of-band
 *      settlement path journals evidence ONLY (no budget settle/release
 *      call, no authorization consumption, no action transition).
 *  13. `economic-migration-invariant-*` — migration 0014 keeps the
 *      physical guards (write-once identity, terminal-immutable
 *      lifecycle, append-only evidence, gapless events, bounded
 *      authorization expiry, unique convergence/reservation keys) and
 *      the closed cause vocabulary.
 */

import type { SourceFile } from "../../architecture/lib/dependency-rules";

export type { SourceFile };

/** Payment-vendor identifiers (M-provider-leak; never in core contracts). */
export const ECONOMIC_VENDOR_IDENTIFIER =
  /\b(stripe|paypal|braintree|adyen|worldpay|shopify_?pay|plaid|coinbase|revolut)\w*/i;

/** Credential-shaped FIELD declarations (M-credential-exposure). */
export const CREDENTIAL_FIELD_DECLARATION =
  /(?:readonly\s+)?(?:cardNumber|card_number|pan|cvv|cvc|expiry_month|expiry_year|apiKey|api_key|apikey|secret|password|credential|privateKey|private_key|accessToken|access_token|refreshToken|paymentToken|stripeToken|cardToken)\s*[?:]/;

/** The closed event cause vocabulary (pinned to migration 0014's CHECK). */
export const ECONOMIC_EVENT_CAUSES = [
  "economic-intent",
  "policy",
  "capability",
  "budget",
  "rail",
  "platform",
  "authorization",
  "external",
  "delivery-evidence",
  "caller",
] as const;

const SERVICE_PATH = "src/modules/economics/application/economic-action-service.ts";
const CONTRACTS_PATH = "src/modules/economics/application/economic-action-service.contracts.ts";
const AUTHORIZATION_PATH = "src/modules/economics/domain/authorization.ts";
const ACTION_PATH = "src/modules/economics/domain/economic-action.ts";
const RAIL_PATH = "src/modules/economics/domain/rail.ts";
const MACHINE_PAYMENT_PATH = "src/modules/economics/domain/machine-payment.ts";
const SQL_STORE_PATH = "src/modules/economics/adapters/sql-economic-store.ts";
const MIGRATION_PATH = "src/platform/db/migrations/0014_economic_actions.sql";
const API_ROUTES_PATH = "src/api/routes/economic-actions.ts";

export const ECONOMICS_CANONICAL_PATHS = [
  SERVICE_PATH,
  CONTRACTS_PATH,
  AUTHORIZATION_PATH,
  ACTION_PATH,
  RAIL_PATH,
  MACHINE_PAYMENT_PATH,
  SQL_STORE_PATH,
  MIGRATION_PATH,
  API_ROUTES_PATH,
] as const;

export function economicsBoundaryViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file] as const));

  const service = byPath.get(SERVICE_PATH);
  if (service === undefined) {
    return ["economics-service-missing"];
  }

  // (1) material constraints participate in the request fingerprint.
  const action = byPath.get(ACTION_PATH);
  if (action === undefined) {
    violations.push("economics-action-contract-missing");
  } else {
    const fingerprintWindow = sliceBetween(
      action.content,
      "export function economicActionFingerprintParts(",
      "\n}",
    );
    const requiredParts = [
      "draft.applicationId",
      "draft.tenantId",
      "draft.executionId",
      "draft.proposedBy",
      "draft.purpose",
      "draft.recipient.kind",
      "draft.recipient.id",
      "draft.currency",
      "draft.expiresAt",
      "draft.requiredCapabilities",
    ];
    for (const part of requiredParts) {
      if (!fingerprintWindow.includes(part)) {
        violations.push(`economic-fingerprint-part-missing:${part}`);
      }
    }
    // Amount bounds participate (exact AND range).
    if (
      !fingerprintWindow.includes("microUsd") ||
      !fingerprintWindow.includes("minMicroUsd") ||
      !fingerprintWindow.includes("maxMicroUsd")
    ) {
      violations.push("economic-fingerprint-amount-missing");
    }
    // Closed vocabularies stay validated (fail-closed draft validation).
    const validateWindow = sliceBetween(
      action.content,
      "export function validateEconomicActionDraft(",
      "\n}",
    );
    if (!validateWindow.includes("isEconomicPurpose(draft.purpose)")) {
      violations.push("economic-purpose-vocabulary-check-missing");
    }
    if (!validateWindow.includes("isEconomicCurrency(draft.currency)")) {
      violations.push("economic-currency-vocabulary-check-missing");
    }
    if (!validateWindow.includes("expiresAt <= now.getTime()")) {
      violations.push("economic-expiry-future-check-missing");
    }
  }

  // (2) the deterministic substitution/replay firewall.
  const authorization = byPath.get(AUTHORIZATION_PATH);
  if (authorization === undefined) {
    violations.push("economics-authorization-domain-missing");
  } else {
    const evaluationWindow = sliceBetween(
      authorization.content,
      "export function evaluateAuthorizationUse(",
      "\n}",
    );
    const substitutionChecks: Array<[string, string]> = [
      ["status", 'authorization.status !== "active"'],
      ["expiry", "Date.parse(authorization.expiresAt)"],
      ["action", "authorization.economicActionId !== use.economicActionId"],
      ["recipient", "sameRecipient(authorization.constraints.recipient, use.recipient)"],
      ["currency", "authorization.constraints.currency !== use.currency"],
      ["purpose", "authorization.constraints.purpose !== use.purpose"],
      ["amount", "amountWithinBounds("],
      ["execution", "authorization.constraints.executionId !== use.executionId"],
      ["application", "authorization.constraints.applicationId !== use.applicationId"],
      ["tenant", "authorization.constraints.tenantId !== use.tenantId"],
    ];
    for (const [label, marker] of substitutionChecks) {
      if (!evaluationWindow.includes(marker)) {
        violations.push(`economic-substitution-check-missing:${label}`);
      }
    }
    // Bounded authorization: v1 reuse is single-use only.
    if (!authorization.content.includes('"single-use"')) {
      violations.push("economic-authorization-reuse-policy-missing");
    }
  }

  // (3)+(4) the admission-chain order and the tenant check.
  const authorizeWindow = sliceBetween(
    service.content,
    "async authorizeEconomicAction(command, idempotencyKey)",
    "async chargeEconomicAction(command, rail, idempotencyKey)",
  );
  if (authorizeWindow.length === 0) {
    violations.push("economics-authorize-window-missing");
  } else {
    const policyAt = authorizeWindow.indexOf("policy.evaluate(");
    const capabilityAt = authorizeWindow.indexOf("capabilities.resolve(");
    const reserveAt = authorizeWindow.indexOf("budget.reserve(");
    const issueAt = authorizeWindow.indexOf("store.insertAuthorization({");
    if (policyAt < 0) {
      violations.push("economic-policy-gate-missing");
    }
    if (capabilityAt < 0) {
      violations.push("economic-capability-gate-missing");
    }
    if (reserveAt < 0) {
      violations.push("economic-budget-reserve-missing");
    }
    if (issueAt < 0) {
      violations.push("economic-authorization-issuance-missing");
    }
    if (policyAt >= 0 && capabilityAt >= 0 && policyAt > capabilityAt) {
      violations.push("economic-policy-gate-after-capability");
    }
    if (capabilityAt >= 0 && reserveAt >= 0 && capabilityAt > reserveAt) {
      violations.push("economic-capability-gate-after-budget");
    }
    if (reserveAt >= 0 && issueAt >= 0 && reserveAt > issueAt) {
      violations.push("economic-authorization-before-budget");
    }
    // Every admission denial is journaled with its cause class.
    for (const cause of ["policy", "capability", "budget"]) {
      if (!authorizeWindow.includes(`cause: "${cause}"`)) {
        violations.push(`economic-denial-journal-missing:${cause}`);
      }
    }
  }
  const chargeWindow = sliceBetween(
    service.content,
    "async chargeEconomicAction(command, rail, idempotencyKey)",
    "async recordExternalSettlement(command, idempotencyKey)",
  );
  if (chargeWindow.length === 0) {
    violations.push("economics-charge-window-missing");
  } else {
    const railGateAt = chargeWindow.indexOf("railCanExpressConstraints(rail.capabilities)");
    const evaluatingAt = chargeWindow.indexOf('"executing"');
    const railChargeAt = chargeWindow.indexOf("await rail.charge(");
    if (railGateAt < 0) {
      violations.push("economic-rail-fail-open-gate-missing");
    }
    if (railChargeAt < 0) {
      violations.push("economic-rail-charge-missing");
    }
    if (railGateAt >= 0 && railChargeAt >= 0 && railGateAt > railChargeAt) {
      violations.push("economic-rail-gate-after-charge");
    }
    if (evaluatingAt >= 0 && railChargeAt >= 0 && evaluatingAt > railChargeAt) {
      violations.push("economic-rail-charge-before-durable-transition");
    }
    // The substitution firewall is consulted on the charge path.
    if (!chargeWindow.includes("evaluateAuthorizationUse(")) {
      violations.push("economic-charge-substitution-firewall-missing");
    }
    // Budget settlement flows through the authority on success,
    // release on failure (no second ledger path).
    if (!chargeWindow.includes("budget.settle(") || !chargeWindow.includes("budget.release(")) {
      violations.push("economic-charge-budget-authority-missing");
    }
  }
  const externalWindow = sliceBetween(
    service.content,
    "async recordExternalSettlement(command, idempotencyKey)",
    "async recordDeliveryObservation(command, idempotencyKey)",
  );
  if (externalWindow.length === 0) {
    violations.push("economics-external-settlement-window-missing");
  } else {
    // Correlated evidence ONLY: no budget mutation, no authorization
    // consumption, no action transition on the external path.
    if (/budget\.(settle|release|reserve)\(/.test(externalWindow)) {
      violations.push("economic-external-settlement-budget-mutation");
    }
    if (/transitionAuthorization\(|transitionEconomicAction\(/.test(externalWindow)) {
      violations.push("economic-external-settlement-state-mutation");
    }
  }
  const tenantChecks = countOccurrences(service.content, "assertTenantRow(command,");
  if (tenantChecks < 4) {
    violations.push(`economic-tenant-check-missing:${tenantChecks}/4`);
  }

  // (5) the fail-closed rail capability gate is strict.
  const rail = byPath.get(RAIL_PATH);
  if (rail === undefined) {
    violations.push("economics-rail-domain-missing");
  } else {
    if (!/REQUIRED_RAIL_CAPABILITY_KEYS\.every\(/.test(rail.content)) {
      violations.push("economic-rail-fail-open-every-missing");
    }
    if (!/capabilities\[key\] === true/.test(rail.content)) {
      violations.push("economic-rail-fail-open-strict-true-missing");
    }
    // The rail contract carries exactly the charge surface (no
    // authority verbs on the adapter port).
    const portWindow = sliceBetween(rail.content, "export interface PaymentRail {", "}");
    for (const verb of [
      "authorize",
      "reserve",
      "settle",
      "release",
      "verify",
      "admit",
      "approve",
    ]) {
      if (new RegExp(`\\b${verb}\\s*[(:]`).test(portWindow)) {
        violations.push(`economic-rail-authority-verb:${verb}`);
      }
    }
    // The charge request has NO credential field.
    const requestWindow = sliceBetween(rail.content, "export interface RailPaymentRequest {", "}");
    if (CREDENTIAL_FIELD_DECLARATION.test(requestWindow)) {
      violations.push("economic-rail-request-credential-field");
    }
  }

  // (6) payment-rails adapters hold NO authority verbs at all.
  for (const file of files) {
    if (!file.path.startsWith("src/integrations/payment-rails/")) {
      continue;
    }
    if (/\.(reserve|settle|release|authorize|admit|verify)\s*\(/.test(file.content)) {
      violations.push(`economic-rail-authority-verbs:${file.path}`);
    }
    if (/modules\/(policies|budgets|verification|learning|capabilities)\//.test(file.content)) {
      violations.push(`economic-rail-authority-import:${file.path}`);
    }
  }

  // (7) provider/vendor neutrality in the core contracts.
  for (const file of files) {
    if (!file.path.startsWith("src/modules/economics/") || file.path.includes("/adapters/")) {
      continue; // adapters may name neutral rail slugs in composition
    }
    if (ECONOMIC_VENDOR_IDENTIFIER.test(file.content)) {
      violations.push(`economic-provider-leak:${file.path}`);
    }
  }
  const apiRoutes = byPath.get(API_ROUTES_PATH);
  if (apiRoutes !== undefined && ECONOMIC_VENDOR_IDENTIFIER.test(apiRoutes.content)) {
    violations.push("economic-provider-leak:src/api/routes/economic-actions.ts");
  }

  // (8) no credential-shaped FIELD on the core contracts.
  const machinePayment = byPath.get(MACHINE_PAYMENT_PATH);
  if (machinePayment === undefined) {
    violations.push("economics-machine-payment-missing");
  } else {
    // The 402 parser is a pure parser: it exposes no authorization
    // surface (a 402 NEVER authorizes).
    if (
      /authorize|mint|approve/i.test(
        machinePayment.content.replace(
          /NEVER an authorization|authorizes NOTHING|authorization:|cannot mint|authorization\b/gi,
          "",
        ),
      )
    ) {
      violations.push("economic-402-authorization-surface");
    }
    for (const match of machinePayment.content.matchAll(
      /export\s+(?:async\s+)?function\s+(\w+)/g,
    )) {
      if (/authorize|mint|approve|permit/i.test(match[1] ?? "")) {
        violations.push("economic-402-authorization-function");
      }
    }
  }
  const contracts = byPath.get(CONTRACTS_PATH);
  if (contracts === undefined) {
    violations.push("economics-service-contracts-missing");
  } else {
    if (CREDENTIAL_FIELD_DECLARATION.test(contracts.content)) {
      violations.push("economic-command-credential-field");
    }
    // (11) the service dependency surface stays pinned: no learning seam.
    const depsMatch = /interface EconomicActionServiceDeps \{([\s\S]*?)\n\}/.exec(
      contracts.content,
    );
    if (depsMatch === null) {
      violations.push("economic-service-deps-shape-missing");
    } else {
      const fields = [...(depsMatch[1] ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map((f) => f[1]);
      const expected = [
        "budget",
        "capabilities",
        "executions",
        "generateId",
        "idempotency",
        "now",
        "policy",
        "store",
      ];
      if (JSON.stringify(fields.sort()) !== JSON.stringify(expected)) {
        violations.push("economic-service-deps-shape-changed");
      }
    }
  }

  // (9) imports: public barrels only; no learning; no verification.
  for (const file of files) {
    if (!file.path.startsWith("src/modules/economics/")) {
      continue;
    }
    for (const match of file.content.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const specifier = match[1] ?? "";
      const cross = /(?:\.\.\/)+([a-z0-9-]+)\//.exec(specifier);
      if (cross === null || cross[1] === "shared") {
        continue;
      }
      const target = cross[1] ?? "";
      if (target === "learning" || target === "verification") {
        violations.push(`economics-forbidden-module-import:${file.path}:${target}`);
      } else if (["policies", "capabilities", "budgets", "executions"].includes(target)) {
        if (!specifier.endsWith("/public")) {
          violations.push(`economics-authority-internal-import:${file.path}:${specifier}`);
        }
      } else {
        violations.push(`economics-unexpected-module-import:${file.path}:${target}`);
      }
    }
    const layer = file.path.split("/").at(-2) ?? "";
    if (["domain", "application", "ports"].includes(layer)) {
      if (/from\s+["']\.\.\/\.\.\/\.\.\/platform\//.test(file.content)) {
        violations.push(`economics-inner-layer-platform-import:${file.path}`);
      }
    }
  }

  // (10) NO second financial ledger: SQL writes economics.* only and
  // REUSES platform.idempotency_records.
  const sqlStore = byPath.get(SQL_STORE_PATH);
  if (sqlStore === undefined) {
    violations.push("economics-sql-store-missing");
  } else {
    if (/INSERT INTO (budgets|executions|applications|verification)\./.test(sqlStore.content)) {
      violations.push("economics-second-ledger-write");
    }
    if (!sqlStore.content.includes("platform.idempotency_records")) {
      violations.push("economics-idempotency-ledger-reuse-missing");
    }
    if (/CREATE TABLE/i.test(sqlStore.content)) {
      violations.push("economics-adapter-creates-tables");
    }
  }

  // (13) migration 0014 physical invariants stay shipped.
  const migration = byPath.get(MIGRATION_PATH);
  if (migration === undefined) {
    violations.push("economics-migration-missing");
  } else {
    for (const table of [
      "economics.economic_actions",
      "economics.payment_authorizations",
      "economics.settlement_observations",
      "economics.delivery_observations",
      "economics.economic_action_events",
    ]) {
      if (!migration.content.includes(`CREATE TABLE ${table} (`)) {
        violations.push(`economic-migration-table-missing:${table}`);
      }
    }
    // No table outside the economics schema (no second ledger).
    for (const match of migration.content.matchAll(/CREATE TABLE\s+([a-z_]+)\.([a-z_]+)/g)) {
      if (match[1] !== "economics") {
        violations.push(`economic-migration-foreign-table:${match[0]}`);
      }
    }
    for (const guard of [
      "economic_actions_no_delete",
      "economic_actions_immutable_identity",
      "economic_actions_lifecycle",
      "payment_authorizations_no_delete",
      "payment_authorizations_immutable_constraints",
      "payment_authorizations_lifecycle",
      "payment_authorizations_bounded_expiry",
      "settlement_observations_append_only",
      "delivery_observations_append_only",
      "economic_action_events_append_only",
      "economic_action_events_gapless_sequence",
    ]) {
      if (!migration.content.includes(guard)) {
        violations.push(`economic-migration-guard-missing:${guard}`);
      }
    }
    for (const unique of [
      "payment_authorizations_action_key",
      "payment_authorizations_reservation_key",
      "settlement_observations_convergence_key",
      "economic_action_events_sequence_key",
    ]) {
      if (!migration.content.includes(unique)) {
        violations.push(`economic-migration-unique-missing:${unique}`);
      }
    }
    // The closed cause vocabulary (a future addition requires a migration).
    const causeCheck =
      /economic_action_events_cause_vocabulary CHECK \(\s*cause IN \(([^)]*)\)/.exec(
        migration.content,
      );
    if (causeCheck === null) {
      violations.push("economic-migration-cause-vocabulary-missing");
    } else {
      const causes = (causeCheck[1] ?? "")
        .split(",")
        .map((value) => value.trim().replaceAll("'", ""))
        .filter((value) => value.length > 0)
        .sort();
      if (JSON.stringify(causes) !== JSON.stringify([...ECONOMIC_EVENT_CAUSES].sort())) {
        violations.push("economic-migration-cause-vocabulary-changed");
      }
    }
  }

  return violations;
}

/** True when the canonical protected surface exists in the scanned set. */
export function hasCanonicalEconomicsBoundary(files: readonly SourceFile[]): boolean {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  return (
    byPath.get(SERVICE_PATH) !== undefined &&
    byPath.get(AUTHORIZATION_PATH) !== undefined &&
    byPath.get(RAIL_PATH) !== undefined &&
    byPath.get(MIGRATION_PATH) !== undefined
  );
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    return "";
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}
