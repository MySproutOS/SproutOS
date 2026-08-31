import { InfoTooltip } from "../../_components/info-tooltip"

/*
  One line item on the receipt, priced both ways.

  Lifted out of the old landing-page section so the four platform pages cannot come to disagree
  about what RDS costs. The house rule that came with it still holds and is the reason this is worth
  centralising: **the comparison prices are list prices, not estimates**, and every one of them is a
  floor rather than a typical bill — the cheapest instance, the smallest disk, the fewest seats. An
  inflated comparison is worth nothing the first time a reader knows the real number, and the honest
  floor is already the whole argument.
*/

export type Alternative = {
  label: string
  detail: string
  monthly: number
}

export type CostCardProps = {
  eyebrow: string
  title: string
  body: string
  ours: { amount: string; unit: string; note: string }
  theirs: Alternative[]
  /** How to describe the sum: alternatives you would buy together, or pick one of. */
  totalMode?: "sum" | "cheapest"
  totalLabel?: string
  footnote: string
  note?: { label: string; text: string; detail: string }
}

/** The dated provenance for every number on these pages. Rendered once per page, at the bottom. */
export const PRICE_DISCLOSURE =
  "Comparison figures are published list prices for us-east-1, read from the AWS pricing API in " +
  "August 2026 and multiplied by 730 hours, and are the cheapest option each vendor offers rather " +
  "than a typical bill."

export function CostCard({
  eyebrow,
  title,
  body,
  ours,
  theirs,
  totalMode = "cheapest",
  totalLabel,
  footnote,
  note,
}: CostCardProps) {
  const sum = theirs.reduce((total, row) => total + row.monthly, 0)
  const cheapest = Math.min(...theirs.map((row) => row.monthly))

  return (
    <article className="flex h-full flex-col rounded-2xl border rule-soft bg-card/60 p-6 sm:p-7">
      <p className="eyebrow">{eyebrow}</p>
      <h3 className="mt-3 font-display text-xl font-semibold tracking-tight text-balance">
        {title}
      </h3>
      <p className="mt-3 text-sm text-muted-foreground text-pretty">{body}</p>

      <p className="eyebrow mt-7 mb-3">Doing it yourself</p>
      <ul className="flex flex-col gap-3">
        {theirs.map((row) => (
          <li key={row.label} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-sm text-foreground">{row.label}</span>
              <span className="block text-xs text-muted-foreground text-pretty">{row.detail}</span>
            </span>
            <span className="tnum shrink-0 font-mono text-sm text-muted-foreground">
              ${row.monthly.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>

      {theirs.length > 1 && (
        <p className="mt-3 flex items-baseline justify-between gap-3 border-t rule-soft pt-3">
          <span className="text-sm text-muted-foreground">
            {totalLabel ?? (totalMode === "sum" ? "All of them, always on" : "Whichever you pick")}
          </span>
          <span className="tnum font-mono text-sm text-muted-foreground">
            {totalMode === "sum" ? `$${sum.toFixed(2)}` : `$${cheapest.toFixed(2)}+`}
          </span>
        </p>
      )}

      <div className="mt-auto pt-7">
        <div className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-4">
          <p className="eyebrow mb-2">On SproutOS</p>
          <p className="flex items-baseline gap-1.5">
            <span className="tnum font-mono text-3xl font-medium text-husk">{ours.amount}</span>
            <span className="font-mono text-sm text-husk/80">{ours.unit}</span>
          </p>
          <p className="mt-1.5 font-mono text-xs text-muted-foreground">{ours.note}</p>
        </div>
        {note ? (
          <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground text-pretty">
            <span>{note.text}</span>
            <InfoTooltip label={note.label}>{note.detail}</InfoTooltip>
          </p>
        ) : null}
        <p className="mt-4 text-xs text-muted-foreground text-pretty">{footnote}</p>
      </div>
    </article>
  )
}
