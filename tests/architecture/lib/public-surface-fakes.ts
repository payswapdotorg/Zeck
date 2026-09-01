/** Minimal fakes for the public-surface architecture test (no module wiring). */

import type { Authenticate } from "../../../src/api";
import type { AgentRegistry } from "../../../src/modules/agents/public";
import type { ScopeResolver } from "../../../src/modules/auth/public";
import type { EconomicActionService } from "../../../src/modules/economics/public";
import type { ExecutionService } from "../../../src/modules/executions/public";

export function fakeEconomicsService(): EconomicActionService {
  const reject = (name: string) => async () => {
    throw new Error(`not exercised by the architecture gate: ${name}`);
  };
  return {
    createEconomicAction: reject("createEconomicAction") as never,
    authorizeEconomicAction: reject("authorizeEconomicAction") as never,
    chargeEconomicAction: reject("chargeEconomicAction") as never,
    recordExternalSettlement: reject("recordExternalSettlement") as never,
    recordDeliveryObservation: reject("recordDeliveryObservation") as never,
    getEconomicAction: (async () => null) as never,
    listEconomicActionEvents: (async () => []) as never,
    deliveryEvidence: (async () => null) as never,
    economicOutcomeFacts: (async () => []) as never,
  };
}

export function fakeExecutionsService(): ExecutionService {
  const reject = (name: string) => async () => {
    throw new Error(`not exercised by the architecture gate: ${name}`);
  };
  return {
    createExecution: reject("createExecution") as never,
    transition: reject("transition") as never,
    recordPlanningDecision: reject("recordPlanningDecision") as never,
    recordStepEvent: reject("recordStepEvent") as never,
    getExecution: (async () => null) as never,
    listEvents: (async () => []) as never,
    listVerificationResults: (async () => []) as never,
  };
}

export function fakeAgentRegistry(): AgentRegistry {
  const reject = (name: string) => async () => {
    throw new Error(`not exercised by the architecture gate: ${name}`);
  };
  return {
    registerAgent: reject("registerAgent") as never,
    publishVersion: reject("publishVersion") as never,
    promote: reject("promote") as never,
    rollback: reject("rollback") as never,
    suspend: reject("suspend") as never,
    resume: reject("resume") as never,
    retire: reject("retire") as never,
    getAgent: (async () => null) as never,
    getAgentBySlug: (async () => null) as never,
    listVersions: (async () => []) as never,
    listSelections: (async () => []) as never,
    currentSelection: (async () => null) as never,
  };
}

export function fakeScopeResolver(): ScopeResolver {
  const reject = (name: string) => async () => {
    throw new Error(`not exercised by the architecture gate: ${name}`);
  };
  return {
    resolveApplicationScope: reject("resolveApplicationScope") as never,
    resolveTenantScope: reject("resolveTenantScope") as never,
    requirePermission: () => {},
  };
}

export function fakeAuthenticate(): Authenticate {
  return async () => ({
    actorId: "00000000-0000-7000-8000-0000000000aa",
    authenticatedAt: "2026-09-15T12:00:00Z",
  });
}
