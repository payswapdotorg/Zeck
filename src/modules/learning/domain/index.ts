/**
 * `learning` domain layer (WORK-014).
 *
 * The observation model: execution outcome telemetry, versioned
 * scorecards, planning-consumable signals, shadow evaluation and user
 * rating evidence. Domain code may import this module's own layers,
 * `src/shared/**` — never `src/platform/**`, adapters, provider SDKs or
 * HTTP libraries, and NEVER another module (the learning module is a
 * pure observation island by design: the non-authority invariant is
 * physical, not documented).
 */
export * from "./canonical";
export * from "./rating";
export * from "./scorecard";
export * from "./shadow";
export * from "./signal";
export * from "./telemetry";
