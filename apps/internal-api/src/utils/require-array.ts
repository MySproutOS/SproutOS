import { createMiddleware } from "hono/factory"
import { ErrorCode } from "./errors.enum"
import { throwBadRequest } from "./http-exception"

/**
 * Refuse a JSON body field that is not an array, before the validator turns it into one.
 *
 * ## The coercion
 *
 * `hono-typebox-openapi`'s validator runs `Value.Convert` before `Check`, and Convert wraps a
 * scalar to satisfy an array schema. Against
 * `command: Type.Array(Type.String(), { minItems: 1, maxItems: 64 })`:
 *
 * | body                       | after Convert     | Check |
 * | -------------------------- | ----------------- | ----- |
 * | `{"command": ["ls","-la"]}` | `["ls","-la"]`    | pass  |
 * | `{"command": "ls -la"}`    | `["ls -la"]`      | pass  |
 * | `{"command": 42}`          | `["42"]`          | pass  |
 * | `{"command": []}`          | `[]`              | fail  |
 *
 * Only the empty array is refused, by `minItems` — which is exactly what made the validation look
 * like it was working. Everything else is silently reshaped, and the handler cannot tell: by the
 * time it reads `c.req.valid("json")` the original is gone.
 *
 * ## Why that matters for an argv
 *
 * `["ls -la"]` is a request to run a binary whose filename contains a space. `execve` does not find
 * one, and in the Kubernetes exec protocol that failure arrives on the status channel rather than
 * on the process's stderr — so the caller receives `{"stdout":"","stderr":"","exitCode":1}` and no
 * indication that their command was rewritten. It looks like the command ran and failed silently.
 *
 * Coercion is reasonable for a query string, where everything is a string and `"5"` must become
 * `5`. For a JSON body it converts a client's type error into a different request that happens to
 * validate.
 *
 * ## Scope
 *
 * This guards one field on one route. The behaviour is not specific to either — any array-typed
 * body field on any route accepts a scalar the same way. Recorded in `docs/findings/0010`; a
 * general fix belongs at the validator, not in a guard per field.
 */
export function requireArray(field: string, hint: string) {
  return createMiddleware(async (c, next) => {
    let body: unknown
    try {
      // Hono caches the parsed body on the request, so the validator downstream re-reads this
      // rather than a consumed stream.
      body = await c.req.json()
    } catch {
      // Malformed JSON, or no body at all. The validator's own error is better than anything this
      // could say, so hand it over untouched.
      await next()
      return undefined
    }

    const value = (body as Record<string, unknown> | null)?.[field]
    if (value !== undefined && !Array.isArray(value)) {
      /*
        Returned, not thrown.

        `throwBadRequest` is named for what it means, not what it does — it returns a `Response`
        built by `c.json`. Calling it for effect discards that response and falls through to the
        handler with the body already read, which is a 502 rather than a 400: the first version of
        this guard did exactly that.
      */
      return throwBadRequest(c, `${field} must be an array. ${hint}`, ErrorCode.InvalidInput)
    }

    await next()
    // `undefined` explicitly, not a bare `return`: the branch above returns a `Response`, and
    // `noImplicitReturns` requires every path through the function to agree about returning.
    return undefined
  })
}
