import { COMPANY, LegalPage, Section } from "../_components/legal-page"

export const metadata = { title: "Privacy Policy · SproutOS" }

/*
  Describes where data actually goes, including the parts that are inconvenient: tenant search and
  queue data sits on a rented machine in France, runtime logs pass through Kafka into ClickHouse on
  that same machine, and source code reaches a model provider whenever an agent runs.

  A privacy policy that omits a real data flow is not a shorter policy, it is a false one. Needs
  review by a lawyer before launch, particularly the cross-border transfer language.
*/
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      summary="What we collect, where it goes, and how long we keep it."
    >
      <Section heading="Who is responsible">
        <p>
          {COMPANY.name}, {COMPANY.address}, is the controller of the personal data described here.
          Questions and requests go to {COMPANY.contact}.
        </p>
      </Section>

      <Section heading="What we collect about you">
        <p>
          <strong className="text-foreground">Account information.</strong> Your name, email address
          and avatar, from GitHub or Google when you sign in. We store an identifier from that
          provider so we recognise you next time, and an access token so we can act on repositories
          you have authorised. Tokens are encrypted at rest.
        </p>
        <p>
          <strong className="text-foreground">Billing information.</strong> Purchases, credit
          balance and usage. Card details are handled by Stripe and never reach our servers.
        </p>
        <p>
          <strong className="text-foreground">Usage records.</strong> Metered consumption per
          project — compute time, stored bytes, queue memory, search and transfer — which is what
          your bill is computed from.
        </p>
        <p>
          <strong className="text-foreground">Audit records.</strong> Security-relevant actions:
          signing in, revealing a secret, changing permissions, deleting a project. These include
          the IP address and browser the action came from.
        </p>
      </Section>

      <Section heading="What we hold on your behalf">
        <p>
          Your source code, your databases, your queues, your search indexes and your uploaded
          files. We process these to run your projects. We do not read them except where we must to
          operate the service or where you ask us to — for example when an agent modifies your code.
        </p>
        <p>
          If your users&rsquo; personal data ends up in a database we host, you are its controller
          and we are your processor. You are responsible for having a lawful basis to hold it.
        </p>
      </Section>

      <Section heading="Where your data physically is">
        <p>
          <strong className="text-foreground">United States.</strong> Our control-plane database,
          your applications when they run, object storage, and the cache that routes requests.
        </p>
        <p>
          <strong className="text-foreground">France.</strong> Tenant search indexes, tenant queues,
          and runtime logs, on a machine we rent. Data therefore crosses between the United States
          and the European Union in normal operation.
        </p>
        <p>
          <strong className="text-foreground">Elsewhere, if you choose it.</strong> Selecting a
          model provider for the agent features sends code to that provider&rsquo;s infrastructure
          under their terms.
        </p>
      </Section>

      <Section heading="Runtime logs">
        <p>
          Output from your running applications is collected so you can search it in your dashboard.
          It is kept for <strong className="text-foreground">three days</strong> and then deleted
          automatically. If your application logs personal data, that is what will be stored — the
          three-day limit exists partly for that reason.
        </p>
      </Section>

      <Section heading="How long we keep the rest">
        <p>
          Account and billing records are kept while your account exists and afterwards for as long
          as tax and accounting law requires. Audit records are kept for the same reason.
        </p>
        <p>
          Project data is deleted when you delete the project, and 48 hours after your credit runs
          out — see the Terms for exactly how that works.
        </p>
      </Section>

      <Section heading="Who else sees it">
        <p>
          Stripe processes payments. Amazon Web Services and OVH provide infrastructure. GitHub and
          Google provide sign-in. Anthropic, OpenAI or OpenRouter receive code when you use the
          agent features. Amazon Simple Email Service delivers our email.
        </p>
        <p>We do not sell your data, and we do not use it to train models.</p>
      </Section>

      <Section heading="Your rights">
        <p>
          You can ask for a copy of your data, correct it, or have it deleted. The dashboard exports
          your data and deletes your projects without needing to ask us. For anything it does not
          cover, write to {COMPANY.contact} and we will respond within 30 days.
        </p>
        <p>
          If you are in the European Union or the United Kingdom you may also complain to your data
          protection authority. If you are in California you have rights under the CCPA, including
          the right not to be discriminated against for exercising them.
        </p>
      </Section>

      <Section heading="Cookies">
        <p>
          We set a session cookie when you sign in, and short-lived cookies during sign-in to
          prevent request forgery. That is all — no advertising or analytics cookies.
        </p>
      </Section>

      <Section heading="Security, and its limits">
        <p>
          Credentials are encrypted at rest and connection secrets are stored as one-way hashes
          where the protocol permits it, so a database leak does not yield anything usable. Access
          between tenants is mediated by proxies that check ownership on every request.
        </p>
        <p>
          No system is perfectly secure. If we discover a breach affecting your personal data we
          will tell you and the relevant authority within the time the law requires.
        </p>
      </Section>

      <Section heading="Children">
        <p>
          SproutOS is not intended for anyone under 16, and we do not knowingly collect their data.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          We will post changes here and update the date at the top, and tell you before a material
          change takes effect.
        </p>
      </Section>
    </LegalPage>
  )
}
