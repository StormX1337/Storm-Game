import { bigIntToNumber } from '@storm/database';
import type {
  ActivityLogView,
  AllocationSummary,
  AuditLogView,
  BackupSummary,
  NotificationView,
  ScheduleSummary,
  ServerDetail,
  ServerSummary,
  SessionSummary,
  TemplateDetail,
  TemplateSummary,
  UserDetail,
  UserSummary,
  NodeSummary,
  NodeDetail,
  ServerVariableView,
  RoleName,
  Permission,
} from '@storm/types';

/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma include shapes vary per query. */
type Row = Record<string, any>;

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
const isoRequired = (value: Date): string => value.toISOString();

export function toUserSummary(user: Row): UserSummary {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    role: (user.role?.name ?? 'CUSTOMER') as RoleName,
    avatarUrl: user.avatarUrl ?? null,
    emailVerified: Boolean(user.emailVerifiedAt),
    suspended: Boolean(user.suspendedAt),
    twoFactorEnabled: Boolean(user.twoFactor?.enabled),
    createdAt: isoRequired(user.createdAt),
    lastLoginAt: iso(user.lastLoginAt),
  };
}

export function toUserDetail(user: Row, serverCount = 0): UserDetail {
  const rolePermissions: string[] = (user.role?.permissions ?? []).map((p: Row) => p.key);
  const permissions = new Set<string>([...rolePermissions, ...(user.extraPermissions ?? [])]);
  for (const denied of user.deniedPermissions ?? []) permissions.delete(denied);

  return {
    ...toUserSummary(user),
    permissions: [...permissions] as Permission[],
    limits: {
      serverLimit: user.serverLimit,
      cpuLimit: user.cpuLimit,
      memoryLimit: user.memoryLimit,
      diskLimit: user.diskLimit,
      backupLimit: user.backupLimit,
      databaseLimit: user.databaseLimit,
      allocationLimit: user.allocationLimit,
    },
    serverCount,
    updatedAt: isoRequired(user.updatedAt),
  };
}

export function toSessionSummary(session: Row, currentSessionId: string | null): SessionSummary {
  return {
    id: session.id,
    ip: session.ip ?? null,
    userAgent: session.userAgent ?? null,
    deviceLabel: session.deviceLabel ?? null,
    current: session.id === currentSessionId,
    createdAt: isoRequired(session.createdAt),
    lastUsedAt: isoRequired(session.lastUsedAt),
    expiresAt: isoRequired(session.expiresAt),
  };
}

export function toAllocation(allocation: Row): AllocationSummary {
  return {
    id: allocation.id,
    ip: allocation.ip,
    port: allocation.port,
    protocol: allocation.protocol,
    alias: allocation.alias ?? null,
    isPrimary: Boolean(allocation.isPrimary),
    serverId: allocation.serverId ?? null,
    nodeId: allocation.nodeId,
  };
}

export function toServerSummary(server: Row): ServerSummary {
  const primary = (server.allocations ?? []).find((a: Row) => a.isPrimary) ?? null;
  return {
    id: server.id,
    uuid: server.uuid,
    shortId: server.shortId,
    name: server.name,
    description: server.description ?? null,
    status: server.status,
    suspended: Boolean(server.suspendedAt),
    installed: Boolean(server.installedAt),
    autoRestart: Boolean(server.autoRestart),
    node: server.node
      ? {
          id: server.node.id,
          name: server.node.name,
          location: server.node.location,
          status: server.node.status,
        }
      : { id: server.nodeId, name: 'Unknown', location: '', status: 'OFFLINE' },
    template: server.template
      ? {
          id: server.template.id,
          name: server.template.name,
          slug: server.template.slug,
          game: server.template.game,
          category: server.template.category,
          dockerImages: (server.template.dockerImages ?? {}) as Record<string, string>,
          // What the panel may offer for this server beyond the standard tabs.
          // The template decides, so a custom Minecraft template gets the
          // plugin browser and a renamed one does not lose it.
          features: server.template.features ?? [],
        }
      : null,
    owner: server.owner
      ? { id: server.owner.id, username: server.owner.username, email: server.owner.email }
      : null,
    primaryAllocation: primary ? toAllocation(primary) : null,
    limits: {
      cpuLimit: server.cpuLimit,
      memoryLimit: server.memoryLimit,
      diskLimit: server.diskLimit,
      swapLimit: server.swapLimit,
      ioWeight: server.ioWeight,
      pidsLimit: server.pidsLimit,
      oomKill: server.oomKill,
    },
    createdAt: isoRequired(server.createdAt),
  };
}

export function toServerVariables(server: Row): ServerVariableView[] {
  const templateVariables: Row[] = server.template?.variables ?? [];
  const values = new Map<string, string>(
    (server.variables ?? []).map((v: Row) => [v.key, v.value] as const),
  );

  const views: ServerVariableView[] = templateVariables.map((variable) => ({
    key: variable.envVariable,
    value: values.get(variable.envVariable) ?? variable.defaultValue,
    name: variable.name,
    description: variable.description,
    editable: variable.userEditable,
    viewable: variable.userViewable,
    rules: variable.rules,
    defaultValue: variable.defaultValue,
  }));

  // Values set on the server without a matching template variable (e.g. after a
  // template was edited) are still surfaced, read-only.
  for (const [key, value] of values) {
    if (!views.some((view) => view.key === key)) {
      views.push({
        key,
        value,
        name: key,
        description: 'Custom variable',
        editable: false,
        viewable: true,
        rules: 'string',
        defaultValue: '',
      });
    }
  }
  return views;
}

export function toServerDetail(
  server: Row,
  permissions: string[],
  sftp: { host: string; port: number; username: string } | null,
): ServerDetail {
  return {
    ...toServerSummary(server),
    dockerImage: server.dockerImage,
    startupCommand: server.startupCommand,
    allocations: (server.allocations ?? []).map(toAllocation),
    variables: toServerVariables(server),
    permissions: permissions as Permission[],
    sftp,
    installedAt: iso(server.installedAt),
    updatedAt: isoRequired(server.updatedAt),
  };
}

export function toNodeSummary(node: Row): NodeSummary {
  const servers: Row[] = node.servers ?? [];
  return {
    id: node.id,
    uuid: node.uuid,
    name: node.name,
    location: node.location,
    region: node.region ?? null,
    hostname: node.hostname,
    ip: node.ip,
    status: node.status,
    maintenanceMode: node.maintenanceMode,
    cpuCores: node.cpuCores,
    memoryTotal: node.memoryTotal,
    diskTotal: node.diskTotal,
    dockerVersion: node.dockerVersion ?? null,
    agentVersion: node.agentVersion ?? null,
    lastHeartbeatAt: iso(node.lastHeartbeatAt),
    serverCount: node._count?.servers ?? servers.length,
    allocationCount: node._count?.allocations ?? 0,
    allocatedMemory: servers.reduce((sum, s) => sum + (s.memoryLimit ?? 0), 0),
    allocatedDisk: servers.reduce((sum, s) => sum + (s.diskLimit ?? 0), 0),
  };
}

export function toNodeDetail(node: Row, liveStats: NodeDetail['liveStats']): NodeDetail {
  return {
    ...toNodeSummary(node),
    description: node.description ?? null,
    os: node.os ?? null,
    kernel: node.kernel ?? null,
    cpuModel: node.cpuModel ?? null,
    scheme: node.scheme,
    agentPort: node.agentPort,
    sftpPort: node.sftpPort,
    publicIp: node.publicIp ?? null,
    dataDirectory: node.dataDirectory,
    backupDirectory: node.backupDirectory,
    memoryOvercommit: node.memoryOvercommit,
    diskOvercommit: node.diskOvercommit,
    isPublic: node.isPublic,
    liveStats,
    createdAt: isoRequired(node.createdAt),
  };
}

export function toBackupSummary(backup: Row): BackupSummary {
  return {
    id: backup.id,
    uuid: backup.uuid,
    name: backup.name,
    status: backup.status,
    bytes: bigIntToNumber(backup.bytes),
    checksum: backup.checksum ?? null,
    isLocked: backup.isLocked,
    error: backup.error ?? null,
    createdAt: isoRequired(backup.createdAt),
    completedAt: iso(backup.completedAt),
  };
}

export function toScheduleSummary(schedule: Row): ScheduleSummary {
  return {
    id: schedule.id,
    name: schedule.name,
    cron: {
      minute: schedule.cronMinute,
      hour: schedule.cronHour,
      dayOfMonth: schedule.cronDayOfMonth,
      month: schedule.cronMonth,
      dayOfWeek: schedule.cronDayOfWeek,
    },
    timezone: schedule.timezone,
    isActive: schedule.isActive,
    onlyWhenOnline: schedule.onlyWhenOnline,
    lastRunAt: iso(schedule.lastRunAt),
    nextRunAt: iso(schedule.nextRunAt),
    tasks: (schedule.tasks ?? []).map((task: Row) => ({
      id: task.id,
      action: task.action,
      payload: task.payload,
      timeOffsetSec: task.timeOffsetSec,
      sequence: task.sequence,
      continueOnFailure: task.continueOnFailure,
      lastRunAt: iso(task.lastRunAt),
      lastError: task.lastError ?? null,
    })),
  };
}

export function toNotification(notification: Row): NotificationView {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    level: notification.level,
    link: notification.link ?? null,
    read: Boolean(notification.readAt),
    createdAt: isoRequired(notification.createdAt),
  };
}

export function toAuditLog(log: Row): AuditLogView {
  return {
    id: log.id,
    action: log.action,
    actor: log.actor
      ? { id: log.actor.id, username: log.actor.username, email: log.actor.email }
      : null,
    targetType: log.targetType ?? null,
    targetId: log.targetId ?? null,
    targetLabel: log.targetLabel ?? null,
    ip: log.ip ?? null,
    userAgent: log.userAgent ?? null,
    metadata: (log.metadata ?? {}) as Record<string, unknown>,
    createdAt: isoRequired(log.createdAt),
  };
}

export function toActivityLog(log: Row): ActivityLogView {
  return {
    id: log.id,
    event: log.event,
    user: log.user ? { id: log.user.id, username: log.user.username } : null,
    ip: log.ip ?? null,
    metadata: (log.metadata ?? {}) as Record<string, unknown>,
    createdAt: isoRequired(log.createdAt),
  };
}

export function toTemplateSummary(template: Row): TemplateSummary {
  return {
    id: template.id,
    uuid: template.uuid,
    name: template.name,
    slug: template.slug,
    game: template.game,
    category: template.category,
    description: template.description,
    author: template.author,
    defaultImage: template.defaultImage,
    dockerImages: (template.dockerImages ?? {}) as Record<string, string>,
    defaultPorts: template.defaultPorts ?? [],
    supportedVersions: template.supportedVersions ?? [],
    version: template.version,
    isActive: template.isActive,
    serverCount: template._count?.servers ?? 0,
    createdAt: isoRequired(template.createdAt),
  };
}

export function toTemplateDetail(template: Row): TemplateDetail {
  return {
    ...toTemplateSummary(template),
    startupCommand: template.startupCommand,
    stopCommand: template.stopCommand,
    installScript: template.installScript,
    installContainer: template.installContainer,
    installEntrypoint: template.installEntrypoint,
    startupDetection: template.startupDetection,
    crashDetection: template.crashDetection,
    configFiles: (template.configFiles ?? {}) as Record<string, unknown>,
    logConfig: (template.logConfig ?? {}) as Record<string, unknown>,
    variables: (template.variables ?? []).map((variable: Row) => ({
      id: variable.id,
      name: variable.name,
      description: variable.description,
      envVariable: variable.envVariable,
      defaultValue: variable.defaultValue,
      userViewable: variable.userViewable,
      userEditable: variable.userEditable,
      rules: variable.rules,
      sortOrder: variable.sortOrder,
    })),
    updatedAt: isoRequired(template.updatedAt),
  };
}
