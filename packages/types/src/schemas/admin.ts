import { z } from 'zod';
import { cuidLikeId, emailSchema, passwordSchema, usernameSchema } from './common.js';
import { ALL_PERMISSIONS } from '../permissions.js';

const permissionEnum = z.enum(ALL_PERMISSIONS as [string, ...string[]]);

/* ------------------------------------------------------------------ users -- */

export const userLimitsSchema = z.object({
  serverLimit: z.number().int().min(0).max(10000),
  cpuLimit: z.number().int().min(0).max(100000),
  memoryLimit: z.number().int().min(0).max(10 * 1024 * 1024),
  diskLimit: z.number().int().min(0).max(100 * 1024 * 1024),
  backupLimit: z.number().int().min(0).max(10000),
  databaseLimit: z.number().int().min(0).max(10000),
  allocationLimit: z.number().int().min(0).max(10000),
});

export const createUserSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  firstName: z.string().trim().max(64).optional(),
  lastName: z.string().trim().max(64).optional(),
  password: passwordSchema.optional(),
  role: z.enum(['OWNER', 'ADMIN', 'STAFF', 'SUPPORT', 'CUSTOMER']),
  emailVerified: z.boolean().default(false),
  limits: userLimitsSchema.partial().optional(),
  extraPermissions: z.array(permissionEnum).max(100).default([]),
});

export const updateUserSchema = createUserSchema
  .partial()
  .omit({ password: true })
  .extend({ password: passwordSchema.optional() });

/* ------------------------------------------------------------------ nodes -- */

export const createNodeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).optional(),
  location: z.string().trim().min(1).max(100),
  region: z.string().trim().max(100).optional(),
  hostname: z.string().trim().min(1).max(255),
  ip: z.string().trim().min(3).max(45),
  publicIp: z.string().trim().max(45).optional(),
  scheme: z.enum(['http', 'https']).default('https'),
  agentPort: z.number().int().min(1).max(65535).default(8081),
  sftpPort: z.number().int().min(1).max(65535).default(2022),
  cpuCores: z.number().int().min(1).max(4096).default(1),
  memoryTotal: z.number().int().min(256).default(1024),
  diskTotal: z.number().int().min(1024).default(10240),
  memoryOvercommit: z.number().int().min(0).max(500).default(0),
  diskOvercommit: z.number().int().min(0).max(500).default(0),
  dataDirectory: z.string().trim().min(1).max(255).default('/var/lib/storm/servers'),
  backupDirectory: z.string().trim().min(1).max(255).default('/var/lib/storm/backups'),
  maintenanceMode: z.boolean().default(false),
  isPublic: z.boolean().default(true),
});

export const updateNodeSchema = createNodeSchema.partial();

/* ------------------------------------------------------------ allocations -- */

export const createAllocationSchema = z.object({
  nodeId: cuidLikeId,
  ip: z.string().trim().min(3).max(45),
  alias: z.string().trim().max(100).optional(),
  protocol: z.enum(['TCP', 'UDP']).default('TCP'),
  /** Either a list of ports or an inclusive range. */
  ports: z.array(z.number().int().min(1).max(65535)).max(2000).optional(),
  portRangeStart: z.number().int().min(1).max(65535).optional(),
  portRangeEnd: z.number().int().min(1).max(65535).optional(),
});

export const assignAllocationSchema = z.object({
  allocationId: cuidLikeId,
  primary: z.boolean().default(false),
});

/* -------------------------------------------------------------- templates -- */

export const templateVariableSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  envVariable: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Must be UPPER_SNAKE_CASE'),
  defaultValue: z.string().max(8192).default(''),
  userViewable: z.boolean().default(true),
  userEditable: z.boolean().default(true),
  /** Pipe separated rules, e.g. `required|string|max:64`. */
  rules: z.string().max(500).default('string'),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and dashes only'),
  game: z.string().trim().min(1).max(100),
  category: z.string().trim().min(1).max(100).default('Other'),
  description: z.string().trim().max(4000).default(''),
  author: z.string().trim().max(255).default('Storm Panel'),
  dockerImages: z.record(z.string().min(1).max(255)).refine((v) => Object.keys(v).length > 0, {
    message: 'At least one docker image is required',
  }),
  defaultImage: z.string().trim().min(1).max(255),
  startupCommand: z.string().trim().min(1).max(4000),
  stopCommand: z.string().trim().min(1).max(255).default('^C'),
  installScript: z.string().max(64 * 1024).default('#!/bin/bash\n'),
  installContainer: z.string().trim().min(1).max(255).default('debian:bookworm-slim'),
  installEntrypoint: z.string().trim().min(1).max(100).default('bash'),
  startupDetection: z.string().max(500).default(''),
  crashDetection: z.string().max(500).default(''),
  configFiles: z.record(z.unknown()).default({}),
  logConfig: z.record(z.unknown()).default({}),
  defaultPorts: z.array(z.number().int().min(1).max(65535)).max(32).default([]),
  supportedVersions: z.array(z.string().max(64)).max(200).default([]),
  variables: z.array(templateVariableSchema).max(100).default([]),
  isActive: z.boolean().default(true),
});

export const updateTemplateSchema = createTemplateSchema.partial();

/* ---------------------------------------------------------------- backups -- */

export const createBackupSchema = z.object({
  name: z.string().trim().max(100).optional(),
  ignoredFiles: z.array(z.string().max(255)).max(200).default([]),
  isLocked: z.boolean().default(false),
});

export const createBackupStorageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  driver: z.enum(['LOCAL', 'S3', 'R2', 'MINIO']),
  isDefault: z.boolean().default(false),
  bucket: z.string().trim().max(255).optional(),
  region: z.string().trim().max(100).optional(),
  endpoint: z.string().trim().max(500).optional(),
  accessKey: z.string().trim().max(255).optional(),
  secretKey: z.string().trim().max(500).optional(),
  pathPrefix: z.string().trim().max(255).default('backups'),
  forcePathStyle: z.boolean().default(true),
  retentionDays: z.number().int().min(0).max(3650).default(0),
  isActive: z.boolean().default(true),
});

export const updateBackupStorageSchema = createBackupStorageSchema.partial();

/* -------------------------------------------------------------- databases -- */

export const createDatabaseHostSchema = z.object({
  name: z.string().trim().min(1).max(100),
  engine: z.enum(['POSTGRES', 'MYSQL']),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(500),
  /** Host advertised to customers; falls back to `host`. */
  publicHost: z.string().trim().max(255).optional(),
  maxDatabases: z.number().int().min(0).max(100000).default(0),
  nodeId: cuidLikeId.nullable().optional(),
  isActive: z.boolean().default(true),
});

export const updateDatabaseHostSchema = createDatabaseHostSchema
  .partial()
  .extend({ password: z.string().min(1).max(500).optional() });

export const createServerDatabaseSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers and underscores only'),
  hostId: cuidLikeId.optional(),
  remoteAccess: z.string().trim().max(100).default('%'),
});

/* -------------------------------------------------------------- schedules -- */

export const scheduleTaskSchema = z.object({
  action: z.enum([
    'POWER_START',
    'POWER_STOP',
    'POWER_RESTART',
    'POWER_KILL',
    'COMMAND',
    'BACKUP',
    'NOTIFY',
  ]),
  payload: z.string().max(4000).default(''),
  timeOffsetSec: z.number().int().min(0).max(86400).default(0),
  continueOnFailure: z.boolean().default(false),
});

export const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  cronMinute: z.string().trim().min(1).max(64).default('0'),
  cronHour: z.string().trim().min(1).max(64).default('*'),
  cronDayOfMonth: z.string().trim().min(1).max(64).default('*'),
  cronMonth: z.string().trim().min(1).max(64).default('*'),
  cronDayOfWeek: z.string().trim().min(1).max(64).default('*'),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  isActive: z.boolean().default(true),
  onlyWhenOnline: z.boolean().default(false),
  tasks: z.array(scheduleTaskSchema).min(1).max(20),
});

export const updateScheduleSchema = createScheduleSchema.partial();

/* --------------------------------------------------------------- webhooks -- */

export const createWebhookSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().url().max(2000),
  events: z.array(z.string().max(64)).min(1).max(50),
  isActive: z.boolean().default(true),
});

export const updateWebhookSchema = createWebhookSchema.partial();

/* --------------------------------------------------------------- settings -- */

export const updateSettingsSchema = z.object({
  panelName: z.string().trim().min(1).max(100).optional(),
  panelUrl: z.string().url().max(500).optional(),
  supportEmail: z.string().email().max(255).optional(),
  registrationEnabled: z.boolean().optional(),
  requireEmailVerification: z.boolean().optional(),
  defaultServerLimit: z.number().int().min(0).max(10000).optional(),
  defaultMemoryLimit: z.number().int().min(0).max(10 * 1024 * 1024).optional(),
  defaultDiskLimit: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
  defaultBackupLimit: z.number().int().min(0).max(1000).optional(),
  defaultDatabaseLimit: z.number().int().min(0).max(1000).optional(),
  defaultAllocationLimit: z.number().int().min(0).max(1000).optional(),
  backupRetentionDays: z.number().int().min(0).max(3650).optional(),
  maintenanceMode: z.boolean().optional(),
  maintenanceMessage: z.string().max(1000).optional(),
});

/* -------------------------------------------------------------- audit log -- */

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().max(100).optional(),
  actorId: cuidLikeId.optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().max(200).optional(),
});
