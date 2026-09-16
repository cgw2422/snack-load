/**
 * The error contract shared by both transports (docs/03 §7).
 *
 * Note that a cross-tenant read returns NOT_FOUND rather than FORBIDDEN:
 * confirming that someone else's record exists is itself a leak.
 */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'INSUFFICIENT_STOCK'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  INSUFFICIENT_STOCK: 409,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = STATUS[code]
    this.details = details
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } }
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`)
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError('FORBIDDEN', message)
export const unauthenticated = (message = 'Sign in to continue') =>
  new AppError('UNAUTHENTICATED', message)
export const conflict = (message: string, details?: unknown) =>
  new AppError('CONFLICT', message, details)

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}
