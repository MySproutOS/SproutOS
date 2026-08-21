import { validator as base } from "hono-typebox-openapi/typebox"
import type { MiddlewareHandler } from "hono"
import { every } from "hono/combine"
import { Compile } from "typebox/compile"
import { Value } from "typebox/value"

/**
 * `validator`, with the JSON body's types actually enforced.
 *
 * ## What the library does
 *
 * `hono-typebox-openapi`'s validator runs, in this order:
 *
 * ```js
 * const data = Value.Convert(schema, Value.Default(schema, Value.Clean(schema, unprocessedData)))
 * if (compiled.Check(data)) { ... }
 * ```
 *
 * `Value.Convert` reshapes the request to fit the schema before anything checks whether it fit. It
 * is not a narrow string-to-number affordance:
 *
 * | schema | body | becomes | verdict |
 * | --- | --- | --- | --- |
 * | `Array(String)` | `"ls -la"` | `["ls -la"]` | pass |
 * | `Array(String)` | `42` | `["42"]` | pass |
 * | `Array(String)` | `true` | `["true"]` | pass |
 * | `Integer` | `7.5` | `7` | pass |
 * | `Number` | `true` | `1` | pass |
 * | `Boolean` | `1` | `true` | pass |
 * | `String` | `42` | `"42"` | pass |
 *
 * Every one of those is a client sending the wrong type and getting a 200 for a *different request*
 * than the one it made. The handler cannot tell: by the time it reads `c.req.valid("json")` the
 * original is gone.
 *
 * This was found the long way. A sandbox exec sent `{"command": "ls -la"}`, which became
 * `["ls -la"]`, which asked `execve` for a binary whose filename contains a space. That failure
 * arrives on the Kubernetes exec protocol's status channel rather than the process's stderr, so the
 * caller received `{"stdout":"","stderr":"","exitCode":1}` — indistinguishable from a command that
 * ran and failed silently. The only input the validator refused was `[]`, by `minItems`, which is
 * exactly what made the validation look like it was working.
 *
 * ## What this does
 *
 * For `json` targets, `Check` runs on the **cleaned and defaulted** value, without `Convert`. A body
 * whose types are right is unaffected; a body whose types are wrong gets a 400 naming the field,
 * instead of a 200 for something else.
 *
 * `Clean` and `Default` are kept. Clean drops unknown properties, which is a security property
 * rather than a convenience — it is what stops a client setting a field the schema does not
 * mention. Default fills in declared defaults, and a body omitting one must still pass.
 *
 * ## Query strings and path params are untouched
 *
 * They arrive as strings and nothing else. `?limit=25` *must* become `25`, and refusing it would
 * mean every route parsed its own numbers. Coercion is the correct behaviour there and the wrapper
 * passes those straight through — this is a wrapper rather than a fork precisely so that the
 * difference between the two cases is stated in one place.
 */
/*
  Typed as `typeof base`, not with its parameters spread.

  The library's `validator` is generic, and the type it returns is what carries the schema through
  to `c.req.valid("json")`. Writing `(...args: Parameters<typeof base>): ReturnType<typeof base>`
  collapses those generics to their constraints, and every call site then sees `never`:
  591 type errors, all of them saying a route handler could not read its own validated body.

  So the implementation is untyped internally and the *binding* carries the library's signature.
  That is the one place a cast is the honest answer — this really is the same function with an extra
  check in front, and any narrower type would be a second, worse copy of a signature that already
  exists.
*/
export const validator = ((...args: Parameters<typeof base>) => {
  const [target, schema] = args
  const inner = base(...args)
  if (target !== "json") return inner

  const compiled = Compile(schema)

  const strict: MiddlewareHandler = async (c, next) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      // No body, or malformed JSON. The library's own error is better than anything this could say,
      // and Hono caches the parse either way.
      await next()
      return undefined
    }

    const cleaned = Value.Default(schema, Value.Clean(schema, body))
    if (compiled.Check(cleaned)) {
      await next()
      return undefined
    }

    /*
      The same error shape the library produces, so a client cannot tell which layer refused it.

      Only the errors `Convert` would have papered over reach here: anything that fails both with
      and without conversion falls through to the library, which reports it identically.
    */
    return c.json({ success: false, errors: Array.from(compiled.Errors(cleaned)) }, 400)
  }

  /*
    Composed with `every`, not by hand.

    Hand-composing two middlewares means writing `(c, next) => strict(c, () => inner(c, next))`,
    which type-checks only with `any` on both parameters — and `any` on a `Context` is how a
    validator stops being checked at all, in a file whose whole subject is validation not being
    checked. `every` is Hono's own composer and keeps the types.
  */
  return every(strict, inner as MiddlewareHandler)
}) as typeof base
