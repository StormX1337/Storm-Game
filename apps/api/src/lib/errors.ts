import { ErrorCode } from '@storm/types';

/**
 * Every failure that reaches the client goes through AppError, which guarantees
 * a stable machine-readable code alongside human-readable copy. Anything else
 * that escapes a handler is logged in full and reported as INTERNAL_ERROR — we
 * never leak stack traces or driver messages to callers.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode | string;
  public readonly details?: Record<string, string[]>;
  public readonly expose: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode | string,
    message: string,
    options: { details?: Record<string, string[]>; cause?: unknown; expose?: boolean } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (options.details) this.details = options.details;
    this.expose = options.expose ?? true;
  }
}

export const badRequest = (message: string, details?: Record<string, string[]>) =>
  new AppError(400, ErrorCode.VALIDATION_ERROR, message, details ? { details } : {});

export const unauthorized = (message = 'Authentication is required', code: string = ErrorCode.UNAUTHENTICATED) =>
  new AppError(401, code, message);

export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, ErrorCode.FORBIDDEN, message);

export const notFound = (message = 'Resource was not found', code: string = ErrorCode.NOT_FOUND) =>
  new AppError(404, code, message);

export const conflict = (message: string, code: string = ErrorCode.CONFLICT) =>
  new AppError(409, code, message);

export const unprocessable = (message: string, code: string = ErrorCode.VALIDATION_ERROR) =>
  new AppError(422, code, message);

export const tooManyRequests = (message = 'Too many requests, please slow down') =>
  new AppError(429, ErrorCode.RATE_LIMITED, message);

export const serviceUnavailable = (message: string, code: string = ErrorCode.SERVICE_UNAVAILABLE) =>
  new AppError(503, code, message);

export const internal = (message = 'Something went wrong', cause?: unknown) =>
  new AppError(500, ErrorCode.INTERNAL_ERROR, message, { cause, expose: false });
