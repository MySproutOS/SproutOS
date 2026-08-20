---
name: hono-backend-api
description: Pattern for creating a Hono backend API endpoint
---

## File Structure

Each API resource has two files in `apps/internal-api/src/v1/`:

- `resource-name.ts` — Route handlers
- `resource-name.serializer.ts` — TypeBox schemas for request/response/query/param validation

Routes are registered in `apps/internal-api/src/v1/index.ts` via `.route("/resource-name", resourceName)`.

## Route File Pattern

```typescript
import { db } from "@sproutos/db"
import { crudResource, fetchResource } from "@lib/dao"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware.ts"
import { EmptyObject, IdParamT } from "../utils/common.serializer.ts"
import { ErrorSchemaResponse } from "../utils/errors/error.serializer.ts"
import { ErrorCode } from "../utils/errors.enum.ts"
import { throwBadRequest, throwForbidden, throwNotFound } from "../utils/http-exception.ts"
import {
  resourceSchemaQuery,
  resourceSchemaRequest,
  resourceSchemaResponse,
} from "./resource.serializer.ts"

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/",
    describeRoute({
      description: "Fetches resources",
      responses: {
        200: {
          description: "List of resources",
          content: {
            "application/json": {
              schema: resolver(resourceSchemaResponse),
            },
          },
        },
        400: {
          description: "Invalid request",
          content: {
            "application/json": {
              schema: resolver(ErrorSchemaResponse),
            },
          },
        },
      },
    }),
    validator("query", resourceSchemaQuery),
    async (c) => {
      const user = c.var.user
      const query = c.req.valid("query")
      const someParam = query.someParam ?? null

      const results = await fetchResource(db).listByUserId(user.id, [
        "id",
        "name",
        "description",
        "createdAt",
      ])

      return c.json({ data: results })
    },
  )
  .post(
    "/",
    describeRoute({
      description: "Creates a resource",
      responses: {
        201: {
          description: "Resource created",
          content: {
            "application/json": {
              schema: resolver(resourceSchemaResponse),
            },
          },
        },
        400: {
          description: "Invalid request",
          content: {
            "application/json": {
              schema: resolver(ErrorSchemaResponse),
            },
          },
        },
      },
    }),
    validator("json", resourceSchemaRequest),
    async (c) => {
      const user = c.var.user
      const json = c.req.valid("json")

      const rec = await crudResource(db).create({
        userId: user.id,
        ...json,
      })

      return c.json({ id: rec.id }, 201)
    },
  )
  .delete(
    "/:id",
    describeRoute({
      description: "Deletes a resource",
      responses: {
        200: {
          description: "Resource deleted",
          content: {
            "application/json": {
              schema: resolver(EmptyObject),
            },
          },
        },
        404: {
          description: "Resource not found",
          content: {
            "application/json": {
              schema: resolver(ErrorSchemaResponse),
            },
          },
        },
      },
    }),
    validator("param", IdParamT),
    async (c) => {
      const user = c.var.user
      const { id } = c.req.valid("param")

      const resource = await fetchResource(db).get(id, ["userId"])

      if (!resource) return throwNotFound(c, "Resource not found")
      if (resource.userId !== user.id) return throwForbidden(c, "Not your resource")

      await crudResource(db).delete(id)
      return c.json({})
    },
  )

export default app
```

### Key Rules

- **Use DAOs for all database access.** Never call `db.selectFrom()`, `db.insertInto()`, etc. directly in route handlers. Use `fetchResource(db).method()` for reads and `crudResource(db).method()` for writes. DAOs are imported from `@lib/dao`. Never instantiate a DAO into a variable — always call inline: `fetchResource(db).get(id, ["field"])`, not `const dao = fetchResource(db)`.
- **Chain all routes** from the `app` variable. Never do `app.get()` on a separate line — always chain: `.get().post().delete()`.
- **Authentication is already handled.** Access the user via `const user = c.var.user`. Never check if user is falsey.
- **All imports must be relative** (e.g., `../utils/http-exception.ts`, not `@internal-api/...`) except for `@lib/dao` and `@sproutos/db`.
- **All response schemas** must be wrapped in `resolver(schema)`. Never use `resolver(Type.Object({}))` inline — import `EmptyObject` from `utils/common.serializer.ts` instead.
- **All error responses** use `resolver(ErrorSchemaResponse)` from `utils/errors/error.serializer.ts`.
- **Convert undefined to null** for query params: `const value = query.value ?? null`.
- **Return arrays** wrapped in a `data` key: `c.json({ data: results })`.
- **Return nothing** with `EmptyObject`: `c.json({})`. Do not use `{ success: true }`.
- **Don't add comments** to code. If migrating code with function comments, use them as the OpenAPI `description` instead.
- **Always add a `description` to each response status code** (e.g., `200: { description: "Success", content: { ... } }`). Adding a `description` to the route itself is also fine but optional.

### Error Handling

Use helper functions from `utils/http-exception.ts`:

```typescript
return throwBadRequest(c, "Invalid input")
return throwForbidden(c, "Not allowed")
return throwNotFound(c, "Resource not found")
return throwTooManyRequests(c, "Rate limit exceeded")
return throwInternalServerError(c, "Something went wrong")
```

Each helper defaults to the matching `ErrorCode` enum value. Pass a custom `ErrorCode` as the third argument for form validation errors:

```typescript
return throwBadRequest(c, "Email already taken", ErrorCode.ResourceAlreadyExists)
```

All error helpers accept an optional fourth `options` argument for richer error details:

```typescript
return throwBadRequest(c, "Multiple validation errors", ErrorCode.ValidationFailed, {
  // Which field/property caused the error
  target: "email",
  // Array of sub-errors when multiple things failed at once
  details: [
    { code: "NullValue", target: "PhoneNumber", message: "Phone number must not be null" },
    { code: "MalformedValue", target: "Address", message: "Address is not valid" },
  ],
  // Nested error codes for increasing specificity without breaking backwards compat
  innererror: {
    code: "PasswordError",
    innererror: {
      code: "PasswordDoesNotMeetPolicy",
      minLength: "6",
      maxLength: "64",
    },
  },
})
```

The error response follows OData v4 JSON format. Use `target` to indicate which field caused the error. Use `details` when multiple distinct errors occurred in one request. Use `innererror` to provide increasingly specific error codes — clients traverse the chain and pick the deepest code they understand, so new codes can be added without breaking existing clients.

When adding new error codes, update the `ErrorCode` enum in `utils/errors.enum.ts`. For 404s, prefer `ResourceNotFound` with a custom message over a new error code. Custom error codes are primarily for form input validation.

## Serializer File Pattern

```typescript
import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const resourceSchemaQuery = Type.Object({
  companyId: UUID7String,
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

export const resourceSchemaRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  description: Nullable(Type.String()),
})

export const resourceSchemaResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      name: Type.String(),
      description: Nullable(Type.String()),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
})
```

### Key Rules

- **Naming convention:** `routeNameSchema` + suffix. Suffix is one of: `SchemaQuery`, `SchemaParam`, `SchemaRequest`, `SchemaResponse`. Example: `forumCommentSchemaRequest`. Never `QuerySchema` or `RequestSchema`.
- **Use camelCase** for schema variable names.
- **IDs** (primary/foreign keys) use `UUID7String` from `utils/common.serializer.ts`.
- **Nullable types** use `Nullable(Type)` from `utils/common.serializer.ts`.
- **Dates** use `Type.String({ format: "date-time" })` or `Type.String({ format: "date" })`. Never use `Type.Date()`.
- **Only JSON-compatible types:** strings, numbers, booleans, arrays, objects. No JS-specific types.
- **Arbitrary JSON values** use `Type.Object({}, { additionalProperties: true })`. Never use `Type.Any()` for JSON fields.
- **Limit/offset** are `Type.Number({ minimum: 0, multipleOf: 1 })`.
- **No examples** in schemas.
- **No validation logic** in Response schemas — only in Query/Param/Request schemas.
- **Custom validation** uses `Type.Refine()`:
  ```typescript
  const T = Type.Refine(Type.String(), (value) => value.length <= 255, {
    message: "String can't be more than 255 characters",
  })
  ```
- **Never import** from `hono-typebox-openapi/typebox` in a serializer file.

## Registering a New Route

In `apps/internal-api/src/v1/index.ts`, add the import and chain `.route()`:

```typescript
import resourceName from "./resource-name"

// Add to the chain:
  .route("/resource-name", resourceName)
```

## SSE / Streaming Endpoints

Endpoints that return `text/event-stream` (SSE) must be excluded from the OpenAPI client generation config at `.config/openapi-ts.config.ts`. Add the operation ID to the `parser.filters.operations.exclude` array so `@hey-api/openapi-ts` skips them — the generated client cannot handle streaming responses.

## Error Response Format

All errors follow OData v4 JSON format:

```json
{
  "error": {
    "code": "ResourceNotFound",
    "message": "Comment not found"
  }
}
```

Extended errors can include `target`, `details` (array of sub-errors), and `innererror` (nested specificity). See `utils/errors/error.serializer.ts` for the full schema.
