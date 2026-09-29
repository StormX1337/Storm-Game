/**
 * The one error vocabulary of the platform. Every failure the API reports is
 * one of these codes; the web app maps them to user-facing copy. Nothing else
 * (no stack, no SQL, no provider message) ever reaches a client.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  ODDS_CHANGED: 'ODDS_CHANGED',
  MARKET_SUSPENDED: 'MARKET_SUSPENDED',
  EVENT_CLOSED: 'EVENT_CLOSED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  BET_LIMIT_EXCEEDED: 'BET_LIMIT_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ODDS_CHANGED: 409,
  MARKET_SUSPENDED: 409,
  EVENT_CLOSED: 409,
  INSUFFICIENT_BALANCE: 422,
  BET_LIMIT_EXCEEDED: 422,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** Default (German) copy. Server messages may be more specific but never technical. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Bitte überprüfe deine Eingaben.',
  UNAUTHORIZED: 'Bitte melde dich an, um fortzufahren.',
  FORBIDDEN: 'Für diese Aktion fehlt dir die Berechtigung.',
  NOT_FOUND: 'Der angeforderte Eintrag wurde nicht gefunden.',
  CONFLICT: 'Die Anfrage steht im Konflikt mit dem aktuellen Stand.',
  ODDS_CHANGED: 'Quote wurde aktualisiert.',
  MARKET_SUSPENDED: 'Dieser Markt ist derzeit gesperrt.',
  EVENT_CLOSED: 'Für dieses Event werden keine Wetten mehr angenommen.',
  INSUFFICIENT_BALANCE: 'Dein Demo-Guthaben reicht für diesen Einsatz nicht aus.',
  BET_LIMIT_EXCEEDED: 'Der Einsatz überschreitet ein gültiges Limit.',
  RATE_LIMITED: 'Zu viele Anfragen. Bitte warte einen Moment.',
  SERVICE_UNAVAILABLE: 'Der Dienst ist vorübergehend nicht verfügbar.',
  INTERNAL_ERROR: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es erneut.',
};

export type ErrorDetails = Record<string, unknown>;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetails;
    requestId?: string;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails | undefined;
  /** Seconds a client should wait before retrying (RATE_LIMITED). */
  readonly retryAfter: number | undefined;

  constructor(
    code: ErrorCode,
    message?: string,
    options: { details?: ErrorDetails; retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message ?? ERROR_MESSAGES[code], { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ErrorCode;
}
