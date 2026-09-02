/**
 * `learning` domain layer (WORK-014; WORK-022 adds the opportunity-
 * analysis model: execution graphs, findings, prompts, evaluation
 * ratings, finding transitions).
 *
 * The observation model: execution outcome telemetry, versioned
 * scorecards, planning-consumable signals, shadow evaluation, user
 * rating evidence and the codebase-opportunity advisory model
 * (DTR-005/HUM-001..003). Domain code may import this module's own
 * layers, `src/shared/**` — never `src/platform/**`, adapters, provider
 * SDKs or HTTP libraries, and NEVER another module (the learning
 * module is a pure observation island by design: the non-authority
 * invariant is physical, not documented).
 */
export * from "./canonical";
export * from "./composition";
export * from "./composition-analysis";
export * from "./evaluation-rating";
export * from "./execution-graph";
export * from "./finding-transitions";
export * from "./human-evaluation";
export * from "./learned-planning-policy";
export * from "./opportunity-analysis";
export * from "./rating";
export * from "./scorecard";
export * from "./shadow";
export * from "./signal";
export * from "./telemetry";
export * from "./tool-facts";
