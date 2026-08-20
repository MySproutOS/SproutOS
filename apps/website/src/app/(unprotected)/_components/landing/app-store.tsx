import { Reveal } from "@ui/spa-shared/reveal"

function Connector() {
  return (
    <div aria-hidden="true" className="flex flex-col items-center py-2">
      <span className="h-6 w-px bg-border" />
      <span className="-mt-1 text-xs text-muted-foreground">▾</span>
    </div>
  )
}

/**
 * The path from someone else's app to your own, in the words a person would use.
 */
function PersonalizeFlow() {
  return (
    <div className="w-full rounded-2xl border rule-soft bg-card/60 p-6 sm:p-8">
      <div className="rounded-xl border rule-soft bg-background/50 px-5 py-4">
        <p className="eyebrow mb-1.5">From the store</p>
        <p className="font-display text-base font-semibold tracking-tight">Recipe Box</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Open source. Already works. 4,100 people run it.
        </p>
      </div>

      <Connector />

      <div className="rounded-xl border border-primary/35 bg-primary/8 px-5 py-4">
        <p className="eyebrow mb-2">You say</p>
        <p className="font-mono text-sm leading-relaxed text-foreground">
          “Add a shopping list that groups everything by supermarket aisle.”
        </p>
      </div>

      <Connector />

      <div className="rounded-xl border border-primary/45 bg-background/50 px-5 py-4">
        <p className="eyebrow mb-1.5">Yours</p>
        <p className="font-display text-base font-semibold tracking-tight text-primary">
          Your Recipe Box
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your changes, your recipes, your database.
        </p>
      </div>

      <p className="mt-6 border-t rule-soft pt-4 text-xs text-muted-foreground text-pretty">
        When the original gets a fix or a new feature, it shows up in your copy too — your changes
        stay put.
      </p>
    </div>
  )
}

export function AppStore() {
  return (
    <section id="app-store" className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-20">
        <Reveal>
          <p className="eyebrow mb-4">The app store</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Start from an app that already works. Then make it yours.
          </h2>
          <p className="mt-5 text-muted-foreground text-pretty">
            The hard part of having your own app is building the first version. Our store hands you
            that part already done — an Android store and a web store of open source apps other
            people already use. Personalizing one is a sentence, not a project.
          </p>
          <p className="mt-4 text-muted-foreground text-pretty">
            And your copy doesn't go stale. SproutOS keeps it current with the original, so fixes
            and new features arrive without undoing anything you changed. That upkeep can run on the
            Claude Code subscription you already pay for, your own API key, or an in-house model.
          </p>
        </Reveal>

        <Reveal delay={100} className="flex justify-center lg:justify-end">
          <PersonalizeFlow />
        </Reveal>
      </div>
    </section>
  )
}
