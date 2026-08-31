import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ErrorCode, type ApiErrorBody } from '@storm/types';
import { isPrismaError, PRISMA_ERRORS } from '@storm/database';
import { AppError } from '../lib/errors.js';

export default fp(
  async function errorHandlerPlugin(app: FastifyInstance) {
    app.setNotFoundHandler((request, reply) => {
      const payload: ApiErrorBody = {
        success: false,
        error: {
          code: ErrorCode.NOT_FOUND,
          message: `No route matches ${request.method} ${request.url}`,
          requestId: request.id,
        },
      };
      void reply.status(404).send(payload);
    });

    app.setErrorHandler((error, request, reply) => {
      let status = 500;
      let code: string = ErrorCode.INTERNAL_ERROR;
      let message = 'Something went wrong on our side';
      let details: Record<string, string[]> | undefined;

      if (error instanceof AppError) {
        status = error.statusCode;
        code = error.code;
        message = error.expose ? error.message : message;
        details = error.details;
      } else if (error instanceof ZodError) {
        status = 400;
        code = ErrorCode.VALIDATION_ERROR;
        message = 'The submitted data is invalid';
        details = {};
        for (const issue of error.issues) {
          const key = issue.path.join('.') || '_';
          (details[key] ??= []).push(issue.message);
        }
      } else if (isPrismaError(error, PRISMA_ERRORS.UNIQUE_CONSTRAINT)) {
        status = 409;
        code = ErrorCode.ALREADY_EXISTS;
        message = 'A record with those details already exists';
      } else if (isPrismaError(error, PRISMA_ERRORS.RECORD_NOT_FOUND)) {
        status = 404;
        code = ErrorCode.NOT_FOUND;
        message = 'Resource was not found';
      } else if (isPrismaError(error, PRISMA_ERRORS.FOREIGN_KEY_CONSTRAINT)) {
        status = 409;
        code = ErrorCode.CONFLICT;
        message = 'That record is still referenced by something else';
      } else if (typeof error.statusCode === 'number' && error.statusCode < 500) {
        // Errors raised by Fastify plugins (rate limit, body parsing, multipart).
        status = error.statusCode;
        code = status === 429 ? ErrorCode.RATE_LIMITED : ErrorCode.VALIDATION_ERROR;
        if (status === 413) code = ErrorCode.FILE_TOO_LARGE;
        if (status === 415) code = ErrorCode.UNSUPPORTED_MEDIA_TYPE;
        message = error.message;
      }

      const logPayload = {
        err: error,
        requestId: request.id,
        method: request.method,
        url: request.url,
        userId: request.user?.id,
      };
      if (status >= 500) {
        request.log.error(logPayload, 'request failed');
      } else {
        request.log.info(logPayload, 'request rejected');
      }

      const body: ApiErrorBody = {
        success: false,
        error: { code, message, requestId: request.id, ...(details ? { details } : {}) },
      };
      void reply.status(status).send(body);
    });
  },
  { name: 'storm-errors' },
);
