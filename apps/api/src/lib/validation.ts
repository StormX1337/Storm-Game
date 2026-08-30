import type { FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { badRequest } from './errors.js';

function toDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

/**
 * Parses untrusted input with a zod schema and converts failures into a
 * 400 with field-level details. Every route uses this — no handler ever reads
 * `request.body` directly.
 */
export function parse<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest('The submitted data is invalid', toDetails(result.error));
  }
  return result.data;
}

export const body = <T extends ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> =>
  parse(schema, request.body ?? {});

export const query = <T extends ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> =>
  parse(schema, request.query ?? {});

export const params = <T extends ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> =>
  parse(schema, request.params ?? {});
