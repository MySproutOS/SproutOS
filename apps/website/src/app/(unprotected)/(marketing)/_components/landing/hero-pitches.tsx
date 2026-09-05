const PITCHES = [
  {
    audience: "For you",
    title: "Your data should work for you, not trap you.",
    body: "Every app writes to a database you own, so your apps can work together — and leaving is a copy, not a project.",
    tone: "bg-card/75",
  },
  {
    audience: "For builders",
    title: "Every app starts from zero. Yours doesn't have to.",
    body: "Start with an open source app that already works, describe the change, and deploy your own version.",
    tone: "bg-primary/[0.07]",
  },
  {
    audience: "For the movement",
    title: "This only works as a movement.",
    body: "One app gives your data back. An ecosystem lets it answer questions no app can answer alone.",
    tone: "bg-soil-700/55",
  },
] as const

/** Three parallel reasons for SproutOS, grouped as one editorial panel rather than steps. */
export function HeroPitches() {
  return (
    <ul
      aria-label="Why SproutOS"
      className="grid grid-rows-3 overflow-hidden rounded-2xl border rule-soft bg-border/60"
    >
      {PITCHES.map((pitch) => (
        <li
          key={pitch.audience}
          className={`${pitch.tone} border-t rule-soft p-5 first:border-t-0 sm:p-6`}
        >
          <p className="eyebrow">{pitch.audience}</p>
          <h2 className="mt-3 font-display text-xl leading-tight font-semibold tracking-tight text-balance">
            {pitch.title}
          </h2>
          <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground text-pretty">
            {pitch.body}
          </p>
        </li>
      ))}
    </ul>
  )
}
