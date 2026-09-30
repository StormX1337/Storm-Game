import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@storm-bet/config/constants';
import { z } from 'zod';
import { countryCode, trimmed } from './common';

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'E-Mail-Adresse ist zu lang')
  .email('Bitte gib eine gültige E-Mail-Adresse ein');

export const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Mindestens ${PASSWORD_MIN_LENGTH} Zeichen`)
  .max(PASSWORD_MAX_LENGTH, `Höchstens ${PASSWORD_MAX_LENGTH} Zeichen`)
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), 'Mindestens ein Buchstabe und eine Ziffer');

export const displayName = trimmed(2, 32, 'Anzeigename').regex(
  /^[\p{L}\p{N} ._-]+$/u,
  'Nur Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich',
);

export const registerSchema = z.object({
  email,
  password,
  displayName,
  country: countryCode.optional(),
  ageConfirmed: z.literal(true, {
    errorMap: () => ({ message: 'Bitte bestätige, dass du mindestens 18 Jahre alt bist' }),
  }),
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: 'Bitte akzeptiere die Nutzungsbedingungen' }),
  }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email,
  // No strength rules on login: an old password must still be able to fail properly.
  password: z.string().min(1, 'Bitte gib dein Passwort ein').max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

const token = z.string().min(20).max(200);

export const resetPasswordSchema = z.object({ token, password });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({ token });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Bitte gib dein aktuelles Passwort ein'),
    newPassword: password,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'Das neue Passwort muss sich vom alten unterscheiden',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateProfileSchema = z.object({
  displayName: displayName.optional(),
  country: countryCode.nullable().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** A 6-digit authenticator code or a recovery code ("abcd-2345"). */
const secondFactorCode = z
  .string()
  .trim()
  .min(6, 'Bitte gib den Code ein')
  .max(20)
  .regex(/^[0-9a-zA-Z\s-]+$/, 'Ungültiger Code');

export const loginTwoFactorSchema = z.object({
  challenge: z.string().min(20).max(200),
  code: secondFactorCode,
});

export const twoFactorSetupSchema = z.object({
  password: z.string().min(1, 'Bitte gib dein Passwort ein').max(PASSWORD_MAX_LENGTH),
});

export const twoFactorCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Bitte gib den 6-stelligen Code ein'),
});

export const twoFactorDisableSchema = z.object({
  password: z.string().min(1, 'Bitte gib dein Passwort ein').max(PASSWORD_MAX_LENGTH),
  code: secondFactorCode,
});
