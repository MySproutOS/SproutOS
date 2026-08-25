import { Reveal, RevealItem } from "@ui/spa-shared/reveal"
import { InfoTooltip } from "./info-tooltip"

/*
  The three things people actually pay for, each priced both ways.

  "What you get" used to be a list of five capabilities, which read as a feature grid and told you
  nothing — everybody's feature grid says "a proper database". The argument this section is
  actually making is a cost one, so it now makes it directly: for each of the three line items on
  the receipt, what the same thing costs if you go and rent it yourself.

  The comparison prices are **list prices, not estimates**, and they are dated below. Every one of
  them is a floor rather than a typical bill: the cheapest instance, the smallest disk, the fewest
  seats. That is deliberate. An inflated comparison is worth nothing the first time a reader knows
  the real number, and the honest floor is already the whole argument.
*/

type Card = {
  eyebrow: string
  title: string
  body: string
  ours: { amount: string; unit: string; note: string }
  theirs: { label: string; detail: string; monthly: number }[]
  footnote: string
  /** An extra line with the precise version behind an info icon. Only where one is warranted. */
  note?: { text: string; detail: string }
}

const CARDS: Card[] = [
  {
    eyebrow: "Server-based website",
    title: "A site that runs code, not just files",
    body:
      "Anything past a static page needs a server somewhere: sessions, forms, a database call on " +
      "page load. The two ordinary ways to have one are to rent a platform seat or to rent a box.",
    ours: { amount: "$0.01", unit: "/mo", note: "1,000 visitors" },
    theirs: [
      {
        label: "Vercel Pro",
        detail: "$20/mo platform fee, plus $20 for each extra person who can deploy",
        monthly: 20,
      },
      {
        label: "The cheapest EC2 that can serve it",
        detail: "t4g.nano + 8 GB disk + a public IPv4, on all month",
        monthly: 7.36,
      },
    ],
    footnote:
      "Vercel's fee covers one deploying seat and $20 of usage credit; read-only viewers are free, " +
      "but every additional person who can ship is another $20, so the bill tracks the size of the " +
      "team rather than the size of the app. The EC2 box is cheaper and is yours to patch, " +
      "monitor and put TLS on.",
  },
  {
    eyebrow: "Databases",
    title: "Postgres, a cache, and search",
    body:
      "SproutOS gives you all three: Postgres for your data, Valkey for caching and queues, and " +
      "OpenSearch for search. Each is tenant-split and suspends when nobody is using it, which is " +
      "the entire reason the number on the right is a number of cents.",
    ours: { amount: "$0.02", unit: "/mo", note: "1,000 accounts" },
    theirs: [
      {
        label: "RDS Postgres",
        detail: "db.t4g.micro + 20 GB — the smallest one AWS sells",
        monthly: 13.98,
      },
      { label: "ElastiCache", detail: "cache.t4g.micro", monthly: 11.68 },
      { label: "OpenSearch", detail: "one t3.small.search node", monthly: 26.28 },
    ],
    footnote:
      "None of these can be turned down when idle — a managed database is billed by the hour it " +
      "exists, not the hour it is queried. That is the same $51.94 whether a thousand people use " +
      "your app this month or nobody does.",
    note: {
      // The visible half is the consequence a reader cares about; the tooltip carries the pricing
      // that makes it true, so the sentence can stay short without becoming an overstatement.
      text: "On Supabase's free tier, two is the most databases you can have running at once.",
      detail:
        "The free tier allows two *active* projects — paused ones do not count against it. A " +
        "third means Pro at $25/mo, and each project past the first adds its own compute on top, " +
        "around $10/mo. So a handful of small automations, each with its own isolated database, " +
        "leaves the free tier at the third one.",
    },
  },
  {
    eyebrow: "Workflows & background jobs",
    title: "Things that run without anyone watching",
    body:
      "A sync every minute, a nightly import, a follow-up that fires three days later. The work " +
      "itself is seconds; the cost is in having somewhere for it to happen at all.",
    ours: { amount: "$0.01", unit: "/mo", note: "43,200 runs — one a minute" },
    theirs: [
      {
        label: "Vercel Cron, once a minute",
        detail: "Hobby's minimum interval is once a day, so this needs Pro at $20/mo",
        monthly: 20,
      },
      {
        label: "An EC2 worker sitting there",
        detail: "t4g.nano awake all month to be busy for twelve hours of it",
        monthly: 7.36,
      },
    ],
    footnote:
      "A per-minute schedule is not a bigger job than a daily one — it is the same second of work, " +
      "43,200 times. Paying by the run makes that cost what it weighs.",
  },
]

function total(rows: readonly { monthly: number }[]) {
  return rows.reduce((sum, row) => sum + row.monthly, 0)
}

export function BackendOps() {
  return (
    <section id="backend" className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">What you get</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            The same three things. Priced both ways.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            Every app needs somewhere to run, somewhere to keep its data, and something to do the
            work nobody is watching. Here is what each costs if you go and rent it yourself, and
            what it costs here.
          </p>
          <p className="mt-4 text-muted-foreground text-pretty">
            The difference is not a discount. It is that everything on SproutOS sleeps when nothing
            is happening, and almost nothing is happening almost all of the time.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {CARDS.map((card, i) => (
            <RevealItem key={card.eyebrow} delay={i * 80}>
              <article className="flex h-full flex-col rounded-2xl border rule-soft bg-card/60 p-6 sm:p-7">
                <p className="eyebrow">{card.eyebrow}</p>
                <h3 className="mt-3 font-display text-xl font-semibold tracking-tight text-balance">
                  {card.title}
                </h3>
                <p className="mt-3 text-sm text-muted-foreground text-pretty">{card.body}</p>

                <p className="eyebrow mt-7 mb-3">Doing it yourself</p>
                <ul className="flex flex-col gap-3">
                  {card.theirs.map((row) => (
                    <li key={row.label} className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{row.label}</span>
                        <span className="block text-xs text-muted-foreground text-pretty">
                          {row.detail}
                        </span>
                      </span>
                      <span className="tnum shrink-0 font-mono text-sm text-muted-foreground">
                        ${row.monthly.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>

                {card.theirs.length > 1 && (
                  <p className="mt-3 flex items-baseline justify-between gap-3 border-t rule-soft pt-3">
                    <span className="text-sm text-muted-foreground">
                      {card.eyebrow === "Databases" ? "All three, always on" : "Whichever you pick"}
                    </span>
                    <span className="tnum font-mono text-sm text-muted-foreground">
                      {card.eyebrow === "Databases"
                        ? `$${total(card.theirs).toFixed(2)}`
                        : `$${Math.min(...card.theirs.map((r) => r.monthly)).toFixed(2)}+`}
                    </span>
                  </p>
                )}

                <div className="mt-auto pt-7">
                  <div className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-4">
                    <p className="eyebrow mb-2">On SproutOS</p>
                    <p className="flex items-baseline gap-1.5">
                      <span className="tnum font-mono text-3xl font-medium text-husk">
                        {card.ours.amount}
                      </span>
                      <span className="font-mono text-sm text-husk/80">{card.ours.unit}</span>
                    </p>
                    <p className="mt-1.5 font-mono text-xs text-muted-foreground">
                      {card.ours.note}
                    </p>
                  </div>
                  {card.note ? (
                    <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground text-pretty">
                      <span>{card.note.text}</span>
                      <InfoTooltip label="How Supabase's project limit is priced">
                        {card.note.detail}
                      </InfoTooltip>
                    </p>
                  ) : null}
                  <p className="mt-4 text-xs text-muted-foreground text-pretty">{card.footnote}</p>
                </div>
              </article>
            </RevealItem>
          ))}
        </div>

        <Reveal delay={120}>
          <p className="mt-8 max-w-3xl text-sm text-muted-foreground text-pretty">
            Comparison figures are published list prices for us-east-1, read from the AWS pricing
            API in August 2026 and multiplied by 730 hours, and are the cheapest option each vendor
            offers rather than a typical bill. You don't need to know what any of these are called —
            you describe what you want, and SproutOS picks the pieces and wires them together.
          </p>
        </Reveal>
      </div>
    </section>
  )
}
