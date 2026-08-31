/**
 * Platform sandbox seam barrel (WORK-012).
 *
 * The infrastructure surface of the compute-environment platform:
 *
 *   - `container-profile.ts` — the provider-neutral container
 *     configuration model + the fail-closed escape validator;
 *   - `runtime-client.ts` — the `ContainerRuntimeClient` port concrete
 *     container runtimes implement (no implementation ships in WORK-012;
 *     dispatch without a client fails closed);
 *   - `process-runtime.ts` — the process substrate executor (explicit env
 *     only, ephemeral isolated workspace, no shell, hard timeout).
 *
 * Platform code never imports domain modules (`platform-isolation`);
 * provider-neutral contracts live in `src/modules/sandbox/`, provider
 * mechanics here, vendor SDKs nowhere.
 */

export * from "./container-profile";
export * from "./process-runtime";
export * from "./runtime-client";
