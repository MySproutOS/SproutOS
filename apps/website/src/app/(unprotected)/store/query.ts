/** The `/store` URL is the whole state of the catalogue page — there is no client state to hold it. */
export type StoreQuery = {
  q: string | null
  category: string | null
  tag: string | null
  cursor: string | null
}

/** Next.js hands `searchParams` values as `string | string[] | undefined`. Take the first. */
function first(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  const raw = Array.isArray(value) ? value[0] : value
  const trimmed = raw?.trim() ?? ""
  return trimmed === "" ? null : trimmed
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseStoreQuery(params: Record<string, string | string[] | undefined>): StoreQuery {
  const cursor = first(params.cursor)
  return {
    q: first(params.q),
    category: first(params.category),
    tag: first(params.tag),
    // The cursor is a listing id that goes straight into a WHERE clause. Kysely parameterizes it,
    // but a value that is not a UUID can only be a typo or an attempt, and either way the right
    // answer is page one rather than an error page.
    cursor: cursor !== null && UUID.test(cursor) ? cursor : null,
  }
}

export function storeHref(query: StoreQuery): string {
  const params = new URLSearchParams()
  if (query.q !== null) params.set("q", query.q)
  if (query.category !== null) params.set("category", query.category)
  if (query.tag !== null) params.set("tag", query.tag)
  if (query.cursor !== null) params.set("cursor", query.cursor)
  const search = params.toString()
  return search === "" ? "/store" : `/store?${search}`
}

export function isFiltered(query: StoreQuery): boolean {
  return query.q !== null || query.category !== null || query.tag !== null
}
