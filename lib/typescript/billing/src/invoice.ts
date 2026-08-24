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

/**
 * The total, rounded **up** to whole cents.
 *
 * This is the number somebody pays, and a payment processor takes integer cents — an invoice
 * reading `Total: $0.381543` is not a total, it is a measurement. Up rather than nearest, because
 * rounding a charge down means the platform absorbs the remainder on every invoice it ever issues.
 *
 * The consequence is stated on the invoice itself: the lines will not sum to exactly the total, and
 * a customer who adds them up and finds a cent of difference should be told why rather than left to
 * wonder whether they were overcharged.
 */
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
    `Period ${date(invoice.periodStart)} to ${date(invoice.periodEnd)}`,
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

  lines.push(
    "",
    `Subtotal: ${lineMoney(invoice.subtotalMicroUsd)}`,
    /*
      Both of these are their own line on purpose.

      The Terms say payment processing is shown as its own line rather than folded into the price,
      and the platform overhead is posted as its own ledger entry so a bill stays explicable. An
      invoice that merged either into the usage figures would contradict a document the customer
      agreed to.
    */
    `Platform overhead: ${lineMoney(invoice.overheadMicroUsd)}`,
    `Payment processing: ${lineMoney(invoice.processingMicroUsd)}`,
    "",
    `Total: ${totalInCents(invoice.totalMicroUsd)}`,
    "",
    // Said, not left to be discovered. A customer who adds the lines up and finds a cent of
    // difference should know why rather than wonder whether they were overcharged.
    "Usage is metered below one cent and shown at full precision;",
    "the total is rounded up to the nearest cent, which is what is charged.",
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
  const text = invoiceText(invoice)

  const content = [
    "BT",
    "/F1 11 Tf",
    "14 TL",
    "56 760 Td",
    ...text.map((line) => `(${escapePdfText(line)}) Tj T*`),
    "ET",
  ].join("\n")

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    // US Letter, in points. The customers this bills are American and the address above is.
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
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
