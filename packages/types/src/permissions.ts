import { RoleName } from './enums.js';

/**
 * Granular permission keys. Every privileged API route resolves to one of these;
 * they are seeded into the `permissions` table and attached to roles.
 *
 * Naming: `<resource>.<action>`. Server-scoped permissions (the `servers.*` and
 * `files.*` families) are additionally checked against server ownership or an
 * explicit sub-user grant, so holding `servers.console` does not grant console
 * access to *every* server unless the role also holds `admin.servers`.
 */
export const Permission = {
  // Server lifecycle
  SERVERS_VIEW: 'servers.view',
  SERVERS_CREATE: 'servers.create',
  SERVERS_UPDATE: 'servers.update',
  SERVERS_DELETE: 'servers.delete',
  SERVERS_START: 'servers.start',
  SERVERS_STOP: 'servers.stop',
  SERVERS_RESTART: 'servers.restart',
  SERVERS_KILL: 'servers.kill',
  SERVERS_REINSTALL: 'servers.reinstall',
  SERVERS_SUSPEND: 'servers.suspend',
  SERVERS_CONSOLE: 'servers.console',
  SERVERS_COMMAND: 'servers.command',
  SERVERS_FILES: 'servers.files',
  SERVERS_FILES_WRITE: 'servers.files.write',
  SERVERS_BACKUPS: 'servers.backups',
  SERVERS_BACKUPS_CREATE: 'servers.backups.create',
  SERVERS_BACKUPS_RESTORE: 'servers.backups.restore',
  SERVERS_BACKUPS_DELETE: 'servers.backups.delete',
  SERVERS_DATABASES: 'servers.databases',
  SERVERS_DATABASES_CREATE: 'servers.databases.create',
  SERVERS_DATABASES_DELETE: 'servers.databases.delete',
  SERVERS_SCHEDULES: 'servers.schedules',
  SERVERS_SCHEDULES_MANAGE: 'servers.schedules.manage',
  SERVERS_ALLOCATIONS: 'servers.allocations',
  SERVERS_STARTUP: 'servers.startup',
  SERVERS_VARIABLES: 'servers.variables',
  SERVERS_SFTP: 'servers.sftp',
  SERVERS_SUBUSERS: 'servers.subusers',
  SERVERS_ACTIVITY: 'servers.activity',

  // Administration
  USERS_MANAGE: 'users.manage',
  NODES_MANAGE: 'nodes.manage',
  TEMPLATES_MANAGE: 'templates.manage',
  ALLOCATIONS_MANAGE: 'allocations.manage',
  DATABASE_HOSTS_MANAGE: 'databasehosts.manage',
  BACKUP_STORAGE_MANAGE: 'backupstorage.manage',
  WEBHOOKS_MANAGE: 'webhooks.manage',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_VIEW: 'audit.view',

  // Cross-tenant escalations: these turn the server-scoped permissions above
  // into panel-wide capabilities.
  ADMIN_SERVERS: 'admin.servers',
  ADMIN_USERS: 'admin.users',
  ADMIN_DASHBOARD: 'admin.dashboard',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: Permission[] = Object.values(Permission);

export interface PermissionDefinition {
  key: Permission;
  category: string;
  description: string;
}

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { key: Permission.SERVERS_VIEW, category: 'server', description: 'View servers and their details' },
  { key: Permission.SERVERS_CREATE, category: 'server', description: 'Create new servers' },
  { key: Permission.SERVERS_UPDATE, category: 'server', description: 'Update server details and limits' },
  { key: Permission.SERVERS_DELETE, category: 'server', description: 'Permanently delete servers' },
  { key: Permission.SERVERS_START, category: 'power', description: 'Start a server' },
  { key: Permission.SERVERS_STOP, category: 'power', description: 'Stop a server' },
  { key: Permission.SERVERS_RESTART, category: 'power', description: 'Restart a server' },
  { key: Permission.SERVERS_KILL, category: 'power', description: 'Forcefully kill a server process' },
  { key: Permission.SERVERS_REINSTALL, category: 'server', description: 'Reinstall a server from its template' },
  { key: Permission.SERVERS_SUSPEND, category: 'server', description: 'Suspend or unsuspend a server' },
  { key: Permission.SERVERS_CONSOLE, category: 'console', description: 'Read live console output' },
  { key: Permission.SERVERS_COMMAND, category: 'console', description: 'Send commands to the console' },
  { key: Permission.SERVERS_FILES, category: 'file', description: 'Browse and download server files' },
  { key: Permission.SERVERS_FILES_WRITE, category: 'file', description: 'Create, edit, upload and delete files' },
  { key: Permission.SERVERS_BACKUPS, category: 'backup', description: 'View backups' },
  { key: Permission.SERVERS_BACKUPS_CREATE, category: 'backup', description: 'Create backups' },
  { key: Permission.SERVERS_BACKUPS_RESTORE, category: 'backup', description: 'Restore backups' },
  { key: Permission.SERVERS_BACKUPS_DELETE, category: 'backup', description: 'Delete backups' },
  { key: Permission.SERVERS_DATABASES, category: 'database', description: 'View server databases' },
  { key: Permission.SERVERS_DATABASES_CREATE, category: 'database', description: 'Create server databases' },
  { key: Permission.SERVERS_DATABASES_DELETE, category: 'database', description: 'Delete server databases' },
  { key: Permission.SERVERS_SCHEDULES, category: 'schedule', description: 'View schedules' },
  { key: Permission.SERVERS_SCHEDULES_MANAGE, category: 'schedule', description: 'Create, edit and run schedules' },
  { key: Permission.SERVERS_ALLOCATIONS, category: 'network', description: 'Manage server network allocations' },
  { key: Permission.SERVERS_STARTUP, category: 'server', description: 'Change the startup command and image' },
  { key: Permission.SERVERS_VARIABLES, category: 'server', description: 'Change server environment variables' },
  { key: Permission.SERVERS_SFTP, category: 'file', description: 'View SFTP credentials' },
  { key: Permission.SERVERS_SUBUSERS, category: 'server', description: 'Manage server sub-users' },
  { key: Permission.SERVERS_ACTIVITY, category: 'server', description: 'View server activity log' },
  { key: Permission.USERS_MANAGE, category: 'admin', description: 'Create, edit and delete users' },
  { key: Permission.NODES_MANAGE, category: 'admin', description: 'Manage nodes and node tokens' },
  { key: Permission.TEMPLATES_MANAGE, category: 'admin', description: 'Manage game templates' },
  { key: Permission.ALLOCATIONS_MANAGE, category: 'admin', description: 'Manage node IP allocations' },
  { key: Permission.DATABASE_HOSTS_MANAGE, category: 'admin', description: 'Manage database hosts' },
  { key: Permission.BACKUP_STORAGE_MANAGE, category: 'admin', description: 'Manage backup storage targets' },
  { key: Permission.WEBHOOKS_MANAGE, category: 'admin', description: 'Manage outbound webhooks' },
  { key: Permission.SETTINGS_MANAGE, category: 'admin', description: 'Change panel settings' },
  { key: Permission.AUDIT_VIEW, category: 'admin', description: 'Read the audit log' },
  { key: Permission.ADMIN_SERVERS, category: 'admin', description: 'Act on every server in the panel' },
  { key: Permission.ADMIN_USERS, category: 'admin', description: 'Act on every user in the panel' },
  { key: Permission.ADMIN_DASHBOARD, category: 'admin', description: 'Access the administration area' },
];

/**
 * Permissions a customer holds on servers they own.
 *
 * `servers.create` is included: customers provision their own servers, and
 * over-provisioning is prevented by their account limits and node capacity,
 * not by withholding the permission.
 */
export const CUSTOMER_PERMISSIONS: Permission[] = [
  Permission.SERVERS_VIEW,
  Permission.SERVERS_CREATE,
  Permission.SERVERS_START,
  Permission.SERVERS_STOP,
  Permission.SERVERS_RESTART,
  Permission.SERVERS_KILL,
  Permission.SERVERS_REINSTALL,
  Permission.SERVERS_CONSOLE,
  Permission.SERVERS_COMMAND,
  Permission.SERVERS_FILES,
  Permission.SERVERS_FILES_WRITE,
  Permission.SERVERS_BACKUPS,
  Permission.SERVERS_BACKUPS_CREATE,
  Permission.SERVERS_BACKUPS_RESTORE,
  Permission.SERVERS_BACKUPS_DELETE,
  Permission.SERVERS_DATABASES,
  Permission.SERVERS_DATABASES_CREATE,
  Permission.SERVERS_DATABASES_DELETE,
  Permission.SERVERS_SCHEDULES,
  Permission.SERVERS_SCHEDULES_MANAGE,
  Permission.SERVERS_ALLOCATIONS,
  Permission.SERVERS_STARTUP,
  Permission.SERVERS_VARIABLES,
  Permission.SERVERS_SFTP,
  Permission.SERVERS_SUBUSERS,
  Permission.SERVERS_ACTIVITY,
];

const SUPPORT_PERMISSIONS: Permission[] = [
  // Support troubleshoots; it does not provision or destroy.
  ...CUSTOMER_PERMISSIONS.filter(
    (p) =>
      p !== Permission.SERVERS_CREATE &&
      p !== Permission.SERVERS_BACKUPS_DELETE &&
      p !== Permission.SERVERS_DATABASES_DELETE &&
      p !== Permission.SERVERS_SUBUSERS,
  ),
  Permission.ADMIN_DASHBOARD,
  Permission.ADMIN_SERVERS,
  Permission.AUDIT_VIEW,
];

const STAFF_PERMISSIONS: Permission[] = [
  ...CUSTOMER_PERMISSIONS,
  Permission.SERVERS_UPDATE,
  Permission.SERVERS_SUSPEND,
  Permission.ADMIN_DASHBOARD,
  Permission.ADMIN_SERVERS,
  Permission.ADMIN_USERS,
  Permission.USERS_MANAGE,
  Permission.TEMPLATES_MANAGE,
  Permission.ALLOCATIONS_MANAGE,
  Permission.AUDIT_VIEW,
];

/** Default permission grants per built-in role. OWNER implicitly holds everything. */
export const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  OWNER: ALL_PERMISSIONS,
  ADMIN: ALL_PERMISSIONS,
  STAFF: STAFF_PERMISSIONS,
  SUPPORT: SUPPORT_PERMISSIONS,
  CUSTOMER: CUSTOMER_PERMISSIONS,
};

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}
