/** Canonical shape of every response returned by the Storm Panel REST API. */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    /** Field-level validation problems, keyed by dotted path. */
    details?: Record<string, string[]>;
    requestId?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  meta: PaginationMeta;
}

/** Machine readable error codes. The web client maps these to friendly copy. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED',
  TWO_FACTOR_INVALID: 'TWO_FACTOR_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  NOT_FOUND: 'NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  SERVER_NOT_FOUND: 'SERVER_NOT_FOUND',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_SUSPENDED: 'SERVER_SUSPENDED',
  SERVER_NOT_INSTALLED: 'SERVER_NOT_INSTALLED',
  SERVER_BUSY: 'SERVER_BUSY',
  NODE_UNREACHABLE: 'NODE_UNREACHABLE',
  NO_ALLOCATION_AVAILABLE: 'NO_ALLOCATION_AVAILABLE',
  RESOURCE_LIMIT_REACHED: 'RESOURCE_LIMIT_REACHED',
  INSUFFICIENT_NODE_CAPACITY: 'INSUFFICIENT_NODE_CAPACITY',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  STORAGE_ERROR: 'STORAGE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
  checks: Record<string, { status: 'ok' | 'error'; message?: string; latencyMs?: number }>;
}
