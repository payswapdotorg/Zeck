/**
 * In-memory tool registry (tools module application; WORK-010).
 *
 * The TOOL ADMISSION authority surface: validated contracts + bound
 * adapters, arbitrated under a serialization lock (the WORK-005 registry
 * precedent — validate → compare → insert is atomic with respect to
 * concurrent registrations; identical re-registrations converge; a
 * different contract for the same (toolId, version) is rejected because
 * contracts are immutable once registered).
 *
 * This is NOT a capability registry: capability identity resolution happens
 * in the capabilities module (WORK-005), consulted by the runtime at
 * capability admission. The two authorities are complementary by design —
 * this registry answers "which adapter serves this tool identity", the
 * capability registry answers "is this capability claim satisfied".
 *
 * Durability decision (WORK-005/007 store-port precedent): registration is
 * composition-time configuration; a durable registry adapter would
 * implement the identical `ToolRegistry` contract without touching the
 * runtime.
 */

import type { ToolContract } from "../domain/tool";
import { validateToolContract } from "../domain/tool";
import { createAsyncLock } from "../internal";
import type { RegisteredTool, RegisterToolOutcome, ToolRegistry } from "../ports/tool-registry";

interface RegistryEntry extends RegisteredTool {
  /** Serialized binding identity for convergence checks. */
  readonly bindingKey: string;
}

/** Deterministic JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]);
  }
  return value;
}

function bindingIdentityOf(contract: ToolContract): string {
  return canonicalJson(contract);
}

export function createToolRegistry(): ToolRegistry {
  const lock = createAsyncLock();
  const byToolId = new Map<string, RegistryEntry>();

  return {
    async register(contract, adapter): Promise<RegisterToolOutcome> {
      const validation = validateToolContract(contract);
      if (!validation.valid) {
        return { status: "rejected", reason: validation.reason };
      }
      return lock.run(async () => {
        const existing = byToolId.get(contract.toolId);
        if (existing !== undefined) {
          if (existing.contract.version !== contract.version) {
            return {
              status: "rejected",
              reason: `tool ${contract.toolId} is already registered at version ${existing.contract.version}; a different version for the same identity requires a new identity (contracts are immutable once registered)`,
            };
          }
          if (existing.bindingKey !== bindingIdentityOf(contract)) {
            return {
              status: "rejected",
              reason: `tool ${contract.toolId}@${contract.version} is already registered with a different contract; contracts are immutable once registered`,
            };
          }
          return { status: "converged", toolId: contract.toolId, version: contract.version };
        }
        byToolId.set(contract.toolId, {
          contract,
          adapter,
          bindingKey: bindingIdentityOf(contract),
        });
        return { status: "registered", toolId: contract.toolId, version: contract.version };
      });
    },

    async resolve(toolId) {
      const entry = byToolId.get(toolId);
      return entry === undefined ? null : { contract: entry.contract, adapter: entry.adapter };
    },

    async listContracts() {
      return [...byToolId.values()].map((entry) => entry.contract);
    },
  };
}
