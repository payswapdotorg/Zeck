/**
 * `deployments` adapters layer — infrastructure and provider
 * implementations for this module (WORK-023).
 *
 * The only module layer allowed to import `src/platform/**` and
 * provider SDKs within the owning-adapter rules (`IMPLEMENTATION.md`
 * §1, §3). No vendor SDKs exist here at v1: modality rails arrive
 * with WORK-024/025/026 behind the neutral seam.
 */

export { createAgentInventoryAdapter } from "./agent-inventory-adapter";
export { createSqlEnvironmentResolver } from "./environment-resolver-adapter";
export { InMemoryDeploymentStore } from "./in-memory-deployment-store";
export { SqlDeploymentStore } from "./sql-deployment-store";
