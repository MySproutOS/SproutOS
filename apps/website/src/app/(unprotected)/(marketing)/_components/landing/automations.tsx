import { Reveal, RevealItem } from "@ui/spa-shared/reveal"

/*
  Named app-to-app automations, because "automate your work" is not a thing anyone pictures.

  The lede does real work here: these are not pre-built connectors and we should not let the grid
  imply an integrations catalogue we do not have. What SproutOS runs is code in the customer's own
  project, which can talk to any API — that is a wider claim than a connector list, and a true one.
*/

const AUTOMATIONS = [
  {
    pair: "Slack → Notion",
    title: "File what customers actually said",
    body: "When someone drops a useful comment in a channel, it lands in the right Notion database with the thread attached.",
  },
  {
    pair: "Gmail → Linear",
    title: "Turn overnight mail into triaged issues",
    body: "Support mail becomes Linear issues, deduplicated against what is already open, before anyone reads it.",
  },
  {
    pair: "Stripe → Google Sheets",
    title: "The finance sheet, kept current",
    body: "Every payment, refund and dispute in the sheet your finance person already opens, refreshed hourly.",
  },
  {
    pair: "RSS → Obsidian",
    title: "Your reading, in your own vault",
    body: "Pull the feeds you follow, cluster the repeats, summarise the rest, and write it where your notes live.",
  },
  {
    pair: "Calendar → Email",
    title: "A follow-up that cancels itself",
    body: "Three days after the meeting, unless they already replied — in which case nothing is sent at all.",
  },
  {
    pair: "GitHub → Slack",
    title: "Only the pull requests that are yours",
    body: "The ones touching files you own, only once they are ready for review — not every event in the repository.",
  },
] as const

export function Automations() {
  return (
    <section className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">In practice</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Automations between the apps you already use.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            You describe it in a sentence; it runs as code in your own project, on your schedule.
            None of these is a pre-built connector — if the app has an API, the automation can talk
            to it.
          </p>
        </Reveal>

        <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {AUTOMATIONS.map((automation, i) => (
            <RevealItem
              key={automation.pair}
              delay={i * 60}
              className="h-full rounded-2xl border rule-soft bg-card/60 p-6"
            >
              <p className="mb-3 font-mono text-xs tracking-[0.04em] text-primary">
                {automation.pair.toUpperCase()}
              </p>
              <h3 className="font-display text-base font-semibold tracking-tight text-balance">
                {automation.title}
              </h3>
              <p className="mt-2.5 text-sm text-muted-foreground text-pretty">{automation.body}</p>
            </RevealItem>
          ))}
        </ul>
      </div>
    </section>
  )
}
