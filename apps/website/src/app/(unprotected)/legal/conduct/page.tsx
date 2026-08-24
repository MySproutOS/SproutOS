import { COMPANY, LegalPage, Section } from "../_components/legal-page"

export const metadata = { title: "Code of Conduct · SproutOS" }

export default function ConductPage() {
  return (
    <LegalPage
      title="Community Code of Conduct"
      summary="SproutOS hosts a shared catalogue and publishes apps under our name. This is what that requires of everyone using it."
    >
      <Section heading="Why this exists">
        <p>
          Most of SproutOS is private: your projects, your data, your databases. Two parts are not.
          The catalogue is shared, and Android apps built here are signed with our key and
          distributed under our name. Those parts need rules, and this is them.
        </p>
      </Section>

      <Section heading="What we expect">
        <p>
          Be accurate about what your project does. Credit the open-source work you build on and
          respect its licence. Assume the person reading your listing has less context than you do.
        </p>
      </Section>

      <Section heading="What is not allowed">
        <p>
          Content that harasses, threatens or demeans people. Content that sexualises minors.
          Malware, credential harvesting, or anything designed to deceive the person installing it.
          Material you have no right to distribute. Deliberate misrepresentation of what an app does
          or what it collects.
        </p>
        <p>
          An app that quietly collects more than it says it does is the clearest case here, and the
          one we will act on fastest.
        </p>
      </Section>

      <Section heading="How we enforce it">
        <p>
          We review Android apps before publication, because {COMPANY.name} is the developer of
          record for every one of them and is accountable for what they contain. We also act on
          reports about catalogue listings.
        </p>
        <p>
          Depending on what we find we may ask you to change something, remove a listing, unpublish
          an app, or close an account. We will tell you what the problem was and, where it is
          fixable, give you the chance to fix it. Where the law requires us to act immediately, we
          will.
        </p>
      </Section>

      <Section heading="Reporting something">
        <p>
          Write to {COMPANY.contact} with a link and what you believe is wrong. If you are reporting
          a security vulnerability, say so in the subject line and give us a way to reach you — we
          will not pursue anyone acting in good faith to report one.
        </p>
      </Section>
    </LegalPage>
  )
}
