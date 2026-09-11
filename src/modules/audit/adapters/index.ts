/**
 * `audit` adapters layer barrel (WORK-059 / SEC-004).
 *
 * The only module layer allowed to import `src/platform/**` and
 * provider SDKs within the owning-adapter rules (`IMPLEMENTATION.md`
 * §1, §3). This module has NO provider SDK: the SQL adapter bridges
 * the provider-neutral `DatabasePort` (PostgreSQL 16+); the seam
 * observers observe existing authority seams through their public
 * contracts / structural seam types.
 */

export * from "./in-memory-audit-store";
export * from "./node-digest";
export * from "./observing-authorization";
export * from "./observing-decision-store";
export * from "./observing-execution-service";
export * from "./sql-audit-store";
