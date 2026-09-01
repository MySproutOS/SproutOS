// Generated from src/content/blog/*.md by scripts/generate-blog.ts.
// Metadata and search text only — safe to import from a client component.
export const GENERATED_POSTS = [
  {
    slug: "hand-back-the-data",
    title: "Hand back the data, still charge for the app",
    summary: "Holding everyone's rows is a liability you were taught to call a moat.",
    audience: "For developers",
    kind: "Worked example",
    date: "2026-09-01",
    headings: [
      {
        id: "what-you-are-actually-holding",
        level: 2,
        title: "What you are actually holding",
      },
      {
        id: "the-other-arrangement",
        level: 2,
        title: "The other arrangement",
      },
      {
        id: "but-then-they-can-leave",
        level: 2,
        title: '"But then they can leave"',
      },
      {
        id: "what-it-takes",
        level: 2,
        title: "What it takes",
      },
    ],
    text: "The standard advice is that your users' data is your defensibility. Keep enough of it, for long enough, and leaving becomes expensive — so they stay. It works. It is also the reason nobody trusts consumer software, and the reason a better product than yours has to be considerably better before anyone will move. What you are actually holding A breach of your servers is a breach of their history. A subject access request is an engineering week. A storage bill that grows with every signup, forever, whether or not that account ever comes back. None of that is a moat; it is custody, and custody is a cost. The other arrangement Sign people in with SproutOS and write into the user's own database. You get the app; they get the rows. Their history is theirs, so leaving is a copy rather than a project. Your storage stops tracking your signup count. You still charge for the product, because the product is what they were paying for. \"But then they can leave\" Yes. That is the point, and it cuts both ways: every user of every competitor can also arrive, bringing five years of history with them, and start on day one with a product that already knows them. Retention propped up by an export button nobody can use is not retention. It is a number that looks like retention until something better is one click away. What it takes Authorization Code with PKCE, and one extra scope. If you have integrated an OAuth provider before, there is exactly one new idea — the database scope — and the user can decline it and still sign in.",
  },
  {
    slug: "health-data-you-can-join",
    title: "The question three health apps can't answer",
    summary: "Not because the data is missing — because it is in three companies.",
    audience: "For people",
    kind: "Worked example",
    date: "2026-09-01",
    headings: [
      {
        id: "why-nobody-ships-this-feature",
        level: 2,
        title: "Why nobody ships this feature",
      },
      {
        id: "what-changes-when-the-database-is-yours",
        level: 2,
        title: "What changes when the database is yours",
      },
      {
        id: "why-this-is-only-possible-cheaply",
        level: 2,
        title: "Why this is only possible cheaply",
      },
    ],
    text: "You run with one app, sleep with a ring, and live out of a work calendar. Each of the three is good. Each shows you a chart of itself. And the question you actually have — am I falling behind because I am training badly, or because March has been brutal? — needs all three at once. Why nobody ships this feature Your fitness app could answer it, if it had your sleep and your calendar. It does not, and it never will: the data belongs to two competitors, and no amount of product roadmap fixes that. So the answer today is three exports, three schemas, and an afternoon in a spreadsheet. Most people do it once, never again, and go back to guessing. What changes when the database is yours If those apps write into a database you own, the question stops being an integration and becomes a join. select week from runs join sleep using (week) join calendar using (week) where sleep.hours_median < 7 and calendar.meeting_hours > 30 Nobody had to build that. No vendor had to agree to it. It works because all three sets of rows are sitting in one place that belongs to the person who generated them. The answer is either reassuring or actionable. Both beat a fourth chart. Why this is only possible cheaply A database per person is a sane idea only if a database costs cents. Priced like an always-on instance, one per user is a business nobody can run — which is why the companies best placed to offer you this are the least able to. That is the whole reason the argument is available to us: everything here suspends when nothing is happening, and a personal database is idle nearly all of the time.",
  },
] as const
