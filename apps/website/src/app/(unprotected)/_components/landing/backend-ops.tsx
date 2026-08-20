import { Reveal, RevealItem } from "@ui/spa-shared/reveal"

const SERVICES = [
  {
    name: "Your app, online",
    body: "Real hosting that holds up when people actually use it. A site runs for a few cents a month instead of a monthly plan.",
    price: "¢ / mo",
  },
  {
    name: "Things that run on their own",
    body: "Follow-up emails, weekly reports, overnight imports. They wake up when there's work and cost nothing in between.",
    price: "per run",
  },
  {
    name: "A proper database",
    body: "Postgres — the thing engineering would have given you — with your data in it. It sleeps between visits, which is what keeps the bill in cents.",
    price: "¢ / mo",
  },
  {
    name: "Search that actually finds things",
    body: "A shared search and caching cluster, kept separate per customer. You get a real one without paying for a whole one.",
    price: "shared",
  },
  {
    name: "AI that costs less",
    body: "We buy model usage across the whole platform and pass the discount down, so anything an agent builds stays cheap to run.",
    price: "below list",
  },
] as const

export function BackendOps() {
  return (
    <section id="backend" className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">What you get</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Everything the tech team would set up. Without asking them.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            This is the list an engineering team normally works through on your behalf. On SproutOS
            you get all of it directly — no ticket in a queue, no admin approving access, no carving
            a line item out of someone else's budget.
          </p>
          <p className="mt-4 text-muted-foreground text-pretty">
            Every piece bills only for what it actually does. Nothing here charges you to sit idle.
          </p>
        </Reveal>

        <ul className="mt-12 border-t rule-soft">
          {SERVICES.map((service, i) => (
            <RevealItem key={service.name} delay={i * 60}>
              <div className="group grid gap-2 border-b rule-soft py-7 transition-colors hover:bg-card/40 md:grid-cols-[minmax(0,15rem)_1fr_auto] md:items-baseline md:gap-8 md:px-4">
                <h3 className="font-display text-lg font-semibold tracking-tight">
                  {service.name}
                </h3>
                <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
                  {service.body}
                </p>
                <span className="font-mono text-xs whitespace-nowrap text-husk md:text-right">
                  {service.price}
                </span>
              </div>
            </RevealItem>
          ))}
        </ul>

        <Reveal delay={80}>
          <p className="mt-8 max-w-2xl text-sm text-muted-foreground text-pretty">
            You don't need to know what any of it is called. You describe what you want; SproutOS
            picks the pieces and wires them together.
          </p>
        </Reveal>
      </div>
    </section>
  )
}
