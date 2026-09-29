import { UserRole } from './enums';

/**
 * Role-based access control. Permissions are checked on the server for every
 * admin route; the web app reads the same table only to hide controls a user
 * could not use anyway.
 */
export const Permission = {
  ADMIN_ACCESS: 'admin:access',
  USERS_READ: 'users:read',
  USERS_MANAGE: 'users:manage',
  USERS_ROLES: 'users:roles',
  EVENTS_READ: 'events:read',
  EVENTS_MANAGE: 'events:manage',
  MARKETS_MANAGE: 'markets:manage',
  BETS_READ: 'bets:read',
  BETS_SETTLE: 'bets:settle',
  TRANSACTIONS_READ: 'transactions:read',
  AUDIT_READ: 'audit:read',
  PROVIDERS_READ: 'providers:read',
  SYSTEM_READ: 'system:read',
  CASINO_READ: 'casino:read',
  CASINO_MANAGE: 'casino:manage',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const ALL = Object.values(Permission);

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  [UserRole.USER]: [],
  [UserRole.SUPPORT]: [
    Permission.ADMIN_ACCESS,
    Permission.USERS_READ,
    Permission.EVENTS_READ,
    Permission.BETS_READ,
    Permission.TRANSACTIONS_READ,
    Permission.CASINO_READ,
  ],
  [UserRole.TRADER]: [
    Permission.ADMIN_ACCESS,
    Permission.EVENTS_READ,
    Permission.EVENTS_MANAGE,
    Permission.MARKETS_MANAGE,
    Permission.BETS_READ,
    Permission.BETS_SETTLE,
    Permission.PROVIDERS_READ,
    Permission.SYSTEM_READ,
    Permission.CASINO_READ,
    Permission.CASINO_MANAGE,
  ],
  [UserRole.ADMIN]: ALL,
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isStaff(role: UserRole): boolean {
  return hasPermission(role, Permission.ADMIN_ACCESS);
}
