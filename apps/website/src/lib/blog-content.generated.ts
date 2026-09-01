// Generated from src/content/blog/*.md by scripts/generate-blog.ts.
// Markdoc renderable trees. Server-only: imported through src/lib/blog-content.ts.
import type { RenderableTreeNode } from "@markdoc/markdoc"

export const GENERATED_POST_CONTENT: Record<string, RenderableTreeNode[]> = {
  "hand-back-the-data": [
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "The standard advice is that your users' data is your defensibility. Keep enough of it, for long",
        " ",
        "enough, and leaving becomes expensive — so they stay.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "It works. It is also the reason nobody trusts consumer software, and the reason a better product",
        " ",
        "than yours has to be ",
        {
          $$mdtype: "Tag",
          name: "em",
          attributes: {},
          children: ["considerably"],
        },
        " better before anyone will move.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "what-you-are-actually-holding",
      },
      children: ["What you are actually holding"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "A breach of your servers is a breach of their history. A subject access request is an engineering",
        " ",
        "week. A storage bill that grows with every signup, forever, whether or not that account ever comes",
        " ",
        "back. None of that is a moat; it is custody, and custody is a cost.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "the-other-arrangement",
      },
      children: ["The other arrangement"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Sign people in with SproutOS and write into the user's own database. You get the app; they get the",
        " ",
        "rows.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "ul",
      attributes: {},
      children: [
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: ["Their history is theirs, so leaving is a copy rather than a project."],
        },
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: ["Your storage stops tracking your signup count."],
        },
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: [
            "You still charge for the product, because the product is what they were paying for.",
          ],
        },
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "but-then-they-can-leave",
      },
      children: ['"But then they can leave"'],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Yes. That is the point, and it cuts both ways: every user of every competitor can also arrive,",
        " ",
        "bringing five years of history with them, and start on day one with a product that already knows",
        " ",
        "them.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Retention propped up by an export button nobody can use is not retention. It is a number that looks",
        " ",
        "like retention until something better is one click away.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "what-it-takes",
      },
      children: ["What it takes"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Authorization Code with PKCE, and one extra scope. If you have integrated an OAuth provider before,",
        " ",
        "there is exactly one new idea — the database scope — and the user can decline it and still sign in.",
      ],
    },
  ],
  "health-data-you-can-join": [
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "You run with one app, sleep with a ring, and live out of a work calendar. Each of the three is",
        " ",
        "good. Each shows you a chart of itself.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "And the question you actually have — ",
        {
          $$mdtype: "Tag",
          name: "em",
          attributes: {},
          children: [
            "am I falling behind because I am training badly, or because",
            " ",
            "March has been brutal?",
          ],
        },
        " — needs all three at once.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "why-nobody-ships-this-feature",
      },
      children: ["Why nobody ships this feature"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Your fitness app could answer it, if it had your sleep and your calendar. It does not, and it never",
        " ",
        "will: the data belongs to two competitors, and no amount of product roadmap fixes that.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "So the answer today is three exports, three schemas, and an afternoon in a spreadsheet. Most people",
        " ",
        "do it once, never again, and go back to guessing.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "what-changes-when-the-database-is-yours",
      },
      children: ["What changes when the database is yours"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "If those apps write into a database you own, the question stops being an integration and becomes a",
        " ",
        "join.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "CodeBlock",
      attributes: {
        language: "sql",
      },
      children: [
        "select week\nfrom   runs\njoin   sleep    using (week)\njoin   calendar using (week)\nwhere  sleep.hours_median < 7\n  and  calendar.meeting_hours > 30\n",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Nobody had to build that. No vendor had to agree to it. It works because all three sets of rows are",
        " ",
        "sitting in one place that belongs to the person who generated them.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: ["The answer is either reassuring or actionable. Both beat a fourth chart."],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "why-this-is-only-possible-cheaply",
      },
      children: ["Why this is only possible cheaply"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "A database per person is a sane idea only if a database costs cents. Priced like an always-on",
        " ",
        "instance, one per user is a business nobody can run — which is why the companies best placed to",
        " ",
        "offer you this are the least able to.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "That is the whole reason the argument is available to us: everything here suspends when nothing is",
        " ",
        "happening, and a personal database is idle nearly all of the time.",
      ],
    },
  ],
}
