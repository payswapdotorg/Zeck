/**
 * Substrate catalog adapter (planning module adapter; WORK-031).
 *
 * Wraps the capabilities module's PUBLIC substrate registry as the
 * planning `SubstrateCatalog` port, with FAIL-CLOSED consumer-side
 * validation of every consulted entry (the composition-recommendations
 * adapter pattern: the seam's output is re-validated before the
 * planner trusts it).
 */

import { PlatformError } from "../../../shared/errors";
import type { SubstrateRegistry } from "../../capabilities/public";
import type { SubstrateCatalog, SubstrateCatalogEntry } from "../ports/substrate-catalog";

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ADAPTER_REF_PATTERN = /^[a-z0-9][a-z0-9.-]{0,199}$/;

function validateEntry(entry: unknown): SubstrateCatalogEntry {
  if (entry === null || typeof entry !== "object") {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "substrate catalog entry must be an object",
    });
  }
  const e = entry as SubstrateCatalogEntry;
  if (typeof e.substrateId !== "string" || !IDENTITY_PATTERN.test(e.substrateId)) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "catalog substrateId must be an identifier",
    });
  }
  if (typeof e.version !== "string" || !VERSION_PATTERN.test(e.version)) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "catalog version must be semver",
    });
  }
  if (typeof e.adapterRef !== "string" || !ADAPTER_REF_PATTERN.test(e.adapterRef)) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message:
        "catalog adapterRef must be an opaque neutral reference (vendor identifiers never cross)",
    });
  }
  if (!Array.isArray(e.workloadClasses) || e.workloadClasses.length === 0) {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "catalog workloadClasses must be non-empty",
    });
  }
  if (e.resource === null || typeof e.resource !== "object") {
    throw new PlatformError({
      code: "NO_ELIGIBLE_ROUTE",
      message: "catalog resource profile is required",
    });
  }
  return {
    substrateId: e.substrateId,
    version: e.version,
    adapterRef: e.adapterRef,
    workloadClasses: [...e.workloadClasses],
    latencyClass: String(e.latencyClass ?? ""),
    isolation: String(e.isolation ?? ""),
    status: String(e.status ?? "unknown"),
    resource: { ...e.resource },
    executionCapabilityId: String(e.executionCapabilityId ?? ""),
  };
}

export function createSubstrateCatalogAdapter(registry: SubstrateRegistry): SubstrateCatalog {
  return {
    async listAvailable(applicationId, workloadClass) {
      const records = await registry.listAvailableByWorkloadClass(applicationId, workloadClass);
      return records.map((record) =>
        validateEntry({
          substrateId: record.substrateId,
          version: record.version,
          adapterRef: record.adapterRef,
          workloadClasses: record.workloadClasses,
          latencyClass: record.latencyClass,
          isolation: record.isolation,
          status: record.status,
          resource: record.resource,
          executionCapabilityId: record.executionCapability.id,
        }),
      );
    },
  };
}
