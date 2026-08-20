---
name: dao-creator
description: Pattern for creating Data Access Object (DAO) files for database tables
---

## Overview

Every database table should have two DAO files in `lib/typescript/dao/src/<tableName>/`:

- `crud.ts` — Write operations (create, update, delete)
- `fetch.ts` — Read operations (getOne, getMany, and custom queries)

All new DAO functions must be re-exported from `lib/typescript/dao/src/index.ts`.

## crud.ts Pattern

```typescript
import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudResource(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["resource"]>, "id">,
  ): Promise<Selectable<DB["resource"]>> {
    return await db
      .insertInto("resource")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["resource"]>,
  ): Promise<Selectable<DB["resource"]> | undefined> {
    return await db
      .updateTable("resource")
      .set(data)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, update }
}
```

### Key Points

- `create` accepts `PartialBy<Insertable<DB["tableName"]>, "id">` — the `id` is optional because it's auto-generated with `v7()`.
- `create` uses `.returningAll().executeTakeFirstOrThrow()` and returns the full `Selectable`.
- `update` accepts the `id` and an `Updateable` partial. Returns `Selectable | undefined` via `.executeTakeFirst()`.
- Add additional where clauses for ownership checks when needed (e.g., `.where("userId", "=", userId)`).
- Add `delete` functions as needed. They can return `boolean` based on `numDeletedRows > 0`.

## fetch.ts Pattern

```typescript
import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchResource(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["resource"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["resource"]>, T[number]> | undefined> {
    return await db.selectFrom("resource").select(fields).where("id", "=", id).executeTakeFirst()
  }

  async function getMany<T extends (keyof DB["resource"])[]>(
    userId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["resource"]>, T[number]>[]> {
    return await db.selectFrom("resource").select(fields).where("userId", "=", userId).execute()
  }

  return { getOne, getMany }
}
```

### Key Points

- Both `getOne` and `getMany` use the generic `T extends (keyof DB["tableName"])[]` pattern. This forces the caller to specify exactly which columns they need, and the return type is automatically narrowed to `Pick<Selectable<...>, T[number]>`.
- `getOne` returns `| undefined` via `.executeTakeFirst()`.
- `getMany` returns an array via `.execute()`.
- Add additional fetch functions as needed (e.g., `countByUserId`, `listByCompanyId`). Follow the same generic fields pattern.
- Add `.orderBy()` when the return order matters.

## Naming Conventions

- **crud function**: `crud` + PascalCase table name. E.g., `crudCompanyJobPosting`.
- **fetch function**: `fetch` + PascalCase table name. E.g., `fetchCompanyJobPosting`.
- **File location**: `lib/typescript/dao/src/<camelCaseTableName>/crud.ts` and `fetch.ts`.

## Re-exporting in index.ts

Every new DAO must be added to `lib/typescript/dao/src/index.ts`:

```typescript
export { crudResource } from "./resource/crud"
export { fetchResource } from "./resource/fetch"
```

## Usage in Route Handlers

Always call the DAO factory inline — never assign it to a variable:

```typescript
// Correct
const result = await fetchResource(db).getOne(id, ["id", "name"])
const created = await crudResource(db).create({ name: "test", userId: user.id })

// Incorrect — never do this
const dao = fetchResource(db)
const result = await dao.getOne(id, ["id", "name"])
```

Import from `@lib/dao`:

```typescript
import { crudResource, fetchResource } from "@lib/dao"
```
