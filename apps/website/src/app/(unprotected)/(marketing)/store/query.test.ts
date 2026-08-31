import { describe, expect, it } from "vitest"
import { isFiltered, parseStoreQuery, storeHref } from "./query"

describe("parseStoreQuery", () => {
  it("reads the filters a visitor can set", () => {
    expect(parseStoreQuery({ q: "notes", category: "personal-tools", tag: "django" })).toEqual({
      q: "notes",
      category: "personal-tools",
      tag: "django",
      cursor: null,
    })
  })

  it("takes the first value when a parameter repeats", () => {
    expect(parseStoreQuery({ q: ["notes", "bookmarks"] }).q).toBe("notes")
  })

  it("treats blank and missing the same", () => {
    expect(parseStoreQuery({ q: "   ", category: undefined })).toEqual({
      q: null,
      category: null,
      tag: null,
      cursor: null,
    })
  })

  it("drops a cursor that is not a listing id", () => {
    // The cursor goes into a WHERE clause. A value that is not a UUID is a typo or an attempt,
    // and page one is a better answer than an error page for both.
    expect(parseStoreQuery({ cursor: "'; drop table store_listing --" }).cursor).toBeNull()
    const real = "0199f0e1-9c8a-7000-8000-000000000001"
    expect(parseStoreQuery({ cursor: real }).cursor).toBe(real)
  })
})

describe("storeHref", () => {
  it("round-trips through parseStoreQuery", () => {
    const query = parseStoreQuery({ q: "note taking", tag: "self hosted", category: "personal" })
    const href = storeHref(query)
    const parsed = parseStoreQuery(
      Object.fromEntries(new URL(href, "https://sproutos.dev").searchParams),
    )
    expect(parsed).toEqual(query)
  })

  it("is the bare path when nothing is filtered", () => {
    expect(storeHref({ q: null, category: null, tag: null, cursor: null })).toBe("/store")
  })

  it("escapes a value that would otherwise break the query string", () => {
    expect(storeHref({ q: "a&b=c", category: null, tag: null, cursor: null })).toBe(
      "/store?q=a%26b%3Dc",
    )
  })
})

describe("isFiltered", () => {
  it("ignores the cursor, which is a position and not a filter", () => {
    expect(isFiltered({ q: null, category: null, tag: null, cursor: "x" })).toBe(false)
    expect(isFiltered({ q: "notes", category: null, tag: null, cursor: null })).toBe(true)
  })
})
