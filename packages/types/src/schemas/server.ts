import { z } from 'zod';
import { cuidLikeId, serverPathSchema } from './common.js';

export const serverLimitsSchema = z.object({
  cpuLimit: z.number().int().min(0).max(6400),
  memoryLimit: z
    .number()
    .int()
    .min(64)
    .max(1024 * 1024),
  diskLimit: z
    .number()
    .int()
    .min(128)
    .max(10 * 1024 * 1024),
  swapLimit: z
    .number()
    .int()
    .min(-1)
    .max(1024 * 1024)
    .default(0),
  ioWeight: z.number().int().min(10).max(1000).default(500),
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

/**
 * Another server like this one.
 *
 * Everything that decides what the server *is* — its template, image, startup
 * line, variables and limits — comes from the one being copied, so the only
 * things asked for are the ones that cannot be shared: a name, and where it
 * goes. A host setting up the fourth server for the same customer should not
 * be filling in the same eleven fields a fourth time.
 */
export const cloneServerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).optional(),
  /** Defaults to the source's node. */
  nodeId: cuidLikeId.optional(),
  allocationId: cuidLikeId.optional(),
  /** Admins only, as everywhere else. Defaults to the source's owner. */
  ownerId: cuidLikeId.optional(),
  startOnCompletion: z.boolean().default(false),
});
export type CloneServerInput = z.infer<typeof cloneServerSchema>;

export const updateServerSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  /** Bring the server back up on its own after it crashes. */
  autoRestart: z.boolean().optional(),
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

/**
 * A Minecraft username, as Mojang defines one: three to sixteen characters of
 * letters, digits and underscores.
 *
 * This is a security boundary, not a nicety. Every player action is carried
 * out as a console command, and the agent submits a command by writing it to
 * the process followed by a newline — so a "name" containing one would be a
 * second command. Holding `servers.players` is meant to allow opping and
 * banning, not arbitrary console access, and this regex is what keeps the
 * difference real.
 */
export const minecraftUsername = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,16}$/, 'Minecraft names are 3-16 letters, digits or underscores');

/** Free text that travels in a command, so the same newline rule applies. */
const commandSafeText = z
  .string()
  .trim()
  .max(120)
  .regex(/^[^\r\n]*$/, 'This cannot contain a line break');

export const playerActionSchema = z.object({
  name: minecraftUsername,
  reason: commandSafeText.optional(),
});

export const banIpSchema = z.object({
  ip: z.string().trim().ip(),
  reason: commandSafeText.optional(),
});

export const whitelistToggleSchema = z.object({ enabled: z.boolean() });

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
