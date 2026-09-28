/**
 * The pinned-runtime registry (PPR-018A) — the composition seam where
 * application work orders (PPR-018..027) register their exact pinned
 * integration runtimes.
 *
 * The registry is deliberately DUMB: it maps a runtime id (the Demo
 * Mirror entry's `runBinding.runtime` string) to the registered
 * driver and refuses everything else honestly. It performs NO
 * authorization of its own — running a certified path is the demo-run
 * service's decision (derived status + exact pins + erasure); the
 * registry only makes drivers resolvable.
 *
 * Registration is validated fail-closed: a structurally invalid or
 * duplicate registration is a NAMED issue returned to the registrant
 * (never silently dropped, never best-effort registered).
 */

import { validatePinnedApplication } from "../domain/revisions";
import type { PinnedRuntimeDriver, RuntimeRegistryIssue } from "../ports/runtime";

export interface PinnedRuntimeRegistryOptions {
  /** Drivers to register at construction (optional — registries may start empty). */
  readonly drivers?: readonly PinnedRuntimeDriver[];
}

/** One registered runtime's descriptor (the projection the UI renders). */
export interface RegisteredRuntimeDescriptor {
  readonly runtimeId: string;
  readonly applicationId: string;
  readonly name: string;
  readonly upstreamRevision: string;
  readonly integrationRevision: string;
}

/** Create the pinned-runtime registry (fail-closed, honest misses). */
export function createRuntimeRegistry(options: PinnedRuntimeRegistryOptions = {}): {
  /** Register one driver (named issues on invalid/duplicate registrations). */
  readonly register: (driver: PinnedRuntimeDriver) => readonly RuntimeRegistryIssue[];
  /** Resolve a runtime id to its driver (null when none is registered — honest). */
  readonly resolve: (runtimeId: string) => PinnedRuntimeDriver | null;
  /** Every registered runtime's descriptor (stable order). */
  readonly list: () => readonly RegisteredRuntimeDescriptor[];
} {
  const drivers = new Map<string, PinnedRuntimeDriver>();
  const register = (driver: PinnedRuntimeDriver): readonly RuntimeRegistryIssue[] => {
    if (typeof driver !== "object" || driver === null) {
      return [{ issue: "a pinned runtime driver must be an object" }];
    }
    if (typeof driver.runtimeId !== "string" || driver.runtimeId.trim().length === 0) {
      return [{ issue: "a pinned runtime driver carries a non-empty runtime id" }];
    }
    const identityIssues = validatePinnedApplication({
      identity: driver.identity,
      pin: driver.pin,
    });
    if (identityIssues.length > 0) {
      return identityIssues.map((issue) => ({
        runtimeId: driver.runtimeId,
        issue: `invalid pinned application (${issue.field}: ${issue.issue})`,
      }));
    }
    if (typeof driver.start !== "function") {
      return [{ runtimeId: driver.runtimeId, issue: "a pinned runtime driver implements start()" }];
    }
    if (drivers.has(driver.runtimeId)) {
      return [
        {
          runtimeId: driver.runtimeId,
          issue:
            "a runtime is already registered under this id (one runtime per id — register the exact pinned pair once)",
        },
      ];
    }
    drivers.set(driver.runtimeId, driver);
    return [];
  };
  for (const driver of options.drivers ?? []) {
    register(driver);
  }
  return {
    register,
    resolve: (runtimeId: string) => drivers.get(runtimeId) ?? null,
    list: () =>
      [...drivers.values()]
        .map((driver) => ({
          runtimeId: driver.runtimeId,
          applicationId: driver.identity.applicationId,
          name: driver.identity.name,
          upstreamRevision: driver.pin.upstreamRevision,
          integrationRevision: driver.pin.integrationRevision,
        }))
        .sort((a, b) => (a.runtimeId < b.runtimeId ? -1 : a.runtimeId > b.runtimeId ? 1 : 0)),
  };
}

export type PinnedRuntimeRegistry = ReturnType<typeof createRuntimeRegistry>;
