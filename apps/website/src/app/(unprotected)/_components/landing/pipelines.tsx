import { Reveal } from "@ui/spa-shared/reveal"

export function Pipelines() {
  return (
    <section id="pipelines" className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page grid gap-14 lg:grid-cols-[0.95fr_1.05fr] lg:items-start lg:gap-20">
        <Reveal>
          <p className="eyebrow mb-4">Sites & workflows</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Like Lovable and n8n, minus the trapdoor.
          </h2>
          <p className="mt-5 text-muted-foreground text-pretty">
            We host sites the way Lovable and OpenAI Sites do, and workflows the way n8n does. The
            difference is that the code stays open source and the infrastructure has no way to hold
            it hostage. If you care about privacy, personalization, and owning your data, the fork
            maintenance and the app store are the reason to be here.
          </p>
        </Reveal>

        <Reveal delay={100} className="rounded-2xl border rule-soft bg-card/60 p-7 sm:p-9">
          <p className="eyebrow mb-4">Worked example</p>
          <h3 className="font-display text-xl font-semibold tracking-tight text-balance">
            Search your iMessage history and actually find things.
          </h3>
          <p className="mt-4 text-sm text-muted-foreground text-pretty">
            iMessage search has a deservedly bad reputation. Sprout's community skills encode how
            top startups actually build retrieval — fine-tuned embeddings, a knowledge graph
            alongside the vector store, and real judgment about what to ingest — not a single
            embedding model pointed at a pile of text.
          </p>
          <p className="mt-4 text-sm text-muted-foreground text-pretty">
            Sprout builds the search site and stands up the backend services behind it, cheaply, and
            the results are better.
          </p>
          <a
            href="https://blog.bytebytego.com/p/why-doordash-instacart-and-uber-eats"
            target="_blank"
            rel="noreferrer noopener"
            className="mt-6 inline-flex items-center gap-1.5 rounded-md font-mono text-xs text-primary underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            How DoorDash, Instacart and Uber Eats build retrieval ↗
          </a>
        </Reveal>
      </div>
    </section>
  )
}
