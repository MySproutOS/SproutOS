import { describe, expect, it } from "vitest"
import {
  escapePdfText,
  type Invoice,
  invoiceNumber,
  invoiceText,
  renderInvoicePdf,
  totalInCents,
} from "./invoice"

/**
 * An invoice is a document a customer forwards to an accountant, so "it renders" is the assertion
 * that matters most — a PDF with one wrong byte offset opens as a damaged file rather than as a
 * slightly wrong invoice.
 */
const invoice: Invoice = {
  number: "2026-00D1CE-0007",
  issuedAt: new Date("2026-09-01T00:00:00Z"),
  periodStart: new Date("2026-08-01T00:00:00Z"),
  periodEnd: new Date("2026-08-31T23:59:59Z"),
  organizationName: "Acme (Europe) Ltd",
  lines: [
    { label: "Compute", quantity: "3.2 GB-hours", amountMicroUsd: 34_560n },
    { label: "Requests", quantity: "18,204 requests", amountMicroUsd: 36_408n },
  ],
  subtotalMicroUsd: 70_968n,
  overheadMicroUsd: 8_517n,
  processingMicroUsd: 302_058n,
  totalMicroUsd: 381_543n,
}

describe("the invoice text", () => {
  it("shows processing and overhead as their own lines", () => {
    const text = invoiceText(invoice).join("\n")

    /*
      The Terms of Service say payment processing is shown as its own line rather than folded into
      the price, and the platform overhead is posted as its own ledger entry so a bill stays
      explicable. Merging either into the usage figures would contradict a document the customer
      agreed to.
    */
    expect(text).toContain("Payment processing:")
    expect(text).toContain("Platform overhead:")
    expect(text).toContain("Subtotal:")
    expect(text).toContain("Total:")
  })

  it("names the company that is billing", () => {
    const text = invoiceText(invoice).join("\n")

    expect(text).toContain("Ur LLC")
    expect(text).toContain("1617 Washtenaw Ave")
    expect(text).toContain("Ann Arbor, Michigan 48104")
  })

  it("gives a total somebody can actually pay", () => {
    const text = invoiceText(invoice).join("\n")

    /*
      A payment processor takes integer cents. `Total: $0.381543` is a measurement, not a total, and
      it was what this rendered until a thumbnail of the real PDF was looked at.

      Rounded up rather than to nearest: rounding a charge down means the platform absorbs the
      remainder on every invoice it ever issues.
    */
    expect(text).toContain("Total: $0.39")
    expect(text).not.toContain("Total: $0.381543")

    // And the discrepancy is explained, because the lines are shown at full precision and will not
    // sum to it.
    expect(text).toContain("rounded up to the nearest cent")
  })

  it("rounds a total up, never down", () => {
    expect(totalInCents(1n)).toBe("$0.01")
    expect(totalInCents(10_000n)).toBe("$0.01")
    expect(totalInCents(10_001n)).toBe("$0.02")
    expect(totalInCents(0n)).toBe("$0.00")
    expect(totalInCents(1_234_567_890n)).toBe("$1,234.57")
  })

  it("uses only characters Helvetica can render", () => {
    // An em dash is outside Latin-1 and would transliterate to `?` on a customer's invoice, which
    // looks like a broken document. Found by rendering the PDF and looking at it.
    /*
      The property is "nothing is transliterated", not "nothing is escaped".

      Escaping a parenthesis is correct and expected — `Acme (Europe) Ltd` must become
      `Acme \(Europe\) Ltd`. What must not happen is a character turning into `?`, which is what an
      em dash did before this test existed.
    */
    for (const line of invoiceText(invoice)) {
      expect(escapePdfText(line).includes("?")).toBe(false)
    }
  })

  it("says there was no usage rather than leaving a gap", () => {
    // A blank usage block reads as a rendering fault; a sentence reads as an invoice.
    const text = invoiceText({ ...invoice, lines: [] }).join("\n")

    expect(text).toContain("No metered usage this period")
  })
})

describe("escaping", () => {
  it("neutralises the characters that end a PDF string", () => {
    /*
      The injection vector of the format, and every value on an invoice is a customer-supplied name.
      An organization called `Acme (Europe) Ltd` closes the literal early and produces a file no
      reader will open.
    */
    expect(escapePdfText("Acme (Europe) Ltd")).toBe("Acme \\(Europe\\) Ltd")
    expect(escapePdfText("back\\slash")).toBe("back\\\\slash")
  })

  it("transliterates rather than drops what Helvetica cannot show", () => {
    // Visibly wrong beats silently short: a customer seeing `Caf?` knows something happened.
    expect(escapePdfText("Café Zürich")).toBe("Caf? Z?rich")
  })
})

describe("the PDF", () => {
  it("is a PDF, with the trailer a reader looks for", () => {
    const pdf = renderInvoicePdf(invoice)
    const text = pdf.toString("latin1")

    expect(text.startsWith("%PDF-1.4")).toBe(true)
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true)
    expect(text).toContain("/Type /Catalog")
    expect(text).toContain("/BaseFont /Helvetica")
  })

  it("points every xref entry at the object it claims to", () => {
    /*
      The one thing that must be exactly right. A reader given a wrong byte offset reports the file
      as damaged and shows nothing — so this walks the table and checks that each offset lands on
      the `N 0 obj` it says it does, which is the check that would have caught an offset predicted
      rather than measured.
    */
    const pdf = renderInvoicePdf(invoice)
    const text = pdf.toString("latin1")

    // `\nxref\n`, not `xref\n`: the trailer's own `startxref` ends in those four characters, so
    // searching for the shorter string finds the wrong one and reads an empty table.
    const xrefStart = text.lastIndexOf("\nxref\n")
    const entries = text
      .slice(xrefStart)
      .split("\n")
      .filter((line) => / 00000 n ?$/.test(line))

    expect(entries).toHaveLength(5)

    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10))
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`))
    })
  })

  it("declares a stream length that matches the stream", () => {
    // A `/Length` that disagrees with the bytes is the other way a reader gives up on the file.
    const pdf = renderInvoicePdf(invoice)
    const text = pdf.toString("latin1")

    const declared = Number(/<< \/Length (\d+) >>/.exec(text)?.[1])
    const body = text.slice(
      text.indexOf("stream\n") + "stream\n".length,
      text.indexOf("\nendstream"),
    )

    expect(Buffer.byteLength(body, "latin1")).toBe(declared)
  })

  it("survives a name full of the characters that break it", () => {
    const hostile = renderInvoicePdf({
      ...invoice,
      organizationName: "Ada )(\\ Lovelace ((",
    })
    const text = hostile.toString("latin1")

    // Still one page, still terminated. Before escaping, this produced a file that opened as
    // damaged.
    expect(text).toContain("/Type /Page")
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true)
  })
})

describe("the invoice number", () => {
  it("is short enough to read back over a phone", () => {
    const number = invoiceNumber("01a03600-0000-7000-8000-00000000d1ce", 2026, 7)

    // Not a UUID. An invoice number goes into somebody's accounting system and gets typed by a
    // human; thirty-six characters of hex is not a number anyone can read back.
    expect(number).toBe("2026-00D1CE-0007")
    expect(number.length).toBeLessThan(20)
  })

  it("does not collide between two organizations in the same year", () => {
    const first = invoiceNumber("01a03600-0000-7000-8000-00000000aaaa", 2026, 1)
    const second = invoiceNumber("01a03600-0000-7000-8000-00000000bbbb", 2026, 1)

    expect(first).not.toBe(second)
  })
})
