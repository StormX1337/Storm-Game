import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const cuidLikeId = z.string().min(1).max(64);

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(64).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const idParamSchema = z.object({ id: cuidLikeId });

/**
 * Passwords: length beats composition rules, but we still block the obvious
 * cases. The real defence is Argon2id + rate limiting + breach-agnostic length.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(256, 'Password must be at most 256 characters')
  .refine((v) => !/^\s+$/.test(v), 'Password cannot be only whitespace');

export const emailSchema = z.string().email().max(255).toLowerCase().trim();

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, numbers, dots, dashes and underscores are allowed');

/** Relative paths inside a server's data directory. */
export const serverPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes('\0'), 'Path may not contain null bytes');
