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
export {
  createDeterministicReplacementExecutor,
  DETERMINISTIC_INPUT_ENV,
  replacementConfinementCheck,
} from "./deterministic-replacement-sandbox-executor";
export { createExecutionLedgerAdapter } from "./execution-ledger";
export { InMemorySynthesisStore } from "./in-memory-synthesis-store";
export { createPolicyToolAdmission } from "./policy-tool-admission";
export { SqlSynthesisStore } from "./sql-synthesis-store";
export { SqlToolInvocationStore } from "./sql-tool-store";
export { createSynthesizedAdapterFactory } from "./synthesis-adapter-factory";
export {
  confinementCheck,
  createSynthesisSandboxExecutor,
  SYNTH_INPUT_ENV,
} from "./synthesis-sandbox-executor";
