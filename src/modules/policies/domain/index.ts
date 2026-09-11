/**
 * `policies` domain layer — entities, invariants and value objects of this module.

Domain code may import this module's own layers, `src/shared/**` and other
modules' `public.ts` — never `src/platform/**`, adapters, provider SDKs or
HTTP libraries (`IMPLEMENTATION.md` §3).
 */

export * from "./admission";
export * from "./learned-output-boundary";
export * from "./policy";
// D-08 / WORK-060 (SEC-003): the residency constraint vocabulary — a
// policy-CONSUMED input with pure fail-closed evaluation (no restriction
// dimension, no authority surface; the nine-dimension vocabulary is untouched).
export * from "./residency";
