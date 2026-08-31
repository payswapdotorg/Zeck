/**
 * Benchmark harness barrel (WORK-016).
 *
 * `benchmarks/` is measurement, never authority: the harness compares
 * execution strategies on representative governed tasks over the SAME
 * execution/evidence contract and emits evidence records + a pure
 * report. See `README.md` for the methodology.
 */

export type {
  BenchmarkEnvironment,
  BenchmarkEvidence,
  BenchmarkReport,
  BenchmarkStrategyKind,
  BenchmarkTask,
  ExecutionRunMeasurement,
  StrategyTaskSummary,
} from "./contract";
export { BENCHMARK_STRATEGY_KINDS } from "./contract";

export type { BenchmarkHarness, BenchmarkHarnessDeps, BenchmarkStrategy } from "./harness";
export { createBenchmarkHarness } from "./harness";
export { buildBenchmarkReport, renderBenchmarkReport } from "./report";
export type { BenchmarkStrategyDeps } from "./strategies";
export { byoaStubExternalAgent, createBenchmarkStrategies, nativeStubProvider } from "./strategies";
