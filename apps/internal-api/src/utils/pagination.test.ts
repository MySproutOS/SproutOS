import { describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { createNextCursor, createNextOffsetCursor, decodeCursor } from "./pagination"

/**
 * Both cursor flavours had a bug that made page two unreachable, and neither was
 * caught because nothing round-tripped a cursor through the decoder. That is the
 * only property that matters here: whatever the encoder emits, the decoder must
 * accept.
 */
function page(size: number) {
  // Callers fetch pageSize + 1 to detect a next page, so a full page is size + 1.
  return Array.from({ length: size + 1 }, () => ({ id: v7(), createdAt: new Date() }))
}

describe("offset cursors round-trip", () => {
  it("accepts the cursor it just produced", () => {
    const cursor = createNextOffsetCursor({ results: page(25), pageSize: 25, cursor: null })
    expect(cursor).not.toBeNull()
    // Previously this threw "Invalid position": the encoder wrote the literal
    // string "limit/offset" into the anchor field and the decoder validated that
    // field as a UUID, so no caller could ever reach page two.
    expect(() => decodeCursor(cursor)).not.toThrow()
  })

  it("advances by a page each time", () => {
    let cursor = createNextOffsetCursor({ results: page(10), pageSize: 10, cursor: null })
    expect(decodeCursor(cursor).offset).toBe(10)

    cursor = createNextOffsetCursor({ results: page(10), pageSize: 10, cursor })
    expect(decodeCursor(cursor).offset).toBe(20)

    cursor = createNextOffsetCursor({ results: page(10), pageSize: 10, cursor })
    expect(decodeCursor(cursor).offset).toBe(30)
  })

  it("carries no anchor, because an offset page has none", () => {
    const cursor = createNextOffsetCursor({ results: page(5), pageSize: 5, cursor: null })
    const decoded = decodeCursor(cursor)
    expect(decoded.cursorType).toBe("offset")
    expect(decoded.position).toBeNull()
    expect(decoded.serializedPosition).toBeNull()
  })

  it("returns null on the last page", () => {
    // Fewer rows than pageSize + 1 means there is nothing after this page.
    const results = Array.from({ length: 3 }, () => ({ id: v7() }))
    expect(createNextOffsetCursor({ results, pageSize: 10, cursor: null })).toBeNull()
  })
})

describe("keyset cursors round-trip", () => {
  it("accepts the cursor it just produced", () => {
    const results = page(25)
    const cursor = createNextCursor({ results, pageSize: 25, ordering: "id", cursor: null })
    expect(cursor).not.toBeNull()
    expect(() => decodeCursor(cursor)).not.toThrow()
  })

  it("anchors on the first row and walks forward with an offset", () => {
    const results = page(5)
    const cursor = createNextCursor({ results, pageSize: 5, ordering: "id", cursor: null })
    const decoded = decodeCursor(cursor)
    // Deliberately the first row, not the last: the anchor pins the result set
    // against rows inserted mid-pagination, and the offset walks forward from it.
    // Anchoring on the last row would let a new row shift the window by one.
    expect(decoded.serializedPosition).toBe(results[0].id)
    expect(decoded.offset).toBe(5)
  })

  it("preserves a date anchor as a Date", () => {
    const results = page(3)
    const cursor = createNextCursor({ results, pageSize: 3, ordering: "createdAt", cursor: null })
    const decoded = decodeCursor(cursor)
    expect(decoded.cursorType).toBe("date")
    expect(decoded.position).toBeInstanceOf(Date)
  })
})

describe("decodeCursor rejects what it should", () => {
  it("treats no cursor as the first page", () => {
    expect(decodeCursor(null)).toEqual({
      offset: 0,
      position: null,
      cursorType: null,
      serializedPosition: null,
    })
  })

  it("rejects a cursor that is not base64 JSON", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(/Invalid cursor/)
  })

  it("rejects a negative offset", () => {
    const forged = Buffer.from(JSON.stringify({ o: -1, p: "", t: "offset" })).toString("base64url")
    expect(() => decodeCursor(forged)).toThrow(/Invalid offset/)
  })

  it("rejects a keyset anchor that is not a uuid", () => {
    // The anchor goes into a WHERE clause, so an unvalidated one is worth
    // rejecting even though Kysely parameterizes it.
    const forged = Buffer.from(
      JSON.stringify({ o: 0, p: "'; drop table users --", t: "string" }),
    ).toString("base64url")
    expect(() => decodeCursor(forged)).toThrow(/Invalid position/)
  })

  it("rejects an unknown cursor type", () => {
    const forged = Buffer.from(JSON.stringify({ o: 0, p: v7(), t: "wat" })).toString("base64url")
    expect(() => decodeCursor(forged)).toThrow(/Invalid cursor type/)
  })
})
