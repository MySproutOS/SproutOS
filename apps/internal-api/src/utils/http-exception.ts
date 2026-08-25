import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { createErrorObject, createErrorResponse } from "./errors/error.serializer"
import type { ErrorDetail } from "./errors/error.types"
import { ErrorCode } from "./errors.enum"

/*
  `502` is here because a route already documented it.

  `POST /billing/topup` declares a 502 for "Stripe rejected the request" and could not return one,
  so everything Stripe refused fell through to a bare 500 with the body "Internal Server Error" —
  a documented response nothing could produce. 502 is the honest code for it: the request was fine
  and an upstream we depend on refused it, which is not the same as this service being broken.
*/
type HTTPStatusCode = 400 | 401 | 403 | 404 | 405 | 409 | 422 | 429 | 500 | 502 | 503

export function throwHTTPException(
  status: HTTPStatusCode,
  code: ErrorCode,
  message: string,
  options?: {
    target?: string
    details?: ErrorDetail[]
    innererror?: {
      code: string
      innererror?: ErrorDetail["innererror"]
      // biome-ignore lint/suspicious/noExplicitAny: anything other than any might not work here
      [key: string]: any
    }
  },
): never {
  throw new HTTPException(status, {
    message: createErrorObject(code, message, options),
  })
}

/**
 * Returns a standardized error response format
 *
 * @param c Hono context
 * @param status HTTP status code
 * @param code Error code from ErrorCode enum
 * @param message Human-readable error message
 * @param options Additional error options (target, details, innererror)
 */
export function throwError(
  c: Context,
  status: HTTPStatusCode,
  code: ErrorCode,
  message: string,
  options?: {
    target?: string
    details?: ErrorDetail[]
    innererror?: {
      code: string
      innererror?: ErrorDetail["innererror"]
      // biome-ignore lint/suspicious/noExplicitAny: anything other than any might not work here
      [key: string]: any
    }
  },
) {
  return c.json(createErrorResponse(code, message, options), { status })
}

// Common error throwing helpers

export function throwBadRequest(
  c: Context,
  message = "Bad request",
  code: ErrorCode = ErrorCode.BadRequest,
  options?: Parameters<typeof throwError>[4],
) {
  return throwError(c, 400, code, message, options)
}

export function throwUnauthenticated(
  c: Context,
  message = "Bad request",
  code: ErrorCode = ErrorCode.Unauthenticated,
  options?: Parameters<typeof throwError>[4],
) {
  return throwError(c, 401, code, message, options)
}

export function throwForbidden(
  c: Context,
  message = "Forbidden",
  code: ErrorCode = ErrorCode.Forbidden,
  options?: Parameters<typeof throwError>[4],
) {
  return throwError(c, 403, code, message, options)
}

export function throwNotFound(
  c: Context,
  message = "Not found",
  code: ErrorCode = ErrorCode.NotFound,
  options?: Parameters<typeof throwError>[4],
) {
  return throwError(c, 404, code, message, options)
}

/**
 * 409, for a request that is well formed and permitted but cannot be carried out in the current
 * state — a job that has already started, a project with no queue service. Distinct from 400,
 * which says the request itself is wrong: retrying a 409 after the state changes will work.
 */
export function throwConflict(
  c: Context,
  message = "Conflict",
  code: ErrorCode = ErrorCode.Conflict,
  options?: Parameters<typeof throwError>[4],
) {
  return throwError(c, 409, code, message, options)
}

export function throwTooManyRequests(
  c: Context,
  message = "Too many requests",
  code: ErrorCode = ErrorCode.TooManyRequests,
  options?: Parameters<typeof throwError>[4],
) {
  return throwError(c, 429, code, message, options)
}

export function throwInternalServerError(
  c: Context,
  message = "Internal server error",
  code: ErrorCode = ErrorCode.InternalServerError,
  options?: Parameters<typeof throwError>[4],
) {
  return throwError(c, 500, code, message, options)
}
