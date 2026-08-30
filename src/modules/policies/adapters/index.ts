/**
 * `policies` adapters layer — infrastructure and provider implementations for this module.

The only module layer allowed to import `src/platform/**` and provider SDKs
within the owning-adapter rules (`IMPLEMENTATION.md` §1, §3). The seam
adapters (`execution-authorization`, `dispatch-admission`) implement OTHER
modules' REQUIRED inbound ports against this module's authority — type-only
couplings through their public barrels (the seams' own headers sanction the
wiring; zero runtime dependency).
 */

export * from "./dispatch-admission";
export * from "./execution-authorization";
export * from "./in-memory-policy-store";
export * from "./node-policy-hasher";
