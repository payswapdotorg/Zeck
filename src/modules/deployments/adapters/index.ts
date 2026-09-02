/**
 * `deployments` adapters layer — infrastructure and provider
 * implementations for this module (WORK-023, WORK-024, WORK-025).
 *
 * The only module layer allowed to import `src/platform/**` and
 * provider SDKs within the owning-adapter rules (`IMPLEMENTATION.md`
 * §1, §3). No vendor SDKs exist here at v1: modality rails arrive
 * with WORK-024/025/026 behind the neutral seam.
 */

export { createAgentInventoryAdapter } from "./agent-inventory-adapter";
export { createBudgetMessagingAdmission } from "./budget-messaging-admission";
export { createBudgetRealtimeAdmission } from "./budget-realtime-admission";
export { createCapabilityMessagingAdmission } from "./capability-messaging-admission";
export { createCapabilityRealtimeAdmission } from "./capability-realtime-admission";
export { createConnectionsMessagingSecretMediation } from "./connections-messaging-secret-mediation";
export { createConnectionsRealtimeSecretMediation } from "./connections-realtime-secret-mediation";
export { createSqlEnvironmentResolver } from "./environment-resolver-adapter";
export { InMemoryDeploymentStore } from "./in-memory-deployment-store";
export { InMemoryMessagingStore } from "./in-memory-messaging-store";
export { InMemoryRealtimeStore } from "./in-memory-realtime-store";
export { createInProcessMessagingRail } from "./in-process-messaging-rail";
export { createInProcessRealtimeRail } from "./in-process-realtime-rail";
export { createMessagingExecutionLedgerAdapter } from "./messaging-execution-ledger";
export { createMessagingModalityAdapter } from "./messaging-modality-adapter";
export { createPlannerMessagingSubtaskRouter } from "./planner-messaging-subtask-router";
export { createPlannerSubtaskRouter } from "./planner-subtask-router";
export { createPolicyMessagingAdmission } from "./policy-messaging-admission";
export { createPolicyRealtimeAdmission } from "./policy-realtime-admission";
export { createRealtimeExecutionLedgerAdapter } from "./realtime-execution-ledger";
export { createRealtimeModalityAdapter } from "./realtime-modality-adapter";
export { SqlDeploymentStore } from "./sql-deployment-store";
export { SqlMessagingStore } from "./sql-messaging-store";
export { SqlRealtimeStore } from "./sql-realtime-store";
