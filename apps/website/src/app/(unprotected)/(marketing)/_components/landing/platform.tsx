import { Reveal, RevealItem } from "@ui/spa-shared/reveal"
import Link from "next/link"

/*
  What SproutOS actually is, for the reader who has scrolled this far and wants the noun.

  Comparisons are grouped rather than listed flat, because the three groups are not the same
  argument. The first two rent you capacity you size in advance. The third — Prefect, Step
  Functions — already meters by use, and pretending otherwise would be the kind of flattered
  comparison the pricing copy elsewhere on the site explicitly refuses. They are here because we do
  their job too, not because they bill badly.

  No prices are quoted for the second and third groups: the site's rule is dated list prices or
  none, and the only figures we have dated are the AWS ones on the idle-cost diagram.
*/

type Group = { label: string; entries: { name: string; detail: string }[] }

const GROUPS: Group[] = [
  {
    label: "Build and host",
    entries: [
      { name: "Vercel", detail: "a plan, plus $20 for each person who can deploy" },
      { name: "n8n", detail: "a box you keep upright, or a plan sized by executions" },
      { name: "Lovable", detail: "a subscription, and the backend is your problem" },
    ],
  },
  {
    label: "Managed data services",
    entries: [
      {
        name: "Elastic Cloud",
        detail: "a cluster you size in advance, billed while nobody searches",
      },
      { name: "Redis Cloud", detail: "a plan per database, priced by the memory you reserved" },
    ],
  },
  {
    label: "Cloud workflow platforms",
    entries: [
      { name: "Prefect", detail: "metered, but the compute your flows run on is a separate bill" },
      {
        name: "AWS Step Functions",
        detail:
          "priced per state transition, for wiring together services you still stand up yourself",
      },
    ],
  },
]

/** The unit each resource is metered by — the real billing dimensions, without the rates. */
const RESOURCES = [
  {
    name: "Web services",
    body: "Sites and APIs that run code — sessions, forms, a database call on page load. Cold start, or keep one warm.",
    unit: "REQUEST + GB-SECOND",
  },
  {
    name: "Background workers",
    body: "Async jobs on BullMQ in TypeScript and Rust, or Celery in Python. Schedules, queues, retries.",
    unit: "JOB + VCPU-SECOND",
  },
  {
    name: "Postgres",
    body: "A real Postgres with a connection string, not a wrapper. Suspends when idle, wakes on the next connection.",
    unit: "CU-HOUR + GB-MONTH",
  },
  {
    name: "Valkey",
    body: "Caching and queues, tenant-split with an engine-enforced identity rather than a key prefix everyone has to remember.",
    unit: "BYTE-SECOND QUEUED",
  },
  {
    name: "OpenSearch",
    body: "Search for when a LIKE query stops being enough. Nothing to size in advance.",
    unit: "QUERY + STORAGE",
  },
] as const

export function Platform() {
  return (
    <section className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">The platform</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            The cheapest place to run everything your app needs.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            Websites, background workers, workflows, Postgres, Valkey and search — one platform, one
            bill, metered by the second. It does the job of a hosting platform, an automation tool
            and a cloud workflow platform at once, and we have not found anyone who does it cheaper.
          </p>
        </Reveal>

        <Reveal delay={80} className="mt-10 flex flex-col gap-6">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <p className="eyebrow mb-3">{group.label}</p>
              <ul className="flex flex-wrap gap-3">
                {group.entries.map((entry) => (
                  <li
                    key={entry.name}
                    className="rounded-lg border rule-soft px-3.5 py-2 text-sm text-muted-foreground text-pretty"
                  >
                    <span className="text-foreground">vs {entry.name}</span> · {entry.detail}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Reveal>

        <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {RESOURCES.map((resource, i) => (
            <RevealItem
              key={resource.name}
              delay={i * 60}
              className="h-full rounded-2xl border rule-soft bg-card/60 p-6"
            >
              <h3 className="font-display text-[1.0625rem] font-semibold tracking-tight">
                {resource.name}
              </h3>
              <p className="mt-2.5 text-sm text-muted-foreground text-pretty">{resource.body}</p>
              <p className="mt-4 border-t rule-soft pt-3.5 font-mono text-[0.6875rem] tracking-[0.1em] text-leaf-dim">
                BILLED BY {resource.unit}
              </p>
            </RevealItem>
          ))}
          <RevealItem
            delay={RESOURCES.length * 60}
            className="flex h-full flex-col justify-center rounded-2xl border border-dashed rule-soft p-6"
          >
            <p className="text-sm text-muted-foreground text-pretty">
              No seat, no plan, no monthly floor. Credit is prepaid and drawn down; when it runs
              out, new work is refused rather than quietly billed.
            </p>
            <Link
              href="/docs/billing"
              className="mt-3.5 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:underline"
            >
              How billing works <span aria-hidden="true">→</span>
            </Link>
          </RevealItem>
        </ul>
      </div>
    </section>
  )
}
