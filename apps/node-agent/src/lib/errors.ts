/** Mirror of the panel's error contract so both speak the same shape. */
export class AgentError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export const badRequest = (message: string, code = 'VALIDATION_ERROR') => new AgentError(400, code, message);
export const unauthorized = (message = 'Invalid node credentials') =>
  new AgentError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message: string) => new AgentError(403, 'FORBIDDEN', message);
export const notFound = (message: string, code = 'NOT_FOUND') => new AgentError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT') => new AgentError(409, code, message);
export const internal = (message: string) => new AgentError(500, 'INTERNAL_ERROR', message);
