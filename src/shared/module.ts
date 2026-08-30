/**
 * Canonical module identity for the modular monolith.
 *
 * The module list is frozen by `spec/architecture.md` §6 (architecture v1.0).
 * Every module lives under `src/modules/<id>/` and exposes exactly one
 * `public.ts` barrel. That barrel is the only supported cross-module import
 * surface (`IMPLEMENTATION.md` §2–§3, `spec/contracts.md` "Public module rule").
 *
 * This list intentionally duplicates the architecture table so that the code
 * base carries its own typed identity; `tests/unit/modules.test.ts` and
 * `tests/architecture/module-skeleton.test.ts` keep both in sync.
 */
export const ARCHITECTURE_MODULE_IDS = [
  "auth",
  "applications",
  "connections",
  "policies",
  "budgets",
  "capabilities",
  "executions",
  "planning",
  "models",
  "tools",
  "agents",
  "context",
  "sandbox",
  "verification",
  "learning",
  "artifacts",
  "webhooks",
  "audit",
] as const;

export type ArchitectureModuleId = (typeof ARCHITECTURE_MODULE_IDS)[number];

/** Stable identity exported by every module's `public.ts` barrel. */
export interface ModuleDescriptor {
  /** Canonical architecture module identity (`spec/architecture.md` §6). */
  readonly id: ArchitectureModuleId;
}
