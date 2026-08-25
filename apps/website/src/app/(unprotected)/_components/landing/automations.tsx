import { Reveal, RevealItem } from "@ui/spa-shared/reveal"

/*
  The section that has to land before the app store means anything.

  The store shows what you can start from; this says why starting is a decision nobody has to
  approve. The order matters — a reader who has not yet understood that the bill is cents reads the
  store as "another platform I would have to get signed off".
*/

const EXAMPLES = [
  {
    name: "A plugin backend for Obsidian or Notion",
    body: "Sync, transform and enrich your own notes on your own schedule, against a database only you can reach. No shared cloud, no third party holding the vault.",
  },
  {
    name: "A news digest that reads what you actually follow",
    body: "Pull the feeds, cluster the repeats, summarise the rest, send one email at seven. Runs for a couple of seconds a day and bills like it.",
  },
  {
    name: "An inbox summariser",
    body: "Read overnight mail, group it, surface the three things that need an answer. Private by construction: it is your code, in your project, talking to your account.",
  },
] as const

export function Automations() {
  return (
    <section id="automations" className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">Automations & workflows</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Too cheap to need approval. Too simple to need a developer.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            Automation platforms bill by the seat, the task, or the month — and every one of them
            charges you while your automation sits there doing nothing. Ours sleeps when there is no
            work, so a job that runs for two seconds a day costs what two seconds a day is worth. We
            have not found anyone who does it cheaper.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:gap-12">
          <Reveal className="border-l-2 border-primary/40 pl-6">
            <h3 className="font-display text-lg font-semibold tracking-tight">
              IT never has to find budget
            </h3>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              There is no budget to find. A department's automations come to less than a pound a
              month, which is under every approval threshold anyone has ever written down — so the
              conversation that normally kills the idea never starts.
            </p>
          </Reveal>

          <Reveal delay={80} className="border-l-2 border-primary/40 pl-6">
            <h3 className="font-display text-lg font-semibold tracking-tight">
              And nobody has to build it
            </h3>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              You describe what should happen and when. No engineer to borrow, no ticket, no
              self-hosted automation server for someone to keep upright. Five minutes, in your own
              words.
            </p>
          </Reveal>
        </div>

        <Reveal delay={120} className="mt-14">
          <p className="eyebrow mb-6">What people actually build</p>
        </Reveal>

        <ul className="grid gap-5 md:grid-cols-3">
          {EXAMPLES.map((example, i) => (
            <RevealItem key={example.name} delay={i * 80}>
              <li className="h-full rounded-2xl border rule-soft bg-card/60 p-6">
                <h3 className="font-display text-base font-semibold tracking-tight text-balance">
                  {example.name}
                </h3>
                <p className="mt-3 text-sm text-muted-foreground text-pretty">{example.body}</p>
              </li>
            </RevealItem>
          ))}
        </ul>

        <Reveal delay={100}>
          <p className="mt-8 max-w-2xl text-sm text-muted-foreground text-pretty">
            All of it private by default — your code, your database, your account. The cheap version
            of this elsewhere is someone else's cloud reading your notes.
          </p>
        </Reveal>
      </div>
    </section>
  )
}
