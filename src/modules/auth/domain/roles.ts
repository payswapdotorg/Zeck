/**
 * Application-scoped roles and permissions (auth module domain).
 *
 * Roles are the membership authorization vocabulary. Permissions are
 * fine-grained capability names used by guards; a role is a fixed permission
 * set (no user-editable roles — that would be a second authority).
 */

export const APPLICATION_ROLES = ["owner", "admin", "member"] as const;
export type ApplicationRole = (typeof APPLICATION_ROLES)[number];

export const PERMISSIONS = [
  "applications:read",
  "applications:write",
  "environments:read",
  "environments:write",
  "memberships:read",
  "memberships:write",
  "ownership:transfer",
  "tenant:write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Fixed role → permission mapping. Tenant-scope memberships (`applicationId`
 * is null, role `owner`) additionally carry `tenant:write` — see
 * `tenantScopePermissions`.
 */
const ROLE_PERMISSIONS: Readonly<Record<ApplicationRole, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: [
    "applications:read",
    "applications:write",
    "environments:read",
    "environments:write",
    "memberships:read",
    "memberships:write",
  ],
  member: ["applications:read", "environments:read", "memberships:read"],
};

/** Permissions granted by an application-scoped membership role. */
export function rolePermissions(role: ApplicationRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: ApplicationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Permissions granted inside a whole tenant by a tenant-scope membership.
 * Only `owner` may hold tenant scope (`memberships_scope_shape` CHECK), and
 * tenant scope implies every application-scoped permission inside that tenant
 * plus the tenant-level `tenant:write` (create applications, rename tenant).
 */
export function tenantScopePermissions(role: ApplicationRole): readonly Permission[] | null {
  if (role !== "owner") {
    return null;
  }
  return PERMISSIONS;
}

/** Roles that may be assigned by a holder of `memberships:write`. */
export const ASSIGNABLE_ROLES: readonly ApplicationRole[] = ["owner", "admin", "member"];
