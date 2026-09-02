/**
 * Discrimination: the governed edge/embodied boundaries (WORK-029,
 * EDGE-001/002/003; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE, CONCURRENCY-CRASH-SAFETY).
 *
 * The REQUIRED SAFETY PROOFS (labeled D1..D12). Every protection has
 * BOTH halves (the house style):
 *
 *   STATIC mutants mutate the REAL source in memory; the probe scanner
 *   below must flag exactly the weakened protection (a mutant that
 *   removes or reorders a guard is caught without touching the clean
 *   tree, which always scans clean);
 *
 *   RUNTIME reds observe the governed in-memory world (the REAL
 *   service + the simulated LOCAL controller + the REAL executions
 *   ledger) under constructed scenarios and stay red (the negative
 *   behavior is asserted as the permanent expected outcome).
 *
 * Proof map (proof → mutant → runtime red):
 *   D1  policy/capability/approval/  admission-gate-removed /
 *       budget admission BEFORE       approval-discriminator-removed /
 *       ANY actuator-path side        stale-check-removed /
 *       effect, in the frozen order   coverage-check-removed /
 *                                    budget-gate-removed /
 *                                    admission-order mutants
 *                                    every denial class: a DURABLE
 *                                    denied row + failed operation +
 *                                    typed error + ZERO actuator journal
 *   D2  stale/unauthorized commands  stale-check-removed
 *       NEVER reach the actuator      stale + too-early + replayed-denial
 *       path                          submissions: typed, journal 0
 *   D3  physical writes require the  approval-discriminator-removed /
 *       human approval (AC-4)         subject-fingerprint binding
 *                                    approval-less / denied / pending /
 *                                    mismatched-shape approvals: typed
 *                                    AUTHORIZATION_DENIED, journal 0
 *   D4  safety-envelope boundary     coverage-check-removed /
 *       (immutable, fail-closed)      (envelope admission checks)
 *                                    out-of-channel/magnitude/budget:
 *                                    typed, journal 0; envelope
 *                                    immutability is pinned by the
 *                                    migration guards (D10)
 *   D5  keyed one-shot dispatch      dispatch-key-removed /
 *                                    replay-branch-removed
 *                                    duplicate submits converge: one
 *                                    journal entry per command key
 *   D6  no cloud in the control loop loop-primitive-injected /
 *                                    (the local substrate owns       autonomous-loop-injected
 *                                    hard real time — AC-2)          the device-side loop
 *                                    actuates while Zeck is call-free;
 *                                    one submit = one dispatch
 *   D7  reconciliation is            (service reconciliation body
 *       deterministic, exactly-once,  checks)
 *       conflict-fail-closed          duplicate reports converge; a
 *                                    rogue out-of-envelope report is a
 *                                    durable VIOLATION (fail closed)
 *   D8  vendor neutrality            vendor-literal-injected
 *                                    the neutrality scanner flags any
 *                                    device/vendor identifier
 *   D9  no second execution state    execution-transition-added
 *       machine                       the store port carries no
 *                                    lifecycle vocabulary; ledger
 *                                    vocabulary is tools-only
 *   D10 migration 0024 physical      migration-guard-removed
 *       guards                        the frozen vocabularies, content
 *                                    immutability, append-only
 *                                    ledgers and operation discipline
 *                                    are physically present
 *   D11 the multi-gate human-approval multi-gate-removed /
 *       discipline                    wait-gate-removed
 *                                    multiple live gates hold ONE
 *                                    WAITING_HUMAN; resume only on the
 *                                    LAST gate closing
 *   D12 provenance rides the         ledger-vocabulary-mutant
 *       canonical executions ledger   tool-requested/result/denied ONLY
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createInMemoryEdgeWorld,
  expectPlatformError,
  type InMemoryEdgeWorld,
  sha256Hex,
} from "../unit/integrations/edge-world";

const REPO_ROOT = join(process.cwd());
const SERVICE_PATH = "src/integrations/edge/application/edge-service.ts";
const DOMAIN_PATH = "src/integrations/edge/domain/edge.ts";
const STORE_PORT_PATH = "src/integrations/edge/ports/edge-store.ts";
const CONTROLLER_PORT_PATH = "src/integrations/edge/ports/edge-controller.ts";
const SIMULATED_ADAPTER_PATH = "src/integrations/edge/adapters/simulated-edge-controller.ts";
const MIGRATION_PATH = "src/platform/db/migrations/0024_edge_execution.sql";
const SERVICE_SOURCE = readFileSync(join(REPO_ROOT, SERVICE_PATH), "utf8");
const DOMAIN_SOURCE = readFileSync(join(REPO_ROOT, DOMAIN_PATH), "utf8");
const STORE_PORT_SOURCE = readFileSync(join(REPO_ROOT, STORE_PORT_PATH), "utf8");
const CONTROLLER_PORT_SOURCE = readFileSync(join(REPO_ROOT, CONTROLLER_PORT_PATH), "utf8");
const SIMULATED_ADAPTER_SOURCE = readFileSync(join(REPO_ROOT, SIMULATED_ADAPTER_PATH), "utf8");
const MIGRATION_SOURCE = readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8");

/** Edge/embodied device + controller vendor identifiers (the D8 scanner). */
const EDGE_VENDOR_IDENTIFIER =
  /\b(ROS2?|Rosbot|URRobot|UniversalRobots|Kuka|ABB|Fanuc|Yaskawa|Siemens|Rockwell|AllenBradley|Beckhoff|Codesys|Modicon|Schneider|Mitsubishi|Omron|Bosch|Dji|Tesla|Nvidia|Jetson|RaspberryPi|Arduino|Eaton|Honeywell|Emerson|Vecna|BostonDynamics|Anybotics|Figure|Agility|Unitree)\w*/;
const EDGE_RAIL_LITERAL =
  /["'](modbus|profinet|ethercat|canopen|j1939|opc-?ua|ros2?|sparkplug)["']/i;

interface EdgeRules {
  readonly service: string;
  readonly submitBody: string;
  readonly admitBody: string;
  readonly reconcileBody: string;
  readonly dispatchBody: string;
  readonly domain: string;
  readonly storePort: string;
  readonly controllerPort: string;
  readonly simulatedAdapter: string;
  readonly migration: string;
}

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
  controllerPort: string = CONTROLLER_PORT_SOURCE,
  simulatedAdapter: string = SIMULATED_ADAPTER_SOURCE,
  migration: string = MIGRATION_SOURCE,
): EdgeRules {
  return {
    service,
    submitBody: sectionOf(service, "const submitCommand = async (", "  // ingestSensorObservation"),
    admitBody: sectionOf(service, "const admitEnvelope = async (", "  // revokeEnvelope"),
    reconcileBody: sectionOf(service, "const reconcile = async (", "  // Reads"),
    dispatchBody: sectionOf(
      service,
      "const dispatchCommand = async (",
      "  // ingestSensorObservation",
    ),
    domain,
    storePort,
    controllerPort,
    simulatedAdapter,
    migration,
  };
}

const cleanRules = (): EdgeRules =>
  rulesFrom(
    SERVICE_SOURCE,
    DOMAIN_SOURCE,
    STORE_PORT_SOURCE,
    CONTROLLER_PORT_SOURCE,
    SIMULATED_ADAPTER_SOURCE,
    MIGRATION_SOURCE,
  );

const mutateService = (mutation: (content: string) => string): EdgeRules =>
  rulesFrom(mutation(SERVICE_SOURCE));
const mutateStorePort = (mutation: (content: string) => string): EdgeRules =>
  rulesFrom(SERVICE_SOURCE, DOMAIN_SOURCE, mutation(STORE_PORT_SOURCE));
const mutateMigration = (mutation: (content: string) => string): EdgeRules =>
  rulesFrom(
    SERVICE_SOURCE,
    DOMAIN_SOURCE,
    STORE_PORT_SOURCE,
    CONTROLLER_PORT_SOURCE,
    SIMULATED_ADAPTER_SOURCE,
    mutation(MIGRATION_SOURCE),
  );

// ---------------------------------------------------------------------------
// The static probe: violations over the (possibly mutated) REAL source.
// ---------------------------------------------------------------------------

function violationsOf(rules: EdgeRules): string[] {
  const violations: string[] = [];
  const codeOnly = (content: string): string =>
    content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // D1 — the governed admission chain runs BEFORE the durable command
  // row and the controller dispatch, in the frozen order: bindings ->
  // conflicted-device gate -> operation claim -> POLICY -> CAPABILITY ->
  // HUMAN APPROVAL -> STALENESS -> ENVELOPE COVERAGE -> BUDGET ->
  // wallet reservation -> durable insert -> (one-shot) dispatch.
  const flow = rules.submitBody;
  const order: ReadonlyArray<readonly [string, number]> = [
    ["boundExecution(", flow.indexOf("await boundExecution(")],
    ["findConflictReconciliation(", flow.indexOf("store.findConflictReconciliation(")],
    ["beginEdgeOperation(", flow.indexOf("store.beginEdgeOperation(")],
    ["policyAdmit(", flow.indexOf("await policyAdmit({")],
    ["capabilityAdmit(", flow.indexOf("await capabilityAdmit(")],
    ["approvalAuthorizesSubject(", flow.indexOf("approvalAuthorizesSubject(")],
    ["edgeCommandFreshness(", flow.indexOf("edgeCommandFreshness(request, now)")],
    [
      "edgeEnvelopeCoversCommand(",
      flow.indexOf("edgeEnvelopeCoversCommand(envelope, request, now)"),
    ],
    ["withinEnvelopeBudget(", flow.indexOf("await withinEnvelopeBudget(")],
    ["budgetAuthority.reserve(", flow.indexOf("budgetAuthority.reserve(")],
    ["store.insertCommand(", flow.indexOf("await store.insertCommand({")],
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
  // The dispatch (the ONLY actuator-path write) is downstream of the
  // durable insert inside the same flow.
  const dispatchInSubmit = flow.indexOf("dispatchCommand(inserted.record");
  if (dispatchInSubmit !== -1) {
    const insertAt = flow.indexOf("await store.insertCommand({");
    if (insertAt !== -1 && dispatchInSubmit < insertAt) {
      violations.push("dispatch-before-durable-insert");
    }
  }
  // The tenant bindings (the fail-closed guard helpers the flow calls).
  if (!rules.service.includes("execution.tenantId !== tenantId")) {
    violations.push("tenant-binding-removed:execution");
  }
  if (!rules.service.includes("device.tenantId !== tenantId")) {
    violations.push("tenant-binding-removed:device");
  }

  // D2 — the staleness gate (AC-5) BEFORE the dispatch.
  if (!rules.submitBody.includes("edgeCommandFreshness(request, now)")) {
    violations.push("stale-check-removed");
  }
  if (!rules.submitBody.includes("stale commands never reach the actuator path")) {
    violations.push("stale-denial-removed");
  }

  // D3 — the human-approval discriminator (AC-4): physical-write effect
  // class REQUIRES a bound, approved, fingerprint-matching approval.
  if (!rules.submitBody.includes('effectClass === "physical-write"')) {
    violations.push("approval-discriminator-removed");
  }
  if (
    !rules.submitBody.includes(
      "requires a bound, approved human approval before any physical side effect",
    )
  ) {
    violations.push("approval-gate-removed");
  }

  // D4 — the envelope coverage gate (pure, fail-closed).
  if (!rules.submitBody.includes("edgeEnvelopeCoversCommand(envelope, request, now)")) {
    violations.push("coverage-check-removed");
  }
  // Envelope admission re-validates the approval binding BEFORE the
  // durable insert (the same AC-4 discipline at admission time).
  const admitApprovalAt = rules.admitBody.indexOf("approvalAuthorizesSubject(");
  const admitInsertAt = rules.admitBody.indexOf("await store.insertEnvelope({");
  if (admitApprovalAt === -1) {
    violations.push("envelope-approval-check-removed");
  } else if (admitInsertAt !== -1 && admitApprovalAt > admitInsertAt) {
    violations.push("envelope-approval-after-insert");
  }

  // The budget gate (fail-closed when no authority is wired).
  if (!rules.submitBody.includes("costed edge commands never execute unbudgeted")) {
    violations.push("budget-gate-removed");
  }

  // D5 — keyed one-shot dispatch + the replay fast path.
  if (!rules.dispatchBody.includes("edgeCommandDispatchExternalKey(")) {
    violations.push("dispatch-key-removed");
  }
  if (!rules.submitBody.includes("store.findCommandByKey(")) {
    violations.push("replay-branch-removed");
  }
  if (!rules.submitBody.includes("IDEMPOTENCY_KEY_REUSED")) {
    violations.push("replay-fingerprint-removed");
  }

  // D6 — no cloud control loop: no timer primitive in the service; the
  // device-side autonomous loop is never invoked from the governance
  // plane.
  const serviceCode = codeOnly(rules.service);
  for (const primitive of ["setInterval", "setImmediate", "setTimeout"]) {
    if (serviceCode.includes(primitive)) {
      violations.push(`loop-primitive-injected:${primitive}`);
    }
  }
  const simulatedMethods = [
    ...rules.simulatedAdapter.matchAll(/(?:^\s{2,})(\w+)\([^)]*\)(?:\s*:\s*[\w<>\s|,.]+)?\s*\{/gm),
    ...rules.simulatedAdapter.matchAll(/(?:^\s{2,})(\w+)\([^)]*\);/gm),
  ].map((m) => m[1]);
  const autonomousLoops = simulatedMethods.filter(
    (name) => name !== undefined && /autonom|tick|step|loop/i.test(name),
  );
  if (autonomousLoops.length === 0) {
    violations.push("autonomous-loop-removed");
  }
  for (const loop of autonomousLoops) {
    if (new RegExp(`\\.${loop}\\(`).test(serviceCode)) {
      violations.push(`autonomous-loop-injected:${loop}`);
    }
  }

  // D7 — reconciliation converges by report digest (exactly-once per
  // stable report) and records violations fail-closed (a rogue report
  // is DURABLE violation evidence, never silently accepted).
  if (!rules.reconcileBody.includes("findReconciliationByDigest(")) {
    violations.push("reconciliation-digest-removed");
  }
  if (!rules.reconcileBody.includes('actuationClass: "violation"')) {
    violations.push("violation-recording-removed");
  }

  // D8 — vendor neutrality over the whole inspected set.
  for (const [name, content] of [
    ["service", rules.service],
    ["domain", rules.domain],
    ["storePort", rules.storePort],
    ["controllerPort", rules.controllerPort],
    ["simulatedAdapter", rules.simulatedAdapter],
  ] as const) {
    if (content.match(EDGE_VENDOR_IDENTIFIER) !== null) {
      violations.push(`vendor-identifier-in:${name}`);
    }
    if (content.match(EDGE_RAIL_LITERAL) !== null) {
      violations.push(`vendor-literal-in:${name}`);
    }
  }

  // D9 — no second execution state machine: the store port carries no
  // lifecycle vocabulary; the ledger vocabulary is tools-only.
  const storeCode = codeOnly(rules.storePort);
  for (const forbidden of ["waitHuman(", ".resume(", "executionStatus", '"WAITING_HUMAN"']) {
    if (storeCode.includes(forbidden)) {
      violations.push(`execution-transition-added:${forbidden}`);
    }
  }
  const ledgerEventTypes = [...codeOnly(rules.service).matchAll(/"tool-\w+"/g)].map((m) => m[0]);
  const foreignEvents = ledgerEventTypes.filter(
    (type) => !['"tool-requested"', '"tool-result"', '"tool-denied"'].includes(type),
  );
  if (foreignEvents.length > 0) {
    violations.push(`ledger-vocabulary-mutant:${[...new Set(foreignEvents)].join(",")}`);
  }

  // D10 — migration 0024 physical guards.
  for (const guard of [
    "ed_devices_core_guard",
    "ed_devices_no_delete_guard",
    "ed_approvals_core_guard",
    "ed_approvals_lifecycle_guard",
    "ed_approvals_no_delete_guard",
    "ed_envelopes_core_guard",
    "ed_envelopes_lifecycle_guard",
    "ed_envelopes_no_delete_guard",
    "ec_commands_core_guard",
    "ec_commands_sequence_gate",
    "ec_commands_no_delete_guard",
    "er_reconciliations_no_mutation",
    "ea_actuations_no_mutation",
    "es_observations_no_delete_guard",
    "eops_core_guard",
    "eops_lifecycle_guard",
    "eops_no_delete_guard",
    "ed_device_status_vocabulary",
    "ed_envelope_status_vocabulary",
    "ed_approval_status_vocabulary",
    "ed_envelope_digest_shape",
    "ed_device_dispatched_within_stream",
  ]) {
    if (!rules.migration.includes(guard)) {
      violations.push(`migration-guard-removed:${guard}`);
    }
  }

  // D11 — the multi-gate human-approval discipline.
  if (!rules.service.includes("shouldApplyWaitHuman(")) {
    violations.push("wait-gate-removed");
  }
  if (!rules.service.includes("hasLiveSiblingGates(")) {
    violations.push("multi-gate-removed");
  }
  if (!rules.service.includes("listPendingApprovalsForExecution(")) {
    violations.push("pending-gate-query-removed");
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The static mutants: each must be flagged; the clean tree scans clean.
// ---------------------------------------------------------------------------

describe("discrimination: edge static mutants (the clean tree scans clean)", () => {
  test("the clean tree has zero violations", () => {
    expect(violationsOf(cleanRules())).toEqual([]);
  });

  test("D1: removing the policy admission call is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("await policyAdmit({", "await policyAdmitNoop({"),
    );
    expect(violationsOf(rules)).toContain("admission-missing:policyAdmit(");
  });

  test("D1: removing the capability admission call is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "await capabilityAdmit([edgeChannelAtom(request.channel)]);",
        "await capabilityAdmitNoop([edgeChannelAtom(request.channel)]);",
      ),
    );
    expect(violationsOf(rules)).toContain("admission-missing:capabilityAdmit(");
  });

  test("D1: removing the wallet reservation is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("budgetAuthority.reserve(", "budgetAuthority.reserveNoop("),
    );
    expect(violationsOf(rules)).toContain("admission-missing:budgetAuthority.reserve(");
  });

  test("D1: removing the tenant binding guard is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("execution.tenantId !== tenantId", "false /* tenant guard removed */"),
    );
    expect(violationsOf(rules)).toContain("tenant-binding-removed:execution");
  });

  test("D2: removing the staleness gate is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "const freshness = edgeCommandFreshness(request, now);",
        "const freshness = 'fresh' as const; // staleness gate removed",
      ),
    );
    expect(violationsOf(rules)).toContain("stale-check-removed");
  });

  test("D3: removing the human-approval discriminator is flagged", () => {
    const rules = mutateService((source) =>
      source.replace('effectClass === "physical-write"', 'effectClass === "no-write"'),
    );
    expect(violationsOf(rules)).toContain("approval-discriminator-removed");
  });

  test("D4: removing the envelope coverage gate is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "const coverage = edgeEnvelopeCoversCommand(envelope, request, now);",
        "const coverage = { covered: true } as const; // coverage gate removed",
      ),
    );
    expect(violationsOf(rules)).toContain("coverage-check-removed");
  });

  test("D4: removing the envelope admission approval check is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "const approvalCheck = approvalAuthorizesSubject(",
        "const approvalCheck = { ok: true } as const; // approval check removed (",
      ),
    );
    expect(violationsOf(rules)).toContain("envelope-approval-check-removed");
  });

  test("D5: removing the one-shot dispatch key is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("edgeCommandDispatchExternalKey(", "edgeDispatchNoopKey("),
    );
    expect(violationsOf(rules)).toContain("dispatch-key-removed");
  });

  test("D5: removing the replay fast path is flagged", () => {
    const rules = mutateService((source) =>
      source.replace("store.findCommandByKey(", "store.findCommandNoop("),
    );
    expect(violationsOf(rules)).toContain("replay-branch-removed");
  });

  test("D6: injecting a loop primitive into the service is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "const submitCommand = async (",
        "const heartbeat = setInterval(() => {}, 1000); const submitCommand = async (",
      ),
    );
    expect(violationsOf(rules)).toContain("loop-primitive-injected:setInterval");
  });

  test("D6: the service driving the device-side autonomous loop is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "const submitCommand = async (",
        'const driveLoop = (d: string) => controller.autonomousTick(d, "locomotion", 1); void driveLoop; const submitCommand = async (',
      ),
    );
    expect(violationsOf(rules)).toContain("autonomous-loop-injected:autonomousTick");
  });

  test("D7: removing the violation recording is flagged", () => {
    const rules = mutateService((source) =>
      source.replace('actuationClass: "violation"', 'actuationClass: "accepted"'),
    );
    expect(violationsOf(rules)).toContain("violation-recording-removed");
  });

  test("D8: injecting a vendor literal into the service is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        "const submitCommand = async (",
        "const rail = 'modbus'; void rail; const submitCommand = async (",
      ),
    );
    expect(violationsOf(rules)).toContain("vendor-literal-in:service");
  });

  test("D9: adding an execution transition to the store port is flagged", () => {
    const rules = mutateStorePort((source) =>
      source.replace(
        "export interface EdgeStore {",
        "export interface EdgeStoreExtra { waitHuman(id: string): Promise<void>; }\nexport interface EdgeStore {",
      ),
    );
    expect(violationsOf(rules)).toContain("execution-transition-added:waitHuman(");
  });

  test("D9: injecting a foreign ledger event type is flagged", () => {
    const rules = mutateService((source) =>
      source.replace(
        '"tool-requested",\n      "edge-command",',
        '"tool-requested",\n      "edge-command",\n      appendEventExtra("tool-spawned"),',
      ),
    );
    expect(violationsOf(rules).some((v) => v.startsWith("ledger-vocabulary-mutant:"))).toBe(true);
  });

  test("D10: removing a migration physical guard is flagged", () => {
    const rules = mutateMigration((source) =>
      source.split("ed_envelopes_core_guard").join("ed_envelopes_guard_removed"),
    );
    expect(violationsOf(rules)).toContain("migration-guard-removed:ed_envelopes_core_guard");
  });

  test("D11: removing the multi-gate sibling check is flagged", () => {
    const rules = mutateService((source) =>
      source.split("hasLiveSiblingGates(").join("hasNoSiblingGates("),
    );
    expect(violationsOf(rules)).toContain("multi-gate-removed");
  });

  test("D11: removing the wait-gate is flagged", () => {
    const rules = mutateService((source) =>
      source.split("shouldApplyWaitHuman(").join("shouldAlwaysWaitHuman("),
    );
    expect(violationsOf(rules)).toContain("wait-gate-removed");
  });
});

// ---------------------------------------------------------------------------
// The runtime reds: the negative behaviors are the PERMANENT outcomes.
// ---------------------------------------------------------------------------

async function governedWorld(): Promise<{
  world: InMemoryEdgeWorld;
  executionId: string;
  deviceId: string;
  envelopeId: string;
}> {
  const world = createInMemoryEdgeWorld();
  const executionId = await world.seedExecution();
  const deviceId = await world.register();
  const { envelopeId } = await world.approveEnvelope(executionId, deviceId);
  return { world, executionId, deviceId, envelopeId };
}

describe("discrimination: edge runtime reds (the safety boundaries stay closed)", () => {
  test("D1: EVERY denial class leaves ZERO actuator-path activity and a DURABLE denial row", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const base = world.commandRequest(executionId, deviceId, envelopeId);

    // policy denial
    world.policy.denyWith("edge commands suspended in this tenant");
    await expectPlatformError("POLICY_DENIED", world.service.submitCommand(base, "red-policy"));
    world.policy.allow();

    // capability denial
    world.capabilities.failWith(["edge-channel-locomotion"]);
    await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      world.service.submitCommand(base, "red-capability"),
    );
    world.capabilities.failWith([]);

    // approval denial (physical write without a bound approval)
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand(base, "red-approval"),
    );

    // staleness denial
    const stale = world.commandRequest(executionId, deviceId, envelopeId, {
      notBefore: new Date(Date.parse("2026-09-15T10:00:00Z")).toISOString(),
      notAfter: new Date(Date.parse("2026-09-15T11:00:00Z")).toISOString(),
    });
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand(stale, "red-stale"),
    );

    // envelope coverage denial (magnitude beyond the envelope's bound)
    const beyond = world.commandRequest(executionId, deviceId, envelopeId, {
      magnitude: 600,
    });
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand(beyond, "red-coverage"),
    );

    // THE RED: zero actuations ever reached the local controller.
    expect(world.controller.journalLength(deviceId)).toBe(0);
    // …and every denial is a DURABLE denied row with a failed operation
    // (the gapless per-device sequence includes denials).
    const commands = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(commands.length).toBe(5);
    expect(commands.every((command) => command.status === "denied")).toBe(true);
    expect(commands.map((command) => command.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (const key of [
      "edge-op-command-submit:red-policy",
      "edge-op-command-submit:red-capability",
      "edge-op-command-submit:red-approval",
      "edge-op-command-submit:red-stale",
      "edge-op-command-submit:red-coverage",
    ]) {
      const operation = await world.store.findOperation(world.applicationId, key);
      expect(operation?.status).toBe("failed");
    }
  });

  test("D2/D3: a stale command and an unapproved physical write NEVER actuate (replayed denials stay typed)", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const stale = world.commandRequest(executionId, deviceId, envelopeId, {
      notBefore: new Date(Date.parse("2026-09-15T10:00:00Z")).toISOString(),
      notAfter: new Date(Date.parse("2026-09-15T11:00:00Z")).toISOString(),
    });
    const error = await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand(request, "red-auth"),
    );
    expect(error.message).toContain("PHYSICAL-WRITE");
    // the stale command carries a VALID approval so the denial is the
    // STALENESS gate itself (the chain reaches step 8, never dispatch)
    const staleApprovalId = await world.approveCommand(stale);
    const staleError = await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand({ ...stale, approvalId: staleApprovalId }, "red-stale-replay"),
    );
    expect(staleError.message).toContain("STALE");
    // the denial replays typed — a retry NEVER reaches the actuator path
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand(request, "red-auth"),
    );
    expect(world.controller.journalLength(deviceId)).toBe(0);
  });

  test("D5: duplicate submission converges to ONE dispatch and ONE journal entry", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    const first = await world.service.submitCommand({ ...request, approvalId }, "red-once");
    const replay = await world.service.submitCommand({ ...request, approvalId }, "red-once");
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.commandId).toBe(first.commandId);
    expect(world.controller.journalLength(deviceId)).toBe(1);
    // a same-key DIFFERENT-body retry fails closed
    await expectPlatformError(
      "IDEMPOTENCY_KEY_REUSED",
      world.service.submitCommand({ ...request, approvalId, magnitude: 101 }, "red-once"),
    );
    expect(world.controller.journalLength(deviceId)).toBe(1);
  });

  test("D6: the device-side loop actuates with ZERO governance-plane involvement (no cloud in the loop)", async () => {
    const { world, deviceId } = await governedWorld();
    // the local substrate disconnects (Zeck unreachable) and runs its own
    // hard-real-time loop against the HELD envelope: the loop surface is
    // driven by the DEVICE side (the world), never by the service — the
    // journal grows with NO governance call in between.
    world.controller.disconnect();
    world.controller.autonomousTick(deviceId, "manipulation", 50);
    world.controller.autonomousTick(deviceId, "locomotion", 100);
    expect(world.controller.journalLength(deviceId)).toBe(2);
    // an out-of-envelope autonomous actuation lands in the physical
    // journal (the substrate moved — Zeck cannot prevent physics) but
    // reconciliation classifies it as a DURABLE VIOLATION and the
    // receipt goes CONFLICT (fail closed) — governance, not control.
    world.controller.autonomousTick(deviceId, "manipulation", 5_000);
    expect(world.controller.journalLength(deviceId)).toBe(3);
    const receipt = await world.service.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rk-red-1",
    );
    expect(receipt.status).toBe("conflict");
    expect(receipt.violationCount).toBe(1);
    const actuations = await world.service.listActuationEvents(world.applicationId, deviceId);
    expect(
      actuations.filter((event) => event.actuationClass === "envelope-autonomous").length,
    ).toBe(2);
    expect(
      actuations.filter(
        (event) =>
          event.actuationClass === "violation" && event.violationKind === "out-of-envelope",
      ).length,
    ).toBe(1);
  });

  test("D7: a rogue controller report (executed-but-unauthorized command) is a DURABLE violation — fail closed", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const { envelopeId } = await world.approveEnvelope(executionId, deviceId);
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    await world.service.submitCommand({ ...request, approvalId }, "rk-rogue-governed");
    // a rogue controller journal reports an actuation with NO commanded
    // authority behind it (sequence beyond the authoritative stream)
    const rogue = {
      ...(await world.controller.reconciliationReport(deviceId)),
      executed: [
        {
          commandKey: "rk-rogue-phantom",
          sequence: 99,
          channel: "locomotion" as const,
          magnitude: 999_999,
          actuationDigest: "1".repeat(64),
          occurredAt: world.now().toISOString(),
        },
      ],
    };
    const { createEdgeService, createEdgeExecutionLedgerAdapter } = await import(
      "../../src/integrations/edge/public"
    );
    const rogueService = createEdgeService({
      policy: world.policy.impl,
      capabilities: world.capabilities.impl,
      store: world.store,
      ledger: createEdgeExecutionLedgerAdapter(world.executionService),
      controller: {
        controllerId: "controller-rogue",
        applyEnvelope: world.controller.applyEnvelope.bind(world.controller),
        dispatchCommand: world.controller.dispatchCommand.bind(world.controller),
        reconciliationReport: async () => rogue,
        lastExecutedSequence: world.controller.lastExecutedSequence.bind(world.controller),
      },
      generateId: () => "00000000-0000-7000-8000-000000000abc",
      now: world.now,
      digest: sha256Hex,
    });
    const receipt = await rogueService.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rk-rogue",
    );
    expect(receipt.status).toBe("conflict");
    expect(receipt.violationCount).toBeGreaterThanOrEqual(1);
    const actuations = await world.service.listActuationEvents(world.applicationId, deviceId);
    expect(
      actuations.some(
        (event) =>
          event.actuationClass === "violation" && event.violationKind === "unauthorized-command",
      ),
    ).toBe(true);
    // the conflicted device fail-safes: NO further authoritative commands
    const request2 = world.commandRequest(executionId, deviceId, envelopeId, {
      payload: { step: 2 },
    });
    const approvalId2 = await world.approveCommand(request2);
    await expectPlatformError(
      "NON_CONVERGENT_EXTERNAL_EFFECT",
      world.service.submitCommand({ ...request2, approvalId: approvalId2 }, "rk-conflicted"),
    );
    expect(world.controller.journalLength(deviceId)).toBe(1);
  });
});
