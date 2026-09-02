/**
 * In-memory computer-use capability registry (tools module adapter;
 * WORK-027).
 *
 * The reference registry for tests and composition roots: declarations
 * are validated at registration (fail-closed), identical
 * re-registrations converge, and a DIFFERENT declaration under a live
 * capability id fails closed (a capability contract never silently
 * drifts). The registry decides NOTHING about policy/budget/capability
 * authority — it only admits provider-neutral contracts (AC-5's first
 * half: malformed or unregistered declarations never dispatch).
 */

import { PlatformError } from "../../../shared/errors";
import type { ComputerUseCapabilityDeclaration, ComputerUseCheck } from "../domain/computer-use";
import { validateComputerUseCapability } from "../domain/computer-use";
import type { ComputerUseCapabilityRegistry } from "../ports/computer-use-registry";

export class InMemoryComputerUseRegistry implements ComputerUseCapabilityRegistry {
  private readonly declarations = new Map<string, ComputerUseCapabilityDeclaration>();

  async register(declaration: ComputerUseCapabilityDeclaration): Promise<ComputerUseCheck> {
    const check = validateComputerUseCapability(declaration);
    if (!check.valid) {
      return check;
    }
    const existing = this.declarations.get(declaration.capabilityId);
    if (existing !== undefined) {
      const same =
        JSON.stringify([...existing.covers].sort()) ===
          JSON.stringify([...declaration.covers].sort()) &&
        existing.kind === declaration.kind &&
        existing.description === declaration.description &&
        existing.capabilityAtom === declaration.capabilityAtom &&
        existing.deterministicQuality === declaration.deterministicQuality &&
        existing.qualityConfidence === declaration.qualityConfidence &&
        existing.estimatedMicroUsd === declaration.estimatedMicroUsd &&
        JSON.stringify([...existing.hosts].sort()) ===
          JSON.stringify([...declaration.hosts].sort()) &&
        existing.secretRef === declaration.secretRef &&
        JSON.stringify(existing.desktopEnvelope ?? null) ===
          JSON.stringify(declaration.desktopEnvelope ?? null) &&
        JSON.stringify(existing.terminalPolicy ?? null) ===
          JSON.stringify(declaration.terminalPolicy ?? null) &&
        JSON.stringify(existing.browserProfile ?? null) ===
          JSON.stringify(declaration.browserProfile ?? null);
      if (!same) {
        return {
          valid: false,
          reason: `capability ${declaration.capabilityId} is already registered with a different declaration (contracts never silently drift)`,
        };
      }
      return { valid: true };
    }
    this.declarations.set(declaration.capabilityId, { ...declaration });
    return { valid: true };
  }

  async resolve(capabilityId: string): Promise<ComputerUseCapabilityDeclaration | null> {
    const declaration = this.declarations.get(capabilityId);
    return declaration === undefined ? null : { ...declaration };
  }

  async list(): Promise<readonly ComputerUseCapabilityDeclaration[]> {
    return [...this.declarations.values()].map((declaration) => ({ ...declaration }));
  }
}

/** The registry-backed in-memory composition helper (throws on drift). */
export async function registerComputerUseCapability(
  registry: ComputerUseCapabilityRegistry,
  declaration: ComputerUseCapabilityDeclaration,
): Promise<void> {
  const outcome = await registry.register(declaration);
  if (!outcome.valid) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: `computer-use capability registration refused: ${outcome.reason}`,
    });
  }
}
