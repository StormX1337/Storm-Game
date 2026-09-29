import { AppError, ERROR_MESSAGES, isAppError } from '@storm-bet/types';
import type { FastifyError, FastifyInstance } from 'fastify';

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
    reply.status(appError.status).send(appError.toBody(request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send(new AppError('NOT_FOUND', 'Diese Schnittstelle existiert nicht.').toBody(request.id));
  });
}
