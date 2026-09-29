import { AppError } from '@storm-bet/types';
import type { z } from 'zod';

/**
 * Parses untrusted input. Failures become a VALIDATION_ERROR whose details map
 * field paths to messages — the schema's own (user-facing) messages, never
 * the raw input.
 */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  const first = Object.values(fields)[0];
  throw new AppError('VALIDATION_ERROR', first ?? undefined, { details: { fields } });
}
