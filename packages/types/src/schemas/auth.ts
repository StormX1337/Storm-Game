import { z } from 'zod';
import { emailSchema, passwordSchema, usernameSchema } from './common.js';

export const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  firstName: z.string().trim().min(1).max(64).optional(),
  lastName: z.string().trim().min(1).max(64).optional(),
  password: passwordSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  /** Email or username. */
  identifier: z.string().trim().min(3).max(255),
  password: z.string().min(1).max(256),
  totp: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$|^[A-Za-z0-9-]{8,32}$/, 'Enter a 6-digit code or a backup code')
    .optional(),
  rememberMe: z.boolean().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(256),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const verifyEmailSchema = z.object({ token: z.string().min(16).max(256) });

export const enableTwoFactorSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
  password: z.string().min(1).max(256),
});

export const disableTwoFactorSchema = z.object({
  password: z.string().min(1).max(256),
  code: z.string().min(6).max(32),
});
