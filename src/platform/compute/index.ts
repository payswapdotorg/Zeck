/**
 * Platform compute-plane seam barrel (WORK-046 / D-05).
 *
 * The infrastructure surface of the execution-worker fabric:
 *
 *   - `port.ts` — the provider-neutral worker/lease/claim/completion
 *     contract family (the four module seams + the bounded fabric
 *     policy + the durable compute-plane store port);
 *   - `config.ts` — the bounded policy loader (fail-closed);
 *   - `pg-store.ts` — the SQL compute-plane store (schema
 *     `compute_plane`, migration 0028);
 *   - `container-runtime.ts` — the concrete container runtime client
 *     over the documented container-runner REST protocol (zero new
 *     SDKs);
 *   - `fabric.ts` — the worker loop engine (consume, heartbeat,
 *     recover, drain).
 *
 * Platform code never imports domain modules (`platform-isolation`);
 * provider-neutral contracts live here, provider mechanics here, the
 * module-side seam implementations in the owning modules, vendor SDKs
 * nowhere.
 */

export * from "./config";
export * from "./container-runtime";
export * from "./fabric";
export * from "./pg-store";
export * from "./port";
