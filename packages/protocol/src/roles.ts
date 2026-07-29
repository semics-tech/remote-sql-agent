/** Dashboard RBAC (§6.5). Enforced server-side on every route; the SPA hides
 * what it cannot use but is never the enforcement point. */

export const ROLES = ['Viewer', 'Operator', 'Editor', 'Admin'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'instance.read',
  'job.read',
  'history.read',
  'version.read',
  'job.toggle',
  'job.run',
  'schedule.write',
  'job.write',
  'operator.write',
  'command.approve',
  'worker.admin',
  'user.admin',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = ['instance.read', 'job.read', 'history.read', 'version.read'];
const OPERATOR: readonly Permission[] = [...VIEWER, 'job.toggle', 'job.run'];
const EDITOR: readonly Permission[] = [...OPERATOR, 'schedule.write', 'job.write'];
const ADMIN: readonly Permission[] = [
  ...EDITOR,
  'operator.write',
  'command.approve',
  'worker.admin',
  'user.admin',
  'audit.read',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  Viewer: VIEWER,
  Operator: OPERATOR,
  Editor: EDITOR,
  Admin: ADMIN,
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
