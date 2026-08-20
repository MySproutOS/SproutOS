---
name: frontend-calling-backend
description: How to perform network calls to our backend services from the frontend
---

The frontend calls the backend via a type-safe generated client. The backend (Hono) exposes an OpenAPI spec, and `@hey-api/openapi-ts` generates TypeScript types, SDK functions, and TanStack React Query hooks from that spec.

## Generating the Client

**Prerequisites:** The internal API server must be running locally at `http://localhost:3001`
(`pnpm run dev --filter=@api/internal`, or just `pnpm run dev` for the whole stack). It is a
standalone Hono app, not mounted inside Next.js.

```bash
pnpm --filter=@lib/api-client run openapi         # public API
pnpm --filter=@lib/api-client run openapi:admin   # admin API
```

These run `openapi-ts` using the configs at `.config/openapi-ts.config.ts` and
`.config/openapi-ts.admin.config.ts`, which:

1. Fetch the OpenAPI spec from `http://localhost:3001/openapi` (and `/admin-openapi`)
2. Generate output to `lib/typescript/api-client/src/generated/` (and `src/admin-generated/`)
3. Run `pnpm run format` on the generated files

### What Gets Generated

| File                           | Purpose                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `types.gen.ts`                 | Request/response TypeScript types for every endpoint            |
| `sdk.gen.ts`                   | SDK functions for calling each endpoint                         |
| `client.gen.ts`                | Pre-configured fetch client (base URL: `http://localhost:3001`) |
| `@tanstack/react-query.gen.ts` | `queryOptions` and `mutationOptions` factories for React Query  |
| `transformers.gen.ts`          | Response transformers (e.g., date string to Date)               |

### When to Regenerate

Run the commands above whenever:

- A new API route is added or removed
- Request/response schemas change
- Path or query parameters change

**Do not manually edit any `.gen.ts` files** — they are overwritten on regeneration.

### Config Reference

The hey-api configs are at `.config/openapi-ts.config.ts` and `.config/openapi-ts.admin.config.ts`. Key settings:

- **Plugins**: `@hey-api/client-fetch`, `@tanstack/react-query` (with `queryKeys` and `mutationOptions`), `@hey-api/typescript`, `@hey-api/transformers`, `@hey-api/sdk`

The two specs are split by route prefix on the API side: `/openapi` excludes `/admin/**`, and
`/admin-openapi` includes only `/admin/**`.

### Base URL and credentials

`lib/typescript/api-client/src/index.ts` points both clients at the standalone API
(`http://localhost:3001` in dev) with `credentials: "include"`. That flag is required: the API
is a different origin from the website, and the session cookie only rides along with it.

## Usage in React

All examples use TanStack Query v5. Import hooks from `@lib/api-client/generated/@tanstack/react-query.gen`.

### Fetching Data (GET)

```tsx
"use client"

import { useQuery } from "@tanstack/react-query"
import { getV1CompanyJobPostingOptions } from "@lib/api-client/generated/@tanstack/react-query.gen"

export function JobsList({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    ...getV1CompanyJobPostingOptions({ query: { id: companyId } }),
  })

  if (isLoading) return <div>Loading...</div>

  return (
    <ul>
      {data?.jobPostings.map((job) => (
        <li key={job.id}>{job.role}</li>
      ))}
    </ul>
  )
}
```

The `*Options()` functions return `{ queryKey, queryFn }` — spread them into `useQuery`.

### Mutations (POST/PUT/PATCH/DELETE)

```tsx
"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  getV1CompanyJobPostingOptions,
  postV1CompanyJobPostingMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export function CreateJobButton({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient()

  const createJob = useMutation({
    ...postV1CompanyJobPostingMutation(),
    onSuccess: () => {
      // Invalidate the related query to refetch
      void queryClient.invalidateQueries({
        queryKey: getV1CompanyJobPostingOptions({ query: { id: companyId } }).queryKey,
      })
    },
  })

  return (
    <button
      onClick={() => createJob.mutate({ body: { companyId, role: "Engineer" } })}
      disabled={createJob.isPending}
    >
      Create Job
    </button>
  )
}
```

The `*Mutation()` functions return `{ mutationFn }` — spread them into `useMutation`.

### Finding the Right Types

To figure out what parameters a mutation/query expects:

1. Look at the function signature in `@tanstack/react-query.gen.ts` — it accepts `Options<SomeData>`
2. Find `SomeData` in `types.gen.ts` — it shows `path`, `query`, and `body` properties

Example for a DELETE with path params:

```typescript
// In types.gen.ts:
export type DeleteV1FriendByIdDeleteSentInviteData = {
  body?: never
  path: { id: string }
  query?: never
  url: "/v1/friend/{id}/delete-sent-invite"
}
```

Usage:

```tsx
deleteMutation.mutate({ path: { id: friendId } })
```

### Cache Invalidation

Use the `*Options()` queryKey to invalidate after mutations:

```tsx
void queryClient.invalidateQueries({
  queryKey: getV1CompanyJobPostingOptions({ query: { id: companyId } }).queryKey,
})
```
