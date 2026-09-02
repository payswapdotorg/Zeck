/**
 * In-memory edge world (unit-test infrastructure; WORK-029).
 *
 * The governed edge fabric over the REAL integration code (the service,
 * the simulated controller, the in-memory store, the REAL authority
 * adapters' contracts) and the REAL in-memory executions module (the
 * canonical ledger the evidence rides + the public wait-human/resume
 * transition surface), with the authority seams as recording fakes (the
 * policy/capability/budget seams the REAL engines fill at the PG level):
 *
 *   - the simulated edge controller (the in-process LOCAL substrate);
 *   - the in-memory edge store (the migration-0024 faithful fake);
 *   - the budget authority fake from the tools fakes (reserve/settle/
 *     release with denial mode);
 *   - the executions service over the in-memory store — step events ride
 *     the canonical EventEnvelope ledger exactly as in production, and
 *     the human gate drives the executions lifecycle wait-human/resume.
 */

import { createHash } from "node:crypto";
import type {
  EdgeCommandRequest,
  EdgeDeviceRegistrationRequest,
  EdgeEnvelopeAdmissionRequest,
  EdgeSafetyEnvelopeContent,
  EdgeService,
} from "../../../src/integrations/edge/public";
import {
  createEdgeExecutionLedgerAdapter,
  createEdgeService,
  createSimulatedEdgeController,
  edgeCommandFingerprint,
  edgeEnvelopeFingerprint,
  InMemoryEdgeStore,
  type SimulatedEdgeController,
} from "../../../src/integrations/edge/public";
import type { BudgetAuthority } from "../../../src/modules/budgets/public";
import type { ExecutionRecord } from "../../../src/modules/executions/domain/execution";
import type { ExecutionService } from "../../../src/modules/executions/public";
import { createExecutionService } from "../../../src/modules/executions/public";
import { PlatformError } from "../../../src/shared/errors";
import { InMemoryExecutionStore, InMemoryExecutionsIdempotency } from "../executions/fakes";
import { FakeBudgetAuthority } from "../tools/fakes";

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Recording allow/deny policy admission fake (the seam the engine fills). */
export class FakeEdgePolicyAdmission {
  readonly calls: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly toolFact: string;
    readonly controllerRef: string;
    readonly channels: readonly string[];
  }[] = [];
  private deny = false;
  private reason = "policy says no";
  private denyWhen: ((fact: { toolFact: string; controllerRef?: string }) => boolean) | null = null;

  denyWith(reason: string): void {
    this.deny = true;
    this.reason = reason;
  }

  /** Reset to the allow state (for multi-scenario denial ordering tests). */
  allow(): void {
    this.deny = false;
    this.denyWhen = null;
  }

  denyFactsMatching(
    predicate: (fact: { toolFact: string; controllerRef?: string }) => boolean,
  ): void {
    this.denyWhen = predicate;
  }

  readonly impl = {
    admit: async (request: {
      readonly tenantId: string;
      readonly applicationId: string;
      readonly executionId: string | null;
      readonly toolFact: string;
      readonly controllerRef: string;
      readonly channels: readonly string[];
    }) => {
      this.calls.push({
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        toolFact: request.toolFact,
        controllerRef: request.controllerRef,
        channels: [...request.channels],
      });
      if (this.deny) {
        return { allowed: false as const, reason: this.reason };
      }
      if (this.denyWhen?.({ toolFact: request.toolFact, controllerRef: request.controllerRef })) {
        return { allowed: false as const, reason: `policy denies ${request.toolFact}` };
      }
      return {
        allowed: true as const,
        evidence: {
          policySetId: "set-1",
          policySetVersion: 1,
          policyContentHash: "hash-1",
          restrictionSetDigest: "digest-1",
        },
      };
    },
  };
}

/** Recording capability gate fake: satisfiable or unmet per configuration. */
export class FakeEdgeCapabilityGate {
  readonly calls: { readonly requirementAtoms: readonly string[] }[] = [];
  private unmet: readonly string[] = [];

  failWith(unmet: readonly string[]): void {
    this.unmet = unmet;
  }

  readonly impl = {
    resolve: async (request: { readonly requirementAtoms: readonly string[] }) => {
      this.calls.push({ requirementAtoms: [...request.requirementAtoms] });
      if (this.unmet.length > 0) {
        return { satisfied: false as const, unmet: [...this.unmet], satisfactions: [] };
      }
      return {
        satisfied: true as const,
        unmet: [],
        satisfactions: ["claim-1@1.0.0:adapter-declared"],
      };
    },
  };
}

export interface EdgeWorldOptions {
  /** Pass `null` to construct the service with NO budget authority wired. */
  readonly budgetAuthority?: BudgetAuthority | null;
}

export interface InMemoryEdgeWorld {
  readonly executionService: ExecutionService;
  readonly store: InMemoryEdgeStore;
  readonly controller: SimulatedEdgeController;
  readonly policy: FakeEdgePolicyAdmission;
  readonly capabilities: FakeEdgeCapabilityGate;
  readonly budgets: FakeBudgetAuthority;
  readonly service: EdgeService;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly otherTenantId: string;
  readonly actorId: string;
  readonly approverId: string;
  now(): Date;
  advance(ms: number): void;
  register(
    input?: Partial<EdgeDeviceRegistrationRequest>,
    idempotencyKey?: string,
  ): Promise<string>;
  seedExecution(status?: ExecutionRecord["status"]): Promise<string>;
  actor(): { actorId: string; tenantId: string };
  defaultEnvelopeContent(overrides?: Partial<EdgeSafetyEnvelopeContent>): EdgeSafetyEnvelopeContent;
  approveEnvelope(
    executionId: string,
    deviceId: string,
    content?: EdgeSafetyEnvelopeContent,
    options?: {
      readonly costCeilingMicroUsd?: string;
      readonly supersedesEnvelopeId?: string | null;
      readonly decide?: "approved" | "denied" | "skipped";
      readonly approvalKey?: string;
      readonly envelopeKey?: string;
    },
  ): Promise<{ readonly approvalId: string; readonly envelopeId: string }>;
  commandRequest(
    executionId: string,
    deviceId: string,
    envelopeId: string,
    overrides?: Partial<EdgeCommandRequest>,
  ): EdgeCommandRequest;
  approveCommand(
    request: EdgeCommandRequest,
    options?: {
      readonly decide?: "approved" | "denied" | "skipped";
      readonly approvalKey?: string;
    },
  ): Promise<string>;
}

/** The canonical device registration the suites use. */
export function deviceRegistration(
  overrides: Partial<EdgeDeviceRegistrationRequest> = {},
): EdgeDeviceRegistrationRequest {
  return {
    applicationId: "11111111-1111-7000-8000-000000000001",
    actor: {
      actorId: "00000000-0000-7000-8000-0000000000aa",
      tenantId: "00000000-0000-7000-8000-0000000000bb",
    },
    label: "cell-1 controller",
    workloadClasses: ["edge", "embodied", "realtime"],
    capabilityAtoms: ["edge-channel-locomotion", "edge-channel-manipulation", "edge-telemetry"],
    controllerRef: "controller-alpha",
    ...overrides,
  };
}

export function createInMemoryEdgeWorld(options: EdgeWorldOptions = {}): InMemoryEdgeWorld {
  const executionStore = new InMemoryExecutionStore();
  const idempotency = new InMemoryExecutionsIdempotency();
  idempotency.store = executionStore;
  let idCounter = 7000;
  const generateId = () => {
    idCounter += 1;
    return `00000000-0000-7000-8000-${String(idCounter).padStart(12, "0")}`;
  };
  let clock = new Date("2026-09-15T12:00:00Z");

  const executionService = createExecutionService({
    store: executionStore,
    idempotency,
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => clock,
  });
  const store = new InMemoryEdgeStore();
  const controller = createSimulatedEdgeController({
    controllerId: "controller-alpha",
    now: () => clock,
    digest: sha256Hex,
  });
  const policy = new FakeEdgePolicyAdmission();
  const capabilities = new FakeEdgeCapabilityGate();
  const budgets = new FakeBudgetAuthority();

  const service = createEdgeService({
    policy: policy.impl,
    capabilities: capabilities.impl,
    ...(options.budgetAuthority === null
      ? {}
      : { budgetAuthority: options.budgetAuthority ?? budgets.impl }),
    store,
    ledger: createEdgeExecutionLedgerAdapter(executionService),
    controller,
    generateId,
    now: () => clock,
    digest: sha256Hex,
  });

  const applicationId = "11111111-1111-7000-8000-000000000001";
  const tenantId = "00000000-0000-7000-8000-0000000000bb";
  const otherTenantId = "00000000-0000-7000-8000-0000000000cc";
  const actorId = "00000000-0000-7000-8000-0000000000aa";
  const approverId = "00000000-0000-7000-8000-0000000000dd";
  executionStore.seedApplication(applicationId, tenantId);

  const defaultEnvelopeContent = (
    overrides: Partial<EdgeSafetyEnvelopeContent> = {},
  ): EdgeSafetyEnvelopeContent => ({
    channels: ["locomotion", "manipulation"],
    magnitudeBounds: { locomotion: [-500, 500], manipulation: [-100, 100] },
    rateBoundsPerMinute: { locomotion: 600, manipulation: 600 },
    notBefore: new Date(clock.getTime() - 60_000).toISOString(),
    notAfter: new Date(clock.getTime() + 3_600_000).toISOString(),
    maxCommands: 10,
    disconnectedPolicy: "continue-within-envelope",
    ...overrides,
  });

  const world: InMemoryEdgeWorld = {
    executionService,
    store,
    controller,
    policy,
    capabilities,
    budgets,
    service,
    applicationId,
    tenantId,
    otherTenantId,
    actorId,
    approverId,
    now: () => clock,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    async register(input = {}, idempotencyKey = `dk-${generateId()}`) {
      const receipt = await service.registerDevice(
        deviceRegistration({
          actor: { actorId, tenantId },
          ...input,
          ...(input.applicationId === undefined ? {} : { applicationId: input.applicationId }),
        }),
        idempotencyKey,
      );
      return receipt.deviceId;
    },
    async seedExecution(status: ExecutionRecord["status"] = "RUNNING") {
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "summarize", input: "artifact-1" } },
        `create-${generateId()}`,
        { actorId, tenantId },
      );
      const executionId = receipt.executionId;
      if (status !== "CREATED") {
        await executionService.transition(
          { command: "authorize", actorId, applicationId, tenantId, executionId },
          `authorize-${generateId()}`,
        );
        if (status !== "AUTHORIZED") {
          await executionService.transition(
            { command: "plan", actorId, applicationId, tenantId, executionId },
            `plan-${generateId()}`,
          );
          if (status !== "PLANNING") {
            await executionService.transition(
              { command: "queue", actorId, applicationId, tenantId, executionId },
              `queue-${generateId()}`,
            );
            if (status !== "QUEUED") {
              await executionService.transition(
                { command: "start", actorId, applicationId, tenantId, executionId },
                `start-${generateId()}`,
              );
            }
          }
        }
      }
      return executionId;
    },
    actor() {
      return { actorId, tenantId };
    },
    defaultEnvelopeContent,
    async approveEnvelope(
      executionId: string,
      deviceId: string,
      content: EdgeSafetyEnvelopeContent = defaultEnvelopeContent(),
      options: {
        readonly costCeilingMicroUsd?: string;
        readonly supersedesEnvelopeId?: string | null;
        readonly decide?: "approved" | "denied" | "skipped";
        readonly approvalKey?: string;
        readonly envelopeKey?: string;
      } = {},
    ) {
      const request: EdgeEnvelopeAdmissionRequest = {
        applicationId,
        actor: { actorId, tenantId },
        executionId,
        deviceId,
        content,
        costCeilingMicroUsd: options.costCeilingMicroUsd ?? "0",
        approvalId: "pending",
        supersedesEnvelopeId: options.supersedesEnvelopeId ?? null,
      };
      // computed over the canonical shape WITHOUT the approval id (the
      // approval binds to the subject shape — see the domain note)
      const subjectFingerprint = edgeEnvelopeFingerprint(request);
      const approval = await service.requestApproval(
        {
          applicationId,
          actor: { actorId, tenantId },
          executionId,
          deviceId,
          subjectKind: "envelope",
          subjectFingerprint,
          policyBasis: "edge policy set v1 (unit world)",
          expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(),
        },
        options.approvalKey ?? `ak-${generateId()}`,
      );
      if (options.decide !== "skipped") {
        await service.decideApproval(
          {
            applicationId,
            actor: { actorId, tenantId },
            approvalId: approval.approvalId,
            approverId,
            decision: options.decide === "denied" ? "denied" : "approved",
            rationale:
              options.decide === "denied"
                ? "operator denied within test bounds"
                : "operator-approved within test bounds",
          },
          `ad-${generateId()}`,
        );
      }
      if (options.decide === "denied") {
        // the DENIED approval path: no admission can follow (the caller
        // asserts the typed refusal)
        return { approvalId: approval.approvalId, envelopeId: "" };
      }
      const envelope = await service.admitEnvelope(
        { ...request, approvalId: approval.approvalId },
        options.envelopeKey ?? `ek-${generateId()}`,
      );
      return { approvalId: approval.approvalId, envelopeId: envelope.envelopeId };
    },
    commandRequest(
      executionId: string,
      deviceId: string,
      envelopeId: string,
      overrides: Partial<EdgeCommandRequest> = {},
    ): EdgeCommandRequest {
      return {
        applicationId,
        actor: { actorId, tenantId },
        executionId,
        deviceId,
        envelopeId,
        commandKind: "actuate",
        channel: "locomotion",
        magnitude: 100,
        payload: { profile: "unit-test-step" },
        notBefore: new Date(clock.getTime() - 1_000).toISOString(),
        notAfter: new Date(clock.getTime() + 300_000).toISOString(),
        estimatedMicroUsd: "0",
        approvalId: null,
        ...overrides,
      };
    },
    async approveCommand(
      request: EdgeCommandRequest,
      options: {
        readonly decide?: "approved" | "denied" | "skipped";
        readonly approvalKey?: string;
      } = {},
    ) {
      const subjectFingerprint = edgeCommandFingerprint(request);
      const approval = await service.requestApproval(
        {
          applicationId,
          actor: { actorId, tenantId },
          executionId: request.executionId,
          deviceId: request.deviceId,
          subjectKind: "command",
          subjectFingerprint,
          policyBasis: "edge policy set v1 (unit world)",
          expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(),
        },
        options.approvalKey ?? `ck-${generateId()}`,
      );
      if (options.decide !== "skipped") {
        await service.decideApproval(
          {
            applicationId,
            actor: { actorId, tenantId },
            approvalId: approval.approvalId,
            approverId,
            decision: "approved",
            rationale: "operator-approved within test bounds",
          },
          `cd-${generateId()}`,
        );
      }
      return approval.approvalId;
    },
  };
  return world;
}

/** Assert a typed PlatformError with the expected code (the house helper). */
export function expectPlatformError(
  code: string,
  run: Promise<unknown> | (() => Promise<unknown>),
): Promise<PlatformError> {
  const promise = typeof run === "function" ? run() : run;
  return promise.then(
    () => {
      throw new Error(`expected a PlatformError with code ${code}`);
    },
    (error: unknown) => {
      if (error instanceof PlatformError) {
        if (error.code !== code) {
          throw new Error(
            `expected PlatformError code ${code}, got ${error.code}: ${error.message}`,
          );
        }
        return error;
      }
      throw error;
    },
  );
}
