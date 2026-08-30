/**
 * Public contract barrel of the `applications` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/applications/` is
 * private to this module.
 *
 * WORK-002 introduces tenant/application/environment ownership contracts
 * and the ownership services. Cross-module dependency: this module consumes
 * `auth`'s public barrel (Principal, ScopeResolver, TenantScope) — the only
 * cross-module import in the tree, through the supported surface.
 */

import type { ModuleDescriptor } from "../../shared/module";
import {
  type CreateApplicationCommand,
  type CreateEnvironmentCommand,
  type CreateTenantCommand,
  createOwnershipServices,
  type MembershipFacts,
  type OwnershipServices,
} from "./application/ownership-services";
import type { Application, Environment, EnvironmentKind, Tenant } from "./domain/ownership";
import type { ApplicationStore } from "./ports/application-store";
import type { IdempotencyPort } from "./ports/idempotency";

export const moduleDescriptor: ModuleDescriptor = { id: "applications" };

export { ENVIRONMENT_KINDS, isValidEnvironmentName, isValidSlug } from "./domain/ownership";
// Ownership contracts (acceptance criterion 1).
// Module ports (provider-neutral; implemented by adapters).
// Application services.
export type {
  Application,
  ApplicationStore,
  CreateApplicationCommand,
  CreateEnvironmentCommand,
  CreateTenantCommand,
  Environment,
  EnvironmentKind,
  IdempotencyPort,
  MembershipFacts,
  OwnershipServices,
  Tenant,
};
export { createOwnershipServices };
