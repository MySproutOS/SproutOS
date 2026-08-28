import { formatMicroUsd, type MicroUsd } from "./money"

/**
 * A PDF invoice (§17).
 *
 * ## Written by hand, rather than with a library
 *
 * An invoice is one page of left-aligned text in one font. The libraries that would produce it
 * either embed a font (hundreds of kilobytes, and a licence to check) or drive a headless browser
 * (a Chromium in the deployment, on the path that renders a customer's bill). What is actually
 * needed is a header, one content stream, a cross-reference table, and Helvetica — which every PDF
 * reader has built in and which therefore needs no embedding at all.
 *
 * The format below is PDF 1.4's, and the one part that must be exactly right is the `xref` table:
 * every object's byte offset from the start of the file. A reader given a wrong offset reports the
 * file as damaged rather than showing anything, so the offsets are computed from the bytes actually
 * written rather than predicted.
 */

export const COMPANY = {
  name: "Ur LLC",
  address: ["1617 Washtenaw Ave", "Ann Arbor, Michigan 48104", "United States"],
  contact: "billing@sproutos.me",
} as const

export type InvoiceLine = {
  label: string
  /** The metered quantity as the customer sees it — "3.2 GB-hours". */
  quantity: string
  amountMicroUsd: MicroUsd
}

export type Invoice = {
  number: string
  issuedAt: Date
  periodStart: Date
  periodEnd: Date
  organizationName: string
  lines: InvoiceLine[]
  subtotalMicroUsd: MicroUsd
  /** The platform's amortized overhead, shown rather than folded into the lines. */
  overheadMicroUsd: MicroUsd
  /** Stripe's cut, its own line because it is a pass-through and not a margin. */
  processingMicroUsd: MicroUsd
  totalMicroUsd: MicroUsd
}

/**
 * Escape a string for a PDF literal.
 *
 * Backslash and both parentheses end or escape a string, so a project called `Ada (test)` would
 * close the literal early and produce a file no reader will open. This is the injection vector of
 * the format, and every value on an invoice is a customer-supplied name.
 */
export function escapePdfText(value: string): string {
  return (
    value
      .replaceAll("\\", "\\\\")
      .replaceAll("(", "\\(")
      .replaceAll(")", "\\)")
      // Helvetica's built-in encoding is Latin-1; anything outside it renders as the wrong glyph.
      // Replaced rather than dropped, so a name is visibly transliterated rather than silently short.
      .replaceAll(/[^\x20-\x7e]/g, "?")
  )
}

/**
 * A line amount, at the precision the meter measured.
 *
 * Usage really is sub-cent — a request costs two micro-USD — so rounding each line to cents would
 * show a page of `$0.00` that sums to a total nobody could derive. AWS's own invoices do the same
 * thing for the same reason.
 */
function lineMoney(amount: MicroUsd): string {
  return formatMicroUsd(amount)
}

/** Round a cash payment to whole cents. Usage statements do not use this: prepaid debits are exact. */
export function totalInCents(amount: MicroUsd): string {
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  const cents = (abs + 9_999n) / 10_000n
  const dollars = cents / 100n
  const remainder = cents % 100n

  return `${negative ? "-" : ""}$${dollars.toLocaleString("en-US")}.${remainder.toString().padStart(2, "0")}`
}

function date(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/** The lines of text on the page, top to bottom. Separated so the layout is testable without a PDF. */
export function invoiceText(invoice: Invoice): string[] {
  const lines: string[] = [
    COMPANY.name,
    ...COMPANY.address,
    COMPANY.contact,
    "",
    `INVOICE ${invoice.number}`,
    `Issued ${date(invoice.issuedAt)}`,
    // `periodEnd` is exclusive in storage. Printing it directly labels an August statement as
    // ending September 1, which reads as though September 1 was billed too.
    `Period ${date(invoice.periodStart)} to ${date(new Date(invoice.periodEnd.getTime() - 1))}`,
    `Billed to ${invoice.organizationName}`,
    "",
    "Usage",
  ]

  for (const line of invoice.lines) {
    // Plain hyphens. An em dash is outside Latin-1 and `escapePdfText` would transliterate it to a
    // question mark — on a customer's invoice, which looks like a broken document.
    lines.push(`  ${line.label} - ${line.quantity} - ${lineMoney(line.amountMicroUsd)}`)
  }

  if (invoice.lines.length === 0) {
    // Said, rather than an empty section. An invoice with a blank usage block reads as a rendering
    // fault; one that says there was no usage reads as an invoice.
    lines.push("  No metered usage this period")
  }

  lines.push("", `Subtotal: ${lineMoney(invoice.subtotalMicroUsd)}`)
  // Fees are separate rather than folded into usage. A zero payment-processing line is omitted:
  // monthly statements debit prepaid credit and do not charge a card.
  lines.push(`Platform overhead: ${lineMoney(invoice.overheadMicroUsd)}`)
  if (invoice.processingMicroUsd !== 0n) {
    lines.push(`Payment processing: ${lineMoney(invoice.processingMicroUsd)}`)
  }
  lines.push(
    "",
    `Total debited from prepaid credit: ${lineMoney(invoice.totalMicroUsd)}`,
    "",
    "Usage and totals are shown in exact micro-USD precision.",
  )

  return lines
}

/**
 * Render the invoice as a PDF.
 *
 * Returns bytes, not a string: a PDF's `xref` offsets are byte counts, and a multi-byte character
 * anywhere before them would make every offset after it wrong by the difference. `escapePdfText`
 * keeps the content Latin-1, so this is belt as well as braces.
 */
export function renderInvoicePdf(invoice: Invoice): Buffer {
  const allText = invoiceText(invoice)
  const pageSize = 46
  const pages: string[][] = []
  for (let offset = 0; offset < allText.length; offset += pageSize) {
    const slice = allText.slice(offset, offset + pageSize)
    pages.push(offset === 0 ? slice : [`INVOICE ${invoice.number} (continued)`, "", ...slice])
  }
  if (pages.length === 0) pages.push([])

  const pageObjectStart = 3
  const contentObjectStart = pageObjectStart + pages.length
  const fontObject = contentObjectStart + pages.length
  const pageReferences = pages.map((_, index) => `${pageObjectStart + index} 0 R`).join(" ")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${pages.length} >>`,
    ...pages.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObjectStart + index} 0 R >>`,
    ),
    ...pages.map((text) => {
      const content = [
        "BT",
        "/F1 11 Tf",
        "14 TL",
        "56 760 Td",
        ...text.map((line) => `(${escapePdfText(line)}) Tj T*`),
        "ET",
      ].join("\n")
      return `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`
    }),
    // Helvetica is one of the fourteen fonts every reader has. No embedding, no licence, no bytes.
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]

  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []

  for (const [index, object] of objects.entries()) {
    // Recorded from what has been written, never predicted. A wrong offset makes a reader report
    // the file as damaged rather than showing anything.
    offsets.push(Buffer.byteLength(pdf, "latin1"))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objects.length + 1}\n`
  // Object 0 is always the head of the free list, and always exactly this.
  pdf += "0000000000 65535 f \n"
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, "latin1")
}

/**
 * The invoice number.
 *
 * Sequential per organization within a year, prefixed so two customers never share one. Not a UUID:
 * an invoice number goes into somebody's accounting system and gets typed by a human, and thirty-six
 * characters of hex is a number nobody can read back over a phone.
 */
export function invoiceNumber(organizationId: string, year: number, sequence: number): string {
  const short = organizationId.replaceAll("-", "").slice(-6).toUpperCase()
  return `${year}-${short}-${sequence.toString().padStart(4, "0")}`
}
