/**
 * `tools` adapters layer — infrastructure and provider implementations for this module.
 *
 * The only module layer allowed to import `src/platform/**` and provider SDKs
 * within the owning-adapter rules (`IMPLEMENTATION.md` §1, §3).
 */

export {
  BUILT_IN_TOOLS,
  CALCULATOR_CONTRACT,
  calculatorAdapter,
  SCHEMA_VALIDATOR_CONTRACT,
  SEED_BUILT_IN_TOOL_FACTS,
  schemaValidatorAdapter,
} from "./builtins";
export { createToolCapabilityGate } from "./capability-gate";
export { createComputerUseCapabilityGate } from "./computer-use-capability-gate";
export { createConnectionComputerUseSecretMediation } from "./connection-computer-use-secret-mediation";
export {
  createDeterministicReplacementExecutor,
  DETERMINISTIC_INPUT_ENV,
  replacementConfinementCheck,
} from "./deterministic-replacement-sandbox-executor";
export { createExecutionLedgerAdapter } from "./execution-ledger";
export {
  InMemoryComputerUseRegistry,
  registerComputerUseCapability,
} from "./in-memory-computer-use-registry";
export { InMemoryComputerUseStore } from "./in-memory-computer-use-store";
export { InMemorySynthesisStore } from "./in-memory-synthesis-store";
export { createPolicyComputerUseAdmission } from "./policy-computer-use-admission";
export { createPolicyToolAdmission } from "./policy-tool-admission";
export {
  createSandboxComputerUseTerminal,
  type SandboxComputerUseTerminalDeps,
  type SandboxComputerUseTerminalOptions,
  terminalConfinementCheck,
} from "./sandbox-computer-use-terminal";
export {
  createSimulatedComputerUseEnvironment,
  createSimulatedComputerUseHostWorld,
  SimulatedComputerUseEnvironment,
  type SimulatedComputerUseEnvironmentOptions,
  type SimulatedComputerUseHostWorld,
} from "./simulated-computer-use-environment";
export { SqlComputerUseStore } from "./sql-computer-use-store";
export { SqlSynthesisStore } from "./sql-synthesis-store";
export { SqlToolInvocationStore } from "./sql-tool-store";
export { createSynthesizedAdapterFactory } from "./synthesis-adapter-factory";
export {
  confinementCheck,
  createSynthesisSandboxExecutor,
  SYNTH_INPUT_ENV,
} from "./synthesis-sandbox-executor";
