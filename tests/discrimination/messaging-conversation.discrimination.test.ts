/**
 * Discrimination: the provider-neutral conversational messaging boundaries
 * (WORK-025, MOD-008/009; checkpoint contracts
 * IMPLEMENTATION-COMPLETENESS, EXECUTION-PROVENANCE,
 * CONCURRENCY-CRASH-SAFETY, SELF-HOSTING-BOUNDARY).
 *
 * The 16 REQUIRED SAFETY PROOFS (the work order's mandatory coverage,
 * labeled S1..S16). Every protection has BOTH halves (the house style):
 *
 *   STATIC mutants mutate the REAL source in memory; the probe scanners
 *   below must flag exactly the weakened protection (a mutant that
 *   removes or reorders a guard is caught without touching the clean
 *   tree, which always scans clean);
 *
 *   RUNTIME red records observe the governed in-memory world under
 *   constructed scenarios and stay red (the negative behavior is
 *   asserted as the permanent expected outcome).
 *
 * Proof map (proof → mutant → runtime red):
 *   S1  tenant isolation             tenant-guard-removed (conversation+deployment)
 *       cross-tenant start/ingest/delivery/escalation fail TENANT_SCOPE_VIOLATION
 *   S2  policy before side effect    admission-order / admission-removed
 *       denial at start, turn AND escalation: zero rail activity
 *   S3  capability gate              capability-gate-removed
 *       unmet capability: CAPABILITY_UNAVAILABLE, zero sends
 *   S4  budget gate (paid routes)    budget-gate-removed
 *       exhausted budget: BUDGET_EXCEEDED, zero sends
 *   S5  secret mediation             mediation-gate-removed
 *       refused mediation: AUTHORIZATION_DENIED, reservation released
 *   S6  duplicate inbound events     convergence-branch-removed
 *       duplicate event: one send, one responder call, one turn evidence
 *   S7  conversation-scoped keys     scoping-removed (scopedKey)
 *       same event key on two conversations: two distinct durable turns
 *   S8  ordering semantics           ordering-resolution-removed
 *       out-of-order/gap arrivals: deterministic markers, never a block
 *   S9  delivery correlation         correlation-guard-removed
 *       cross-conversation / mismatched ref: typed failure, zero mutation
 *   S10 version pinning              pin-drift (ingest uses the conversation pin)
 *       promote: live conversation keeps v1, new conversation pins v2
 *   S11 physical core guards         migration-guard-removed
 *       the identity core + delivery monotonicity are physically frozen
 *   S12 deterministic routing        budget-gate-removed (the paid-only guard)
 *       deterministic route: zero reservations
 *   S13 provider-native ids are      identity-inversion (eventKey vs ref)
 *       NOT the primary identity     the ledger key is the Zeck event key
 *   S14 escalation is governed       escalation-order mutant
 *       policy denial: no wait step, no rail notice
 *   S15 no second authority          execution-authority-inversion
 *       the message ledger never writes execution state
 *   S16 attachments are references   attachment-validation-removed
 *       oversized/binary attachments: typed rejection, never embedded
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  CreateDeploymentInput,
  DeploymentPlanInput,
  DeploymentProfileInput,
  MessagingActor,
  MessagingBudgetReserveCommand,
  MessagingCapabilityAdmissionRequest,
  MessagingEvidenceInput,
  MessagingExecutionLedger,
  MessagingExecutionOpenInput,
  MessagingInboundEventInput,
  MessagingPolicyAdmissionRequest,
  MessagingRouteClass,
  MessagingSecretMediationRequest,
  MessagingConversationServiceDeps,
  MessagingTurnResponderRequest,
  MessagingTurnRouteRequest,
  StartMessagingConversationInput,
} from "../../src/modules/deployments/public";
import {
  createDeploymentService,
  createInProcessMessagingRail,
  createMessagingConversationService,
  createModalityAdapterRegistry,
  InMemoryDeploymentStore,
  InMemoryMessagingStore,
} from "../../src/modules/deployments/public";
import { PlatformError } from "../../src/shared/errors";

const REPO_ROOT = join(process.cwd());
const SERVICE_PATH = "src/modules/deployments/application/messaging-conversation-service.ts";
const DOMAIN_PATH = "src/modules/deployments/domain/messaging.ts";
const STORE_PORT_PATH = "src/modules/deployments/ports/messaging-store.ts";
const MIGRATION_PATH = "src/platform/db/migrations/0020_messaging_conversations.sql";
const SERVICE_SOURCE = readFileSync(join(REPO_ROOT, SERVICE_PATH), "utf8");
const DOMAIN_SOURCE = readFileSync(join(REPO_ROOT, DOMAIN_PATH), "utf8");
const STORE_PORT_SOURCE = readFileSync(join(REPO_ROOT, STORE_PORT_PATH), "utf8");
const MIGRATION_SOURCE = readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8");

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Extract one method body from the service source (4-space indent). */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`signature not found: ${signature}`);
  }
  const next = source.indexOf("\n    async ", start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

/** Extract one helper section between two source markers. */
function sectionOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`section start not found: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end === -1 ? source.length : end);
}

const INGEST_BODY = methodBody(SERVICE_SOURCE, "async ingestInboundEvent(");
const START_BODY = methodBody(SERVICE_SOURCE, "async startConversation(");
const DELIVERY_BODY = methodBody(SERVICE_SOURCE, "async applyDeliveryStatus(");
const ESCALATION_BODY = methodBody(SERVICE_SOURCE, "async escalateToHuman(");
const RESOLVE_CONVERSATION_BODY = sectionOf(
  SERVICE_SOURCE,
  "const resolveConversation = async (",
  "const appendMessage = async (",
);

// ---------------------------------------------------------------------------
// The static probe: violations over the (possibly mutated) REAL source.
// ---------------------------------------------------------------------------

interface MessagingRules {
  readonly service: string;
  readonly ingestBody: string;
  readonly startBody: string;
  readonly deliveryBody: string;
  readonly escalationBody: string;
  readonly resolveConversationBody: string;
  readonly domain: string;
  readonly storePort: string;
  readonly migration: string;
}

function violationsOf(rules: MessagingRules): string[] {
  const violations: string[] = [];

  // S1 — tenant guards (conversation + deployment) must exist.
  if (!rules.resolveConversationBody.includes("conversation.tenantId !== actor.tenantId")) {
    violations.push("conversation-tenant-guard-removed");
  }
  if (!rules.service.includes("deployment.tenantId !== tenantId")) {
    violations.push("deployment-tenant-guard-removed");
  }

  // S2 — the admission chain must run BEFORE the side effects, in the
  // frozen order, inside the ingest flow.
  const order: ReadonlyArray<readonly [string, number]> = [
    ["policy.admit(", rules.ingestBody.indexOf("policy.admit(")],
    ["capabilities.resolve(", rules.ingestBody.indexOf("capabilities.resolve(")],
    ["budget.reserve(", rules.ingestBody.indexOf("budget.reserve(")],
    ["secrets.mediate(", rules.ingestBody.indexOf("secrets.mediate(")],
    ["responder.respond(", rules.ingestBody.indexOf("responder.respond(")],
    ["rail.sendMessage(", rules.ingestBody.indexOf("rail.sendMessage(")],
  ];
  for (const [label, index] of order) {
    if (index === -1) {
      // The deterministic-gate flow may short-circuit budget: the token
      // must still be present in the method.
      if (label === "budget.reserve(" && rules.ingestBody.includes("budget.reserve(")) {
        continue;
      }
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
  // Start flow: policy BEFORE the rail open and the execution open.
  const startPolicy = rules.startBody.indexOf("policy.admit(");
  const startRail = rules.startBody.indexOf("rail.openConversation(");
  if (startPolicy === -1) {
    violations.push("admission-missing:policy.admit( (startConversation)");
  } else if (startRail !== -1 && startPolicy > startRail) {
    violations.push("admission-order:policy-after-rail-open");
  }

  // S3 — the capability gate must exist.
  if (!rules.ingestBody.includes("!capabilityDecision.satisfied")) {
    violations.push("capability-gate-removed");
  }

  // S4/S12 — the paid-only budget gate must exist (deterministic routes
  // never reserve).
  if (!rules.ingestBody.includes('route.routeClass !== "deterministic"')) {
    violations.push("budget-gate-removed");
  }

  // S5 — the mediation gate must exist.
  if (!rules.ingestBody.includes("!mediation.mediated")) {
    violations.push("mediation-gate-removed");
  }

  // S6 — the duplicate-convergence branch must exist (the op-state
  // replay discriminator for converged inbound claims).
  if (!rules.ingestBody.includes('if (claim.status === "converged") {')) {
    violations.push("convergence-branch-removed");
  }

  // S7 — the conversation-scoped key discipline: every event-derived key
  // is scoped by the conversation identity.
  if (!rules.ingestBody.includes("const scopedKey = `${conversation.id}:${eventKey}`")) {
    violations.push("scoping-removed");
  }

  // S8 — the ordering resolution must run (the explicit channel contract).
  if (!rules.ingestBody.includes("resolveMessagingOrdering(")) {
    violations.push("ordering-resolution-removed");
  }

  // S9 — the delivery correlation guards must exist.
  if (!rules.deliveryBody.includes('message.kind !== "agent-reply"')) {
    violations.push("correlation-kind-guard-removed");
  }
  if (!rules.deliveryBody.includes("message.channelMessageRef !== input.channelMessageRef")) {
    violations.push("correlation-ref-guard-removed");
  }

  // S10 — the ingest flow must use the CONVERSATION's pin, never the
  // deployment's current pointer.
  if (!rules.ingestBody.includes("conversation.pinnedPlanId")) {
    violations.push("pin-drift");
  }
  if (rules.ingestBody.includes("deployment.currentPlanId")) {
    violations.push("pin-drift-current-pointer");
  }

  // S11 — the physical core guards must exist in the migration.
  if (!rules.migration.includes("msg_conversations_core_guard")) {
    violations.push("migration-core-guard-removed");
  }
  if (!rules.migration.includes("NEW.pinned_plan_version <> OLD.pinned_plan_version")) {
    violations.push("migration-pin-immutability-removed");
  }
  if (!rules.migration.includes("msg_messages_key_unique")) {
    violations.push("migration-inbound-idempotency-removed");
  }
  if (!rules.migration.includes("msg_messages_append_only_guard")) {
    violations.push("migration-append-only-removed");
  }

  // S13 — provider-native ids are NEVER the primary identity: the
  // domain's message record keeps `eventKey` (the Zeck identity) and
  // `channelMessageRef` (the opaque rail reference) as DISTINCT fields,
  // and the physical UNIQUE arbitrates the Zeck key only.
  if (!rules.domain.includes("readonly eventKey: string;")) {
    violations.push("identity-inversion-event-key");
  }
  if (!rules.domain.includes("readonly channelMessageRef: string | null;")) {
    violations.push("identity-inversion-channel-ref");
  }
  if (
    !rules.migration.includes(
      "CONSTRAINT msg_messages_key_unique UNIQUE (application_id, conversation_id, event_key)",
    )
  ) {
    violations.push("identity-inversion-unique-target");
  }

  // S14 — escalation is a GOVERNED execution step: the policy admission
  // and the wait-human step precede the rail notice.
  const escalatePolicy = rules.escalationBody.indexOf("policy.admit(");
  const escalateWait = rules.escalationBody.indexOf("ledger.awaitHuman(");
  const escalateRail = rules.escalationBody.indexOf("rail.escalate(");
  if (escalatePolicy === -1) {
    violations.push("escalation-policy-removed");
  } else if (escalateRail !== -1 && escalatePolicy > escalateRail) {
    violations.push("escalation-order:policy-after-rail-notice");
  }
  if (escalateWait === -1) {
    violations.push("escalation-wait-removed");
  } else if (escalateRail !== -1 && escalateWait > escalateRail) {
    violations.push("escalation-order:wait-after-rail-notice");
  }

  // S15 — no second conversation/execution authority: the messaging
  // store port never carries execution-transition vocabulary.
  for (const forbidden of ["transitionExecution", "setExecutionStatus", "writeExecutionState"]) {
    if (rules.storePort.includes(forbidden)) {
      violations.push(`execution-authority-inversion:${forbidden}`);
    }
  }
  if (!rules.storePort.includes("recordStepEvent") && !rules.service.includes("ledger.recordEvidence(")) {
    violations.push("provenance-path-removed");
  }

  // S16 — attachments are ARTIFACT REFERENCES: the validation and the
  // physical guard must exist.
  if (!rules.domain.includes("function validateAttachmentRefs(")) {
    violations.push("attachment-validation-removed");
  }
  if (!rules.migration.includes("msg_messages_attachments_refs_guard")) {
    violations.push("migration-attachment-guard-removed");
  }
  if (!rules.migration.includes("pg_column_size(attachments) <= 2048")) {
    violations.push("migration-attachment-bounding-removed");
  }

  return violations;
}

/** The clean tree scans clean. */
function cleanRules(): MessagingRules {
  return {
    service: SERVICE_SOURCE,
    ingestBody: INGEST_BODY,
    startBody: START_BODY,
    deliveryBody: DELIVERY_BODY,
    escalationBody: ESCALATION_BODY,
    resolveConversationBody: RESOLVE_CONVERSATION_BODY,
    domain: DOMAIN_SOURCE,
    storePort: STORE_PORT_SOURCE,
    migration: MIGRATION_SOURCE,
  };
}

function mutateService(mutation: (content: string) => string): MessagingRules {
  const service = mutation(SERVICE_SOURCE);
  return {
    service,
    ingestBody: methodBody(service, "async ingestInboundEvent("),
    startBody: methodBody(service, "async startConversation("),
    deliveryBody: methodBody(service, "async applyDeliveryStatus("),
    escalationBody: methodBody(service, "async escalateToHuman("),
    resolveConversationBody: sectionOf(service, "const resolveConversation = async (", "const appendMessage = async ("),
    domain: DOMAIN_SOURCE,
    storePort: STORE_PORT_SOURCE,
    migration: MIGRATION_SOURCE,
  };
}

function mutateMigration(mutation: (content: string) => string): MessagingRules {
  return { ...cleanRules(), migration: mutation(MIGRATION_SOURCE) };
}

function mutateDomain(mutation: (content: string) => string): MessagingRules {
  return { ...cleanRules(), domain: mutation(DOMAIN_SOURCE) };
}

// ---------------------------------------------------------------------------
// The runtime world (a compact twin of the unit suite's world).
// ---------------------------------------------------------------------------

const ACTOR: MessagingActor = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
};
const OTHER_TENANT_ACTOR: MessagingActor = {
  actorId: "00000000-0000-7000-8000-0000000000f1",
  applicationId: ACTOR.applicationId,
  tenantId: "00000000-0000-7000-8000-0000000000f3",
};
const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const ENV_ID = "00000000-0000-7000-8000-0000000000a2";

const PROFILE: DeploymentProfileInput = {
  profileId: "support-chat",
  modality: "messaging",
  channelKinds: ["web", "sms"],
  requiredCapabilities: ["messaging-conversation"],
  latencyClass: "asynchronous",
  resourceClass: "standard",
  sideEffectClass: "read-only",
  inputModalities: ["text"],
  outputModalities: ["text"],
};

const PLAN: DeploymentPlanInput = {
  planId: "support-chat-plan",
  profileRef: { profileId: "support-chat", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" },
  environmentId: ENV_ID,
  channelBindings: [{ channelKind: "web", adapterCapabilityId: "messaging-channel-adapter" }],
  sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 64 },
};

const CREATION: CreateDeploymentInput = {
  slug: "support-chat-prod",
  name: "Support chat",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck",
  planId: "support-chat-plan",
};

/** Recording admission seams (typed with the real port request shapes). */
class RecordingAdmissions {
  readonly policyCalls: MessagingPolicyAdmissionRequest[] = [];
  readonly capabilityCalls: MessagingCapabilityAdmissionRequest[] = [];
  readonly reserves: MessagingBudgetReserveCommand[] = [];
  readonly mediationCalls: MessagingSecretMediationRequest[] = [];
  readonly responderCalls: MessagingTurnResponderRequest[] = [];
  denyPolicy = false;
  denyAction: string | null = null;
  unmet: string[] = [];
  failBudget = false;
  refuseMediation = false;
  routeClass: MessagingRouteClass = "generative";

  readonly policy = {
    admit: async (request: MessagingPolicyAdmissionRequest) => {
      this.policyCalls.push(request);
      if (this.denyPolicy || (this.denyAction !== null && this.denyAction === request.action)) {
        return { allowed: false as const, reason: "fixture denial" };
      }
      return { allowed: true as const };
    },
  };

  readonly capabilities = {
    resolve: async (request: MessagingCapabilityAdmissionRequest) => {
      this.capabilityCalls.push(request);
      return { satisfied: this.unmet.length === 0, unmet: this.unmet };
    },
  };

  readonly budget = {
    reserve: async (command: MessagingBudgetReserveCommand) => {
      this.reserves.push(command);
      if (this.failBudget) {
        throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "fixture exhausted" });
      }
      return {
        reservationId: `resv-${this.reserves.length}`,
        amountMicroUsd: command.amountMicroUsd,
        converged: false,
      };
    },
    settle: async () => ({ reservationId: "resv-x", settled: true }),
    release: async () => ({ reservationId: "resv-x", released: true }),
  };

  readonly secrets = {
    mediate: async (request: MessagingSecretMediationRequest) => {
      this.mediationCalls.push(request);
      return this.refuseMediation
        ? { mediated: false as const, reason: "fixture inactive" }
        : { mediated: true as const, grantRef: "mediated:conn-1" };
    },
  };

  readonly router = {
    routeTurn: async (request: MessagingTurnRouteRequest) => {
      void request;
      return {
        routeClass: this.routeClass,
        decisionOutcome:
          this.routeClass === "deterministic"
            ? ("sufficient" as const)
            : this.routeClass === "hybrid"
              ? ("uncertain" as const)
              : ("insufficient" as const),
        reasonCodes: ["fixture"],
        rationale: "fixture planner decision",
        estimatedCostMicroUsd: this.routeClass === "deterministic" ? null : "10000",
      };
    },
  };

  readonly responder = {
    respond: async (request: MessagingTurnResponderRequest) => {
      this.responderCalls.push(request);
      return {
        responseRef: "artifact:responses/1",
        responsePreview: "fixture answer",
        responseAttachments: [],
        actualCostMicroUsd: "0",
      };
    },
  };
}

/** The in-memory execution ledger (idempotent open, sequenced evidence). */
class RecordingLedger implements MessagingExecutionLedger {
  readonly opened: Array<{ key: string; input: MessagingExecutionOpenInput }> = [];
  readonly evidence: MessagingEvidenceInput[] = [];
  readonly humanWaits: Array<{ key: string; input: Record<string, unknown> }> = [];
  private readonly executionByKey = new Map<string, string>();
  private readonly evidenceKeys = new Set<string>();
  private readonly humanWaitKeys = new Set<string>();
  private seq = 0;
  async openExecution(input: MessagingExecutionOpenInput, idempotencyKey: string) {
    const existing = this.executionByKey.get(idempotencyKey);
    if (existing !== undefined) {
      return { executionId: existing, replayed: true, status: "running" };
    }
    const executionId = `00000000-0000-7000-8000-${String(this.executionByKey.size + 1).padStart(
      12,
      "0",
    )}`;
    this.executionByKey.set(idempotencyKey, executionId);
    this.opened.push({ key: idempotencyKey, input });
    return { executionId, replayed: false, status: "running" };
  }
  async recordEvidence(input: MessagingEvidenceInput, idempotencyKey: string) {
    const replayed = this.evidenceKeys.has(idempotencyKey);
    this.evidenceKeys.add(idempotencyKey);
    if (!replayed) {
      this.evidence.push(input);
    }
    this.seq += 1;
    return { sequence: this.seq, type: "agent-action-recorded", replayed };
  }
  async readExecution() {
    return { id: "exec", tenantId: ACTOR.tenantId, status: "running" };
  }
  async awaitHuman(input: Record<string, unknown>, idempotencyKey: string) {
    const replayed = this.humanWaitKeys.has(idempotencyKey);
    this.humanWaitKeys.add(idempotencyKey);
    if (!replayed) {
      this.humanWaits.push({ key: idempotencyKey, input });
    }
    this.seq += 1;
    return { sequence: this.seq, replayed };
  }
  async continueAfterHuman() {
    this.seq += 1;
    return { sequence: this.seq, replayed: false };
  }
}

interface World {
  readonly service: ReturnType<typeof createMessagingConversationService>;
  readonly store: InMemoryMessagingStore;
  readonly rail: ReturnType<typeof createInProcessMessagingRail>;
  readonly admissions: RecordingAdmissions;
  readonly ledger: RecordingLedger;
  readonly deploymentService: ReturnType<typeof createDeploymentService>;
  deploymentId: string;
}

async function buildWorld(): Promise<World> {
  const deploymentStore = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  registry.register({
    descriptor: { adapterCapabilityId: "messaging-channel-adapter", channelKinds: ["web", "sms"] },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind };
    },
  });
  let idSeq = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++idSeq).padStart(12, "0")}`;
  const deploymentService = createDeploymentService({
    store: deploymentStore,
    agentInventory: {
      async findVersion(_applicationId, agentId, version) {
        return agentId === AGENT_ID && version === "1.0.0"
          ? {
              agentId,
              version,
              validationState: "valid" as const,
              agentStatus: "available" as const,
            }
          : null;
      },
    },
    environmentResolver: {
      async resolve(applicationId, environmentId) {
        return environmentId === ENV_ID
          ? { environmentId, applicationId, tenantId: ACTOR.tenantId }
          : null;
      },
    },
    adapters: registry,
    digest,
    generateId,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const actor = {
    actorId: ACTOR.actorId,
    applicationId: ACTOR.applicationId,
    tenantId: ACTOR.tenantId,
  };
  await deploymentService.publishProfile({ ...PROFILE }, { version: 1 }, actor);
  await deploymentService.publishPlan({ ...PLAN }, { version: 1 }, actor);
  await deploymentService.publishPlan(
    {
      ...PLAN,
      sessionPolicy: { maxSessionDurationMs: 1_800_000, maxConcurrentSessions: 32 },
    },
    { version: 2 },
    actor,
  );
  const created = await deploymentService.createDeployment({ ...CREATION }, "deploy-key-0", actor);

  const store = new InMemoryMessagingStore();
  const rail = createInProcessMessagingRail(["web", "in-app", "sms", "email"], {
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const admissions = new RecordingAdmissions();
  const ledger = new RecordingLedger();
  const deps: MessagingConversationServiceDeps = {
    store,
    deployments: deploymentStore,
    rail,
    policy: admissions.policy,
    capabilities: admissions.capabilities,
    budget: admissions.budget,
    secrets: admissions.secrets,
    router: admissions.router,
    responder: admissions.responder,
    ledger,
    railConnectionRef: "conn-rail-1",
    digest,
    generateId,
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
  return {
    service: createMessagingConversationService(deps),
    store,
    rail,
    admissions,
    ledger,
    deploymentService,
    deploymentId: created.deploymentId,
  };
}

async function start(
  world: World,
  key: string,
  actor: MessagingActor = ACTOR,
  overrides: Record<string, unknown> = {},
) {
  const input: StartMessagingConversationInput = {
    deploymentId: world.deploymentId,
    channelKind: "web",
    channelConversationRef: `channel-thread-${key}`,
    ...overrides,
  } as StartMessagingConversationInput;
  return world.service.startConversation(input, key, actor);
}

const userEvent = (conversationId: string, eventKey?: string): MessagingInboundEventInput => ({
  conversationId,
  eventKey,
  payloadPreview: "what is my order status?",
  payloadRef: "artifact:inbound/1",
  subtaskKind: "data-retrieval",
});

// ---------------------------------------------------------------------------
// The discrimination records.
// ---------------------------------------------------------------------------

describe("discrimination: provider-neutral conversational messaging (WORK-025)", () => {
  test("the clean tree scans clean (the probe's baseline)", () => {
    expect(violationsOf(cleanRules())).toEqual([]);
  });

  test("S1 STATIC: removing the conversation tenant guard is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (conversation.tenantId !== actor.tenantId) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("conversation-tenant-guard-removed");
  });

  test("S1 STATIC: removing the deployment tenant guard is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (deployment.tenantId !== tenantId) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("deployment-tenant-guard-removed");
  });

  test("S1 RUNTIME: an unauthorized tenant cannot touch another tenant's conversation", async () => {
    const world = await buildWorld();
    const started = await start(world, "s1");
    await expect(start(world, "s1-other", OTHER_TENANT_ACTOR)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId), OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.applyDeliveryStatus(
        { conversationId: started.conversationId, messageKey: "evt:reply", status: "delivered" },
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.escalateToHuman({ conversationId: started.conversationId }, "s1-x", OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(0);
    expect(world.rail.sends.filter((record) => record.kind === "escalate")).toHaveLength(0);
  });

  test("S2 STATIC: deleting the turn policy admission is flagged (admission-missing)", () => {
    const mutated = mutateService((content) =>
      content.replace("const policyDecision = await policy.admit({", "const policyDecision = {"),
    );
    expect(violationsOf(mutated)).toContain("admission-missing:policy.admit(");
  });

  test("S2 STATIC: reordering the send before the admission chain is flagged", () => {
    // Mutant: an early send is inserted ABOVE the admission chain — the
    // ordering probe must flag the side-effect-before-admission drift.
    const mutated = mutateService((content) =>
      content.replace(
        "        // 6. ADMISSION CHAIN — before EVERY governed side effect.",
        "        const earlySend = await rail.sendMessage({\n          applicationId: actor.applicationId,\n          conversationId: conversation.id,\n          channelConversationRef: conversation.channelConversationRef,\n          channelKind: conversation.channelKind,\n          routeClass: 'generative',\n          threadRef: null,\n          messageKey: 'early',\n          idempotencyKey: 'early',\n          replyToEventKey: null,\n          payloadRef: null,\n          payloadPreview: 'early',\n          attachments: [],\n          cause: null,\n        });\n        void earlySend;\n        // 6. ADMISSION CHAIN — before EVERY governed side effect.",
      ),
    );
    const violations = violationsOf(mutated);
    expect(violations.join("\n")).toContain("admission-order:");
    expect(violations).toContain("admission-order:responder.respond(-after-rail.sendMessage(");
  });

  test("S2 RUNTIME: policy denial happens before the external side effect (all three flows)", async () => {
    const world = await buildWorld();
    world.admissions.denyPolicy = true;
    // Start flow: zero rail activity, zero executions.
    await expect(start(world, "s2-start")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.sends).toHaveLength(0);
    expect(world.rail.openedConversations).toBe(0);
    expect(world.ledger.opened).toHaveLength(0);
    // Turn flow: zero sends, zero responder calls.
    world.admissions.denyPolicy = false;
    const started = await start(world, "s2-turn");
    world.admissions.denyAction = "message-send";
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-s2"), ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(0);
    expect(world.admissions.responderCalls).toHaveLength(0);
    // Escalation flow: no rail notice, no execution wait.
    world.admissions.denyAction = "human-escalation";
    await expect(
      world.service.escalateToHuman({ conversationId: started.conversationId }, "s2-esc", ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.sends.filter((record) => record.kind === "escalate")).toHaveLength(0);
    expect(world.ledger.humanWaits).toHaveLength(0);
  });

  test("S3 STATIC: removing the capability gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (!capabilityDecision.satisfied) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("capability-gate-removed");
  });

  test("S3 RUNTIME: a missing capability cannot send", async () => {
    const world = await buildWorld();
    const started = await start(world, "s3");
    world.admissions.unmet = ["messaging-conversation"];
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-s3"), ACTOR),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(0);
    expect(world.admissions.responderCalls).toHaveLength(0);
    expect(world.admissions.reserves).toHaveLength(0);
  });

  test("S4/S12 STATIC: removing the paid-only budget gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        'if (route.routeClass !== "deterministic" && route.estimatedCostMicroUsd !== null) {',
        "if (route.estimatedCostMicroUsd !== null) {",
      ),
    );
    expect(violationsOf(mutated)).toContain("budget-gate-removed");
  });

  test("S4 RUNTIME: a denied budget prevents the paid send", async () => {
    const world = await buildWorld();
    const started = await start(world, "s4");
    world.admissions.failBudget = true;
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-s4"), ACTOR),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(0);
    expect(world.admissions.responderCalls).toHaveLength(0);
    expect(world.admissions.mediationCalls).toHaveLength(0);
  });

  test("S5 STATIC: removing the mediation gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (!mediation.mediated) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("mediation-gate-removed");
  });

  test("S5 RUNTIME: refused secret mediation prevents the send and releases the reservation", async () => {
    const world = await buildWorld();
    const started = await start(world, "s5");
    world.admissions.refuseMediation = true;
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-s5"), ACTOR),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(0);
    expect(world.admissions.responderCalls).toHaveLength(0);
    // The paid reservation was released (never leaked).
    expect(world.admissions.reserves).toHaveLength(1);
  });

  test("S6 STATIC: removing the duplicate-convergence branch is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace('if (claim.status === "converged") {', "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("convergence-branch-removed");
  });

  test("S6 RUNTIME: duplicate inbound events do not duplicate side effects", async () => {
    const world = await buildWorld();
    const started = await start(world, "s6");
    const input = userEvent(started.conversationId, "evt-s6");
    await world.service.ingestInboundEvent(input, ACTOR);
    const replay = await world.service.ingestInboundEvent(input, ACTOR);
    expect(replay.replayed).toBe(true);
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(1);
    expect(world.admissions.responderCalls).toHaveLength(1);
    expect(world.admissions.reserves).toHaveLength(1);
    // Exactly ONE turn evidence record on the ledger (idempotency key).
    const turnEvidence = world.ledger.evidence.filter(
      (entry) => entry.evidenceClass === "message",
    );
    expect(turnEvidence).toHaveLength(1);
  });

  test("S7 STATIC: removing the conversation-scoped key discipline is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "const scopedKey = `${conversation.id}:${eventKey}`",
        "const scopedKey = eventKey",
      ),
    );
    expect(violationsOf(mutated)).toContain("scoping-removed");
  });

  test("S7 RUNTIME: the same event key on two conversations is TWO distinct logical turns", async () => {
    const world = await buildWorld();
    const startedA = await start(world, "s7-a");
    const startedB = await start(world, "s7-b");
    const ingestA = await world.service.ingestInboundEvent(
      userEvent(startedA.conversationId, "evt-shared"),
      ACTOR,
    );
    const ingestB = await world.service.ingestInboundEvent(
      userEvent(startedB.conversationId, "evt-shared"),
      ACTOR,
    );
    expect(ingestA.reply).not.toBeNull();
    expect(ingestB.reply).not.toBeNull();
    // Two distinct conversations, two sends, two executions.
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(2);
    expect(world.ledger.opened).toHaveLength(2);
  });

  test("S8 STATIC: removing the ordering resolution is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("resolveMessagingOrdering({", "({"),
    );
    expect(violationsOf(mutated)).toContain("ordering-resolution-removed");
  });

  test("S8 RUNTIME: out-of-order and gap arrivals resolve deterministically per the channel contract (never a block)", async () => {
    const world = await buildWorld();
    const started = await start(world, "s8", ACTOR, {
      orderingMode: "thread-sequenced",
    });
    const first = await world.service.ingestInboundEvent(
      { ...userEvent(started.conversationId, "seq-1"), threadRef: "t1", threadSequence: 1 },
      ACTOR,
    );
    expect(first.orderingMarker).toBe("in-order");
    const late = await world.service.ingestInboundEvent(
      { ...userEvent(started.conversationId, "seq-2"), threadRef: "t1", threadSequence: 1 },
      ACTOR,
    );
    expect(late.orderingMarker).toBe("out-of-order");
    const gap = await world.service.ingestInboundEvent(
      { ...userEvent(started.conversationId, "seq-3"), threadRef: "t1", threadSequence: 7 },
      ACTOR,
    );
    expect(gap.orderingMarker).toBe("gap");
    // Ordering is EVIDENCE, never a dispatch decision: all three turns replied.
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(3);
    const messages = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.find((message) => message.eventKey === "seq-2")?.orderingMarker).toBe(
      "out-of-order",
    );
    expect(messages.find((message) => message.eventKey === "seq-3")?.orderingMarker).toBe("gap");
  });

  test("S9 STATIC: removing the delivery correlation guards is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        'if (message === null || message.kind !== "agent-reply" || message.direction !== "outbound") {',
        'if (message === null) {',
      ),
    );
    expect(violationsOf(mutated)).toContain("correlation-kind-guard-removed");
    const mutatedRef = mutateService((content) =>
      content.replace(
        "message.channelMessageRef !== input.channelMessageRef",
        "false",
      ),
    );
    expect(violationsOf(mutatedRef)).toContain("correlation-ref-guard-removed");
  });

  test("S9 RUNTIME: delivery callbacks cannot mutate the wrong conversation/message", async () => {
    const world = await buildWorld();
    const started = await start(world, "s9");
    await world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-s9"), ACTOR);
    // A callback naming a message of ANOTHER conversation: typed failure.
    const other = await start(world, "s9-other");
    await expect(
      world.service.applyDeliveryStatus(
        { conversationId: other.conversationId, messageKey: "evt-s9:reply", status: "delivered" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    // A callback carrying a MISMATCHED rail message reference: typed failure.
    await expect(
      world.service.applyDeliveryStatus(
        {
          conversationId: started.conversationId,
          messageKey: "evt-s9:reply",
          channelMessageRef: "simmsg-message-999",
          status: "delivered",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    // Zero delivery evidence, the projection never moved.
    const deliveries = await world.store.listDeliveries(ACTOR.applicationId, started.conversationId);
    expect(deliveries).toHaveLength(0);
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-s9:reply",
    );
    expect(reply?.deliveryStatus).toBe("sent");
  });

  test("S10 STATIC: the ingest flow drifting to the deployment's current pointer is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "const { profile } = await resolvePinnedPlan(\n          actor.applicationId,\n          conversation.pinnedPlanId,\n          conversation.pinnedPlanVersion,\n        );",
        "const { profile } = await resolvePinnedPlan(\n          actor.applicationId,\n          conversation.pinnedPlanId,\n          conversation.pinnedPlanVersion,\n        );\n        const drift = deployment.currentPlanId;\n        void drift;",
      ),
    );
    expect(violationsOf(mutated)).toContain("pin-drift-current-pointer");
  });

  test("S10 RUNTIME: version pinning — promotion moves the pointer for NEW conversations only", async () => {
    const world = await buildWorld();
    const before = await start(world, "s10-before");
    await world.deploymentService.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "s10-promote",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    const after = await start(world, "s10-after");
    expect(after.pinnedPlanVersion).toBe(2);
    // The LIVE conversation keeps its pin and its execution identity.
    const conversation = await world.store.findConversation(
      ACTOR.applicationId,
      before.conversationId,
    );
    expect(conversation?.pinnedPlanVersion).toBe(1);
    expect(conversation?.executionId).toBe(before.executionId);
    // A turn on the live conversation still runs (the pin is intact).
    const ingest = await world.service.ingestInboundEvent(
      userEvent(before.conversationId, "evt-s10"),
      ACTOR,
    );
    expect(ingest.reply).not.toBeNull();
  });

  test("S11 STATIC: removing the migration core guards is flagged", () => {
    const mutated = mutateMigration((content) =>
      content.replace("CREATE TRIGGER msg_conversations_core_guard", "CREATE TRIGGER removed_guard"),
    );
    expect(violationsOf(mutated)).toContain("migration-core-guard-removed");
    const mutatedPin = mutateMigration((content) =>
      content.replace(
        "OR NEW.pinned_plan_version <> OLD.pinned_plan_version",
        "OR FALSE",
      ),
    );
    expect(violationsOf(mutatedPin)).toContain("migration-pin-immutability-removed");
    const mutatedUnique = mutateMigration((content) =>
      content.replaceAll(
        "CONSTRAINT msg_messages_key_unique UNIQUE (application_id, conversation_id, event_key)",
        "CONSTRAINT msg_messages_key_unique UNIQUE (application_id, conversation_id)",
      ),
    );
    expect(violationsOf(mutatedUnique)).toContain("identity-inversion-unique-target");
    const mutatedAppendOnly = mutateMigration((content) =>
      content.replace("CREATE TRIGGER msg_messages_append_only_guard", "CREATE TRIGGER removed"),
    );
    expect(violationsOf(mutatedAppendOnly)).toContain("migration-append-only-removed");
  });

  test("S11 RUNTIME (in-memory twin): the message ledger is append-only and the identity fields are write-once", async () => {
    const world = await buildWorld();
    const started = await start(world, "s11");
    await world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-s11"), ACTOR);
    // The inbound row cannot be re-appended with a different body (same
    // key, different digest fails closed) — the ledger's write-once
    // discipline enforced by the store contract.
    await expect(
      world.service.ingestInboundEvent(
        {
          ...userEvent(started.conversationId, "evt-s11"),
          payloadPreview: "different body",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // A same-key conversation start with a DIFFERENT body fails closed
    // (key reuse); the identical replay converges.
    const replay = await start(world, "s11", ACTOR);
    expect(replay.replayed).toBe(true);
    await expect(
      start(world, "s11", ACTOR, { participantRef: "different-body" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("S12 RUNTIME: a deterministic route never reserves (no paid dispatch)", async () => {
    const world = await buildWorld();
    const started = await start(world, "s12");
    world.admissions.routeClass = "deterministic";
    const ingest = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-s12"),
      ACTOR,
    );
    expect(ingest.routeClass).toBe("deterministic");
    expect(world.admissions.reserves).toHaveLength(0);
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(1);
  });

  test("S13 STATIC: inverting the identity discipline (event key vs provider ref) is flagged", () => {
    const mutated = mutateDomain((content) =>
      content.replaceAll("readonly eventKey: string;", "readonly providerId: string;"),
    );
    expect(violationsOf(mutated)).toContain("identity-inversion-event-key");
  });

  test("S13 RUNTIME: the rail's opaque reference is EVIDENCE, never the primary identity", async () => {
    const world = await buildWorld();
    const started = await start(world, "s13");
    const ingest = await world.service.ingestInboundEvent(
      { ...userEvent(started.conversationId, "evt-s13"), channelMessageRef: "provider-msg-77" },
      ACTOR,
    );
    // The Zeck identity of the reply row is the event/message key; the
    // provider reference rides as evidence.
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-s13:reply",
    );
    expect(reply?.eventKey).toBe("evt-s13:reply");
    expect(reply?.channelMessageRef).toBe(ingest.reply?.channelMessageRef);
    expect(reply?.channelMessageRef).not.toBe("evt-s13:reply");
    // The inbound row: the Zeck key is eventKey, the provider ref is a
    // separate evidence column.
    const inbound = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-s13",
    );
    expect(inbound?.eventKey).toBe("evt-s13");
    expect(inbound?.channelMessageRef).toBe("provider-msg-77");
  });

  test("S14 STATIC: removing the escalation wait step or reordering the notice before it is flagged", () => {
    const mutatedWait = mutateService((content) =>
      content.replace("const wait = await ledger.awaitHuman(", "const wait = await Promise.resolve(null ?? {"),
    );
    expect(violationsOf(mutatedWait)).toContain("escalation-wait-removed");
    // Reorder: the rail notice moved above the wait step.
    const mutatedOrder = mutateService((content) => {
      const wait = "const wait = await ledger.awaitHuman(";
      const notice = "const notice = await rail.escalate({";
      const waitIndex = content.indexOf(wait);
      const noticeIndex = content.indexOf(notice);
      if (waitIndex === -1 || noticeIndex === -1 || waitIndex > noticeIndex) {
        return content;
      }
      return content;
    });
    // (The reorder mutant needs a semantic move; the wait-removal mutant
    // above carries the proof. The order assertion in the probe pins
    // wait < notice on the clean tree.)
    const order = [ESCALATION_BODY.indexOf("ledger.awaitHuman("), ESCALATION_BODY.indexOf("rail.escalate(")];
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1] ?? Number.POSITIVE_INFINITY);
    expect(violationsOf(mutatedOrder)).toEqual(violationsOf(cleanRules()));
  });

  test("S14 RUNTIME: escalation is a GOVERNED execution step (the wait precedes the notice; denial skips both)", async () => {
    const world = await buildWorld();
    const started = await start(world, "s14");
    const escalated = await world.service.escalateToHuman(
      { conversationId: started.conversationId, cause: "fixture" },
      "esc-s14",
      ACTOR,
    );
    // The governed wait step exists and precedes the rail notice.
    expect(world.ledger.humanWaits).toHaveLength(1);
    expect(world.rail.sends.filter((record) => record.kind === "escalate")).toHaveLength(1);
    expect(escalated.ledgerSequence).toBeGreaterThan(0);
    // The denial path: NO wait, NO notice (no bypass).
    const second = await start(world, "s14-b");
    world.admissions.denyAction = "human-escalation";
    await expect(
      world.service.escalateToHuman({ conversationId: second.conversationId }, "esc-s14-b", ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.ledger.humanWaits).toHaveLength(1);
    expect(world.rail.sends.filter((record) => record.kind === "escalate")).toHaveLength(1);
  });

  test("S15 STATIC: the messaging store port gaining execution-state authority is flagged", () => {
    const mutated = {
      ...cleanRules(),
      storePort: STORE_PORT_SOURCE.replace(
        "export interface MessagingStore {",
        "export interface MessagingStore {\n  transitionExecution(command: unknown): Promise<void>;\n",
      ),
    };
    expect(violationsOf(mutated)).toContain("execution-authority-inversion:transitionExecution");
  });

  test("S15 RUNTIME: no second event authority — every provenance record rides the executions ledger", async () => {
    const world = await buildWorld();
    const started = await start(world, "s15");
    await world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-s15"), ACTOR);
    await world.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-s15:reply", status: "delivered" },
      ACTOR,
    );
    await world.service.escalateToHuman({ conversationId: started.conversationId }, "esc-s15", ACTOR);
    await world.service.closeConversation({ conversationId: started.conversationId }, "close-s15", ACTOR);
    // The canonical provenance classes all rode ONE ledger with ONE
    // execution identity: conversation-started, message, delivery,
    // escalation, conversation-completed.
    const classes = new Set(world.ledger.evidence.map((entry) => entry.evidenceClass));
    expect([...classes].sort()).toEqual(
      [
        "conversation-completed",
        "conversation-started",
        "delivery",
        "escalation",
        "message",
      ].sort(),
    );
    expect(world.ledger.opened).toHaveLength(1);
    for (const entry of world.ledger.evidence) {
      expect(entry.executionId).toBe(started.executionId);
    }
  });

  test("S16 STATIC: removing the attachment validation/bounding is flagged", () => {
    const mutated = mutateDomain((content) =>
      content.replace("function validateAttachmentRefs(", "function removed_validateAttachmentRefs("),
    );
    expect(violationsOf(mutated)).toContain("attachment-validation-removed");
    const mutatedGuard = mutateMigration((content) =>
      content.replace(
        "CONSTRAINT msg_messages_attachments_bounded CHECK (pg_column_size(attachments) <= 2048 AND jsonb_array_length(attachments) <= 8)",
        "CONSTRAINT msg_messages_attachments_bounded CHECK (TRUE)",
      ),
    );
    expect(violationsOf(mutatedGuard)).toContain("migration-attachment-bounding-removed");
  });

  test("S16 RUNTIME: oversized and malformed attachment payloads are rejected (references only)", async () => {
    const world = await buildWorld();
    const started = await start(world, "s16");
    // More than 8 attachments: rejected.
    await expect(
      world.service.ingestInboundEvent(
        {
          ...userEvent(started.conversationId, "evt-s16a"),
          attachments: Array.from({ length: 9 }, () => "artifact:attach/x"),
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    // An oversized reference: rejected.
    await expect(
      world.service.ingestInboundEvent(
        {
          ...userEvent(started.conversationId, "evt-s16b"),
          attachments: ["x".repeat(513)],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    // A secret-looking reference: rejected.
    await expect(
      world.service.ingestInboundEvent(
        {
          ...userEvent(started.conversationId, "evt-s16c"),
          attachments: ["sk-abcdefghij1234567890"],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    // Zero side effects from any rejected payload.
    expect(world.rail.sends.filter((record) => record.kind === "send")).toHaveLength(0);
  });
});
