/**
 * Public contract barrel of the `tools` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/tools/` is private to
 * this module.
 *
 * Contracts are introduced by the Work Order that owns this module's scope;
 * this barrel currently carries only the module identity.
 */
import type { ModuleDescriptor } from "../../shared/module";

export const moduleDescriptor: ModuleDescriptor = { id: "tools" };
