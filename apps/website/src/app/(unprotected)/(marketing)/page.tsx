import { fetchStoreListing } from "@lib/dao/storeListing/fetch"
import { db } from "@sproutos/db"
import { getCurrentSession } from "@website/lib/auth"
import { repositoryStars } from "@website/lib/github-stars"
import { redirect } from "next/navigation"
import Link from "next/link"
import { AlternatingRow } from "./_components/landing/alternating"
import { AppMarquee } from "./_components/landing/app-marquee"
import { Automations } from "./_components/landing/automations"
import { IdleCostDiagram, OwnershipDiagram, UpkeepDiagram } from "./_components/landing/diagrams"
import { FinalCta } from "./_components/landing/final-cta"
import { Hero } from "./_components/landing/hero"
import { Platform } from "./_components/landing/platform"
import { Teasers } from "./_components/landing/teasers"
import { PersonalizeFlow } from "./_components/personalize-flow"

/**
 * Rendered per request, like `/store` and `/personalize`.
 *
 * The marquee reads the catalogue, so prerendering would freeze the list at build time and make the
 * build itself need a reachable database.
 */
export const dynamic = "force-dynamic"

const MARQUEE_LIMIT = 12

export default async function Page() {
  const session = await getCurrentSession()
  if (session) {
    return redirect("/dashboard")
  }

  const [listings, stars] = await Promise.all([
    fetchStoreListing(db).browseQuery({}).limit(MARQUEE_LIMIT).execute(),
    repositoryStars(),
  ])

  return (
    <>
      <Hero stars={stars} />

      <AppMarquee listings={listings} />

      <AlternatingRow
        eyebrow="Personalization"
        title="Change an app instead of building one."
        diagram={<PersonalizeFlow />}
      >
        <p>
          The first version already exists and already works. You add the one thing it was missing,
          in a sentence.
        </p>
      </AlternatingRow>

      <AlternatingRow
        eyebrow="Data ownership"
        title="The database has your name on it."
        diagram={<OwnershipDiagram />}
        flip
      >
        <p>
          Every app you run writes into one Postgres you can open. Asking a question that spans two
          of them is a join — and leaving is a copy, not a project.
        </p>
        <p className="text-base">
          It works from the other side too. A consumer app can sign people in with SproutOS and
          write into <span className="text-foreground">the user's own database</span> — so the user
          keeps their full history and a cheap exit, and the developer still charges for the app.
          Low switching costs are what let a better product win.
        </p>
        <p className="flex flex-wrap gap-5 text-base">
          <Link
            href="/blog/health-data-you-can-join"
            className="font-medium text-primary hover:underline"
          >
            The question three health apps can't answer →
          </Link>
          <Link
            href="/blog/hand-back-the-data"
            className="font-medium text-primary hover:underline"
          >
            Hand back the data, still charge for the app →
          </Link>
        </p>
      </AlternatingRow>

      <AlternatingRow
        eyebrow="What it costs"
        title="You only get charged for usage."
        diagram={<IdleCostDiagram />}
      >
        <p>
          And almost nothing is happening, almost all of the time. The gap is not a discount — it is
          that everywhere else you pay for the hours nobody used.
        </p>
        <p className="text-xs">
          Comparison is the published list price for the smallest always-on RDS, ElastiCache and
          OpenSearch AWS sells in us-east-1, read from the AWS pricing API in August 2026.
        </p>
      </AlternatingRow>

      <Platform />

      <AlternatingRow
        eyebrow="Fork maintenance"
        title="Your personalized app keeps up to date with the original."
        diagram={<UpkeepDiagram />}
        flip
      >
        <p>
          When the app you started from ships a fix or a new feature, it arrives in your copy — on a
          schedule you pick, without undoing anything you changed.
        </p>
        <p className="text-base">
          The technical name for this is <span className="text-foreground">fork maintenance</span>,
          and it is the part nobody wants to do. SproutOS merges upstream into your copy for you,
          and opens a pull request on the rare occasion the two genuinely disagree.
        </p>
      </AlternatingRow>

      <Automations />

      <Teasers />

      <FinalCta />
    </>
  )
}
