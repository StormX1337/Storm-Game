import { AppError, ERROR_MESSAGES, isAppError } from '@storm-bet/types';
import type { FastifyError, FastifyInstance } from 'fastify';
import { toEnglish, wantsEnglish } from '../lib/i18n';

type ErrorBody = ReturnType<AppError['toBody']>;

/** English messages for a player who chose English (details included). */
function translateBody(body: ErrorBody): ErrorBody {
  const details = body.error.details as
    | { fields?: Record<string, string>; issues?: { message: string }[] }
    | undefined;
  return {
    ...body,
    error: {
      ...body.error,
      message: toEnglish(body.error.message),
      ...(details
        ? {
            details: {
              ...details,
              ...(details.fields
                ? {
                    fields: Object.fromEntries(
                      Object.entries(details.fields).map(([k, v]) => [k, toEnglish(v)]),
                    ),
                  }
                : {}),
              ...(details.issues
                ? { issues: details.issues.map((i) => ({ ...i, message: toEnglish(i.message) })) }
                : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * One error shape for every failure. Known errors map to their code; anything
 * else is logged with the request id and reported as INTERNAL_ERROR without
 * a single detail of what went wrong.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    let appError: AppError;
    if (isAppError(error)) {
      appError = error;
    } else if ('validation' in error && error.validation) {
      appError = new AppError('VALIDATION_ERROR');
    } else if (
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    ) {
      const status = error.statusCode;
      appError =
        status === 413
          ? new AppError('VALIDATION_ERROR', 'Die Anfrage ist zu groß.')
          : status === 415 || status === 400
            ? new AppError('VALIDATION_ERROR', 'Die Anfrage konnte nicht gelesen werden.')
            : status === 404
              ? new AppError('NOT_FOUND')
              : status === 429
                ? new AppError('RATE_LIMITED')
                : new AppError('VALIDATION_ERROR');
    } else {
      request.log.error({ err: error }, 'unhandled error');
      appError = new AppError('INTERNAL_ERROR', ERROR_MESSAGES.INTERNAL_ERROR);
    }
    if (appError.status >= 500 && isAppError(error)) {
      request.log.error({ err: error }, 'service error');
    }
    if (appError.retryAfter) reply.header('Retry-After', appError.retryAfter);
    const body = appError.toBody(request.id);
    reply.status(appError.status).send(wantsEnglish(request) ? translateBody(body) : body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body = new AppError('NOT_FOUND', 'Diese Schnittstelle existiert nicht.').toBody(
      request.id,
    );
    reply.status(404).send(wantsEnglish(request) ? translateBody(body) : body);
  });
}
