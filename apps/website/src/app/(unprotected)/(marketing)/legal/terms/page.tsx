import { COMPANY, LegalPage, Section } from "../_components/legal-page"

export const metadata = { title: "Terms of Service · SproutOS" }

/*
  Written to describe what SproutOS actually does, not to be generically defensible.

  Every clause corresponds to a real behaviour of the platform — prepaid credits drawn down by
  metered usage, service stopping before the balance goes negative, deletion forty-eight hours after
  that, code sent to third-party model providers when an agent runs, and SproutOS signing every
  Android app as developer of record. A term describing something the platform does not do is worse
  than no term: it is a promise nobody is keeping.

  **This needs review by a lawyer before launch.** It is an honest description of the service by the
  people building it, which is the right raw material for that review and not a substitute for it.
*/
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      summary="What you can expect from SproutOS, and what we expect from you."
    >
      <Section heading="Who we are">
        <p>
          SproutOS is operated by {COMPANY.name}, {COMPANY.address}. These terms are an agreement
          between you and {COMPANY.name}. You can reach us at {COMPANY.contact}.
        </p>
      </Section>

      <Section heading="What the service is">
        <p>
          SproutOS runs applications and backend services on your behalf. You bring code — usually
          by forking an open-source project from our catalogue or connecting your own repository —
          and we build it, run it, and give it a database, a queue, a search index and object
          storage as you need them.
        </p>
        <p>
          Your code and your data remain yours. We hold them in order to run the service you asked
          for, and we claim no ownership of either.
        </p>
      </Section>

      <Section heading="Credits, and what happens when they run out">
        <p>
          SproutOS is prepaid. You buy credits and metered usage draws them down: compute time,
          storage, queue memory, search, and data transfer. The minimum purchase is $1. Prices are
          published in your dashboard before you spend anything.
        </p>
        <p>
          On top of usage we charge a percentage covering payment processing, tax where it applies,
          and the cost of operating the platform. Payment processing is shown as its own line rather
          than folded into the price.
        </p>
        <p>
          <strong className="text-foreground">We stop before you go negative.</strong> When we
          project that continuing would take your balance past zero, we stop serving your projects.
          We do not let a balance run negative and then invoice you for it.
        </p>
        <p>
          You may enable automatic top-up and set a ceiling on how much we may charge beyond your
          balance. We will not charge past that ceiling for any reason, including to prevent the
          deletion described below.
        </p>
      </Section>

      <Section heading="Deletion after non-payment">
        <p>
          If your credit runs out, your projects stop serving immediately and your data is retained
          for <strong className="text-foreground">48 hours</strong>. After that it is deleted from
          every backend and cannot be recovered.
        </p>
        <p>
          Before deleting anything we check your balance again, and if you have enabled automatic
          top-up we attempt that charge first. Adding credit at any point during those 48 hours
          stops the deletion. We notify you when service stops and again before the deadline.
        </p>
      </Section>

      <Section heading="AI features send your code to third parties">
        <p>
          When you ask an agent to modify a project, or when we analyse a repository you are
          forking, the relevant source code and configuration are sent to the model provider you
          selected — Anthropic, OpenAI, or OpenRouter — under that provider&rsquo;s terms. If you
          supply your own API key, the request is billed to you by them directly.
        </p>
        <p>
          If you would rather no code left the platform, do not use the agent features. Everything
          else works without them.
        </p>
      </Section>

      <Section heading="Repository access">
        <p>
          Signing in with GitHub grants us only your identity and email address. Creating or forking
          a repository requires broader permission, which we ask for separately at the point you
          need it and never at sign-up.
        </p>
      </Section>

      <Section heading="Android apps published through SproutOS">
        <p>
          Apps built on SproutOS are signed with our key and distributed from our store.{" "}
          <strong className="text-foreground">
            {COMPANY.name} is the developer of record for every app published this way.
          </strong>{" "}
          That is what allows you to publish without your own developer account.
        </p>
        <p>
          Because we are accountable for what is distributed under our name, we review apps before
          publication and may refuse or remove any app. You remain responsible to us for what you
          publish, including for having the right to publish it.
        </p>
      </Section>

      <Section heading="What you may not do">
        <p>
          Do not use SproutOS to break the law, to attack anyone, to send unsolicited bulk mail, to
          mine cryptocurrency, to host material you have no right to distribute, or to work around
          the metering. Do not use it to store other people&rsquo;s data without their knowledge.
        </p>
        <p>
          We may suspend an account doing these things. Where we can, we will tell you what the
          problem is and give you a chance to fix it.
        </p>
      </Section>

      <Section heading="Availability, and the honest version of it">
        <p>
          We do not offer a service-level agreement. SproutOS runs on infrastructure we rent, some
          of it on single machines without redundancy, and it will have outages. If uptime is
          critical to your business, that is worth knowing before you build on us rather than after.
        </p>
        <p>
          We take backups of the databases we manage. We do not guarantee that any particular backup
          exists or can be restored, and you should keep your own copy of anything you cannot lose.
        </p>
      </Section>

      <Section heading="Liability">
        <p>
          The service is provided as it is, without warranties of any kind. To the fullest extent
          the law allows, {COMPANY.name} is not liable for lost profits, lost data, or indirect or
          consequential damages, and our total liability is limited to what you paid us in the three
          months before the claim.
        </p>
      </Section>

      <Section heading="Ending the agreement">
        <p>
          You can stop using SproutOS at any time and delete your projects from the dashboard.
          Unused credit is not refundable except where the law requires it. We may end this
          agreement if you break these terms, and will give you notice and an opportunity to export
          your data unless doing so would be unlawful or harmful.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          We will post changes here and update the date at the top. If a change materially reduces
          what you get, we will tell you before it takes effect.
        </p>
      </Section>

      <Section heading="Governing law">
        <p>
          These terms are governed by the laws of the State of Michigan, United States, without
          regard to its conflict-of-laws rules.
        </p>
      </Section>
    </LegalPage>
  )
}
