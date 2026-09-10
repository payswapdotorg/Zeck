/**
 * The runtime provider adapters barrel (platform substrate-economics
 * plane; WORK-054).
 *
 *  - `port.ts`         — the adapter seam contract (the declared
 *                        `ContainerRuntimeClient` discipline + the
 *                        neutral readiness reporting), the typed
 *                        fail-closed adapter errors, the composition
 *                        binding validation and the shared neutral
 *                        output bounding;
 *  - `e2b.ts`          — the E2B adapter (microvm; snapshot restores;
 *                        creating→started, running→ready);
 *  - `daytona.ts`      — the Daytona adapter (microvm; snapshot
 *                        restores; warm pools provider-side;
 *                        pending→started, running→ready);
 *  - `modal.ts`        — the Modal adapter (container; directory
 *                        snapshots; the 1:1 created/scheduled/started/
 *                        ready lifecycle; in-use is NOT ready);
 *  - `self-hosted.ts`  — the self-hosted adapter over an EXISTING
 *                        `ContainerRuntimeClient` (the governed
 *                        customer runner seam — zero new protocol)
 *                        with an optional health probe.
 *
 * Provider vocabularies are CONFINED to the adapter files (each
 * declares its own typed provider transport — the documented
 * provider-API surface it translates); the neutral shapes that cross
 * OUT of the adapters are vendor-free by construction.
 */

export * from "./daytona";
export * from "./e2b";
export * from "./modal";
export * from "./port";
export * from "./self-hosted";
