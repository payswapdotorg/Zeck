/**
 * Unit: roles and permissions (auth domain, acceptance criterion 1).
 */

import { describe, expect, test } from "vitest";
import {
  APPLICATION_ROLES,
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  roleHasPermission,
  rolePermissions,
  tenantScopePermissions,
} from "../../src/modules/auth/public";

describe("role → permission mapping", () => {
  test("owner carries every permission", () => {
    expect(rolePermissions("owner")).toEqual(PERMISSIONS);
  });

  test("admin writes applications/environments/memberships but never transfers ownership or tenant authority", () => {
    for (const permission of rolePermissions("admin")) {
      expect(roleHasPermission("admin", permission)).toBe(true);
    }
    expect(roleHasPermission("admin", "ownership:transfer")).toBe(false);
    expect(roleHasPermission("admin", "tenant:write")).toBe(false);
  });

  test("member is read-only", () => {
    for (const permission of PERMISSIONS) {
      const expected = permission.endsWith(":read");
      expect(roleHasPermission("member", permission)).toBe(expected);
    }
  });

  test("tenant scope is owner-only and tenant-wide", () => {
    expect(tenantScopePermissions("owner")).toEqual(PERMISSIONS);
    expect(tenantScopePermissions("admin")).toBeNull();
    expect(tenantScopePermissions("member")).toBeNull();
  });

  test("vocabulary is closed", () => {
    expect(APPLICATION_ROLES).toEqual(["owner", "admin", "member"]);
    expect(ASSIGNABLE_ROLES).toEqual(["owner", "admin", "member"]);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
});
