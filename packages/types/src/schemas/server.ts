import { z } from 'zod';
import { cuidLikeId, serverPathSchema } from './common.js';

export const serverLimitsSchema = z.object({
  cpuLimit: z.number().int().min(0).max(6400),
  memoryLimit: z.number().int().min(64).max(1024 * 1024),
  diskLimit: z.number().int().min(128).max(10 * 1024 * 1024),
  swapLimit: z.number().int().min(-1).max(1024 * 1024).default(0),
  ioWeight: z.number().int().min(10).max(1000).default(500),
  networkLimitMbps: z.number().int().min(0).max(100000).default(0),
  pidsLimit: z.number().int().min(16).max(4096).default(512),
  oomKill: z.boolean().default(true),
});

export const createServerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).optional(),
  ownerId: cuidLikeId.optional(),
  nodeId: cuidLikeId,
  templateId: cuidLikeId,
  allocationId: cuidLikeId.optional(),
  additionalAllocationIds: z.array(cuidLikeId).max(16).default([]),
  dockerImage: z.string().trim().min(1).max(255).optional(),
  startupCommand: z.string().trim().min(1).max(4000).optional(),
  environment: z.record(z.string().max(8192)).default({}),
  limits: serverLimitsSchema,
  skipInstall: z.boolean().default(false),
  startOnCompletion: z.boolean().default(false),
});
export type CreateServerInput = z.infer<typeof createServerSchema>;

export const updateServerSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  ownerId: cuidLikeId.optional(),
  limits: serverLimitsSchema.partial().optional(),
});

export const updateStartupSchema = z.object({
  dockerImage: z.string().trim().min(1).max(255).optional(),
  startupCommand: z.string().trim().min(1).max(4000).optional(),
  templateId: cuidLikeId.optional(),
});

export const updateVariablesSchema = z.object({
  variables: z.record(z.string().max(8192)),
});

export const powerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'kill']),
});

export const consoleCommandSchema = z.object({
  command: z.string().min(1).max(4000),
});

export const reinstallSchema = z.object({
  /** Wipe the data directory before reinstalling. */
  wipe: z.boolean().default(false),
});

export const fileListQuerySchema = z.object({
  path: serverPathSchema.default('/'),
});

export const fileWriteSchema = z.object({
  path: serverPathSchema,
  content: z.string().max(8 * 1024 * 1024),
});

export const fileRenameSchema = z.object({
  from: serverPathSchema,
  to: serverPathSchema,
});

export const fileCopySchema = z.object({
  path: serverPathSchema,
  destination: serverPathSchema.optional(),
});

export const fileDeleteSchema = z.object({
  paths: z.array(serverPathSchema).min(1).max(500),
});

export const fileCreateDirectorySchema = z.object({
  path: serverPathSchema,
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !v.includes('/') && v !== '.' && v !== '..', 'Invalid name'),
});

export const fileCompressSchema = z.object({
  path: serverPathSchema,
  files: z.array(z.string().min(1).max(255)).min(1).max(1000),
  archiveName: z.string().min(1).max(255).optional(),
});

export const fileDecompressSchema = z.object({
  path: serverPathSchema,
  file: z.string().min(1).max(255),
});

export const fileChmodSchema = z.object({
  path: serverPathSchema,
  mode: z.string().regex(/^[0-7]{3,4}$/, 'Mode must be octal, e.g. 644'),
});

export const fileSearchSchema = z.object({
  path: serverPathSchema.default('/'),
  query: z.string().min(1).max(200),
});
