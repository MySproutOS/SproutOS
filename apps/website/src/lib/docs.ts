/**
 * The documentation, as data.
 *
 * TypeScript modules rather than MDX files, because every page here is prose and headings — no
 * components, no imports, no runtime. MDX would add a compiler to the build and a second syntax to
 * get wrong for a benefit nothing on this page uses.
 *
 * The shape is deliberately flat so the search index below is derived from it rather than
 * maintained beside it: a search that misses a page nobody remembered to index is worse than no
 * search, because it answers confidently.
 */

export type DocSection = {
  heading: string
  /** Paragraphs. A string is prose; an array of strings is a bulleted list. */
  body: (string | string[])[]
}

export type Doc = {
  slug: string
  title: string
  /** One sentence, shown in the index and used by search. */
  summary: string
  sections: DocSection[]
}

export const DOCS: Doc[] = [
  {
    slug: "background-workers",
    title: "Background workers and open connections",
    summary:
      "Why a worker that holds a connection open keeps costing you money after its work is done.",
    sections: [
      {
        heading: "How a worker starts",
        body: [
          'When something is added to one of your queues, SproutOS invokes your application with an event rather than an HTTP request. The event carries a `sproutos` object with `kind: "queue.drain"`, the queue name, and how many jobs to take. Your handler reads it, does the work, and returns.',
          "It is the same function that serves your web traffic. There is no separate worker to deploy and no second copy of your code to keep in step — a background job runs exactly what a request runs, which is what makes a bug in one reproducible in the other.",
        ],
      },
      {
        heading: "Return when the work is done, not when the connection closes",
        body: [
          "This is the single most expensive mistake you can make here, and it is easy to make by accident.",
          "You are billed for the time your function is running, measured in GB-seconds. A function is running until its handler returns — not until it stops doing useful work. If your handler finishes its jobs and then waits on a database connection, a Redis subscription, an open socket, or a timer, you are paying for every second of that wait at the same rate as the work itself.",
          "The usual shape is a worker library that connects, processes, and then keeps listening for more. That is correct on a server you rent by the month and wrong on a function you rent by the millisecond.",
          [
            "Close or release database connections before returning.",
            "Do not call `subscribe`, `BLPOP`, or any other blocking read after your jobs are done.",
            "Do not keep a `setInterval` or a health-check loop alive.",
            "If your framework has a graceful-shutdown hook, call it at the end of the handler.",
          ],
          "SproutOS invokes your function again the moment there is more work. Staying alive to wait for it does not make the next job faster — it only makes the last one longer.",
        ],
      },
      {
        heading: "What we do about it",
        body: [
          "Your function has a configured timeout, and an invocation that reaches it is stopped and billed for the time it used. That is a backstop, not a plan: a worker that idles for the full timeout on every job can cost many times what the work was worth.",
          "If your balance is nearly out, we stop waiting for slow invocations and answer the caller without them. We cannot stop the invocation itself — AWS provides no way to abort a Lambda in flight — so the cost is still incurred. Watching your own handler return promptly is the only real control.",
        ],
      },
    ],
  },
  {
    slug: "limits",
    title: "Limits",
    summary:
      "Timeouts, payload sizes, memory, and concurrency — what they are and what happens at the edge.",
    sections: [
      {
        heading: "Time",
        body: [
          "An invocation may run for at most 15 minutes. You choose the timeout for your project; anything longer than it is stopped and billed for the time used.",
          "If a job cannot finish in one invocation, split it: enqueue the remainder and return. A partially drained queue is invoked again immediately.",
        ],
      },
      {
        heading: "Size",
        body: [
          "A request or response body is limited to 6 MB. Larger payloads should go through object storage — upload to a key, pass the key.",
          "Your deployed application is limited to 250 MB unzipped. A build over 200 MB is refused before it is uploaded, with the size in the message, rather than by AWS several minutes later.",
        ],
      },
      {
        heading: "Memory and CPU",
        body: [
          "You choose memory between 128 MB and 10 GB. CPU is allocated in proportion — there is no separate CPU setting, and a function given more memory is faster as well as larger.",
          "This matters for cost in both directions. Doubling memory doubles the per-second rate, but if it more than halves the duration it is cheaper overall. It is worth measuring rather than guessing.",
        ],
      },
      {
        heading: "Concurrency",
        body: [
          "Invocations run in parallel, each in its own isolated environment. Two requests never share memory, and a global variable set by one is not visible to the other — but a variable set on a *cold start* is visible to every later request that reuses the same environment.",
          "Cache carefully: a connection pool built at module scope is reused and is usually what you want. A user's session stored the same way is a bug that only appears under load.",
        ],
      },
    ],
  },
  {
    slug: "billing",
    title: "How billing is computed",
    summary: "GB-seconds, requests, and what appears on your invoice.",
    sections: [
      {
        heading: "Compute",
        body: [
          "Compute is billed in GB-seconds: your configured memory in gigabytes, multiplied by the duration of each invocation in seconds. A 512 MB function running for one second costs half a GB-second.",
          "The duration used is the *billed* duration, which is rounded up to the nearest millisecond and, on a cold start, includes the time your application took to initialise. It is the same figure AWS bills us.",
          'We do not bill "active CPU" — the time your code spent computing rather than waiting. Some platforms do. We do not, because it is not how the underlying invoice works, and charging for one while paying for the other is a gap somebody has to cover.',
        ],
      },
      {
        heading: "Requests",
        body: ["Each invocation is one request, whether it came from a visitor or from a queue."],
      },
      {
        heading: "What is added on top",
        body: [
          "Two things, both shown as their own lines on your invoice rather than folded into the prices above:",
          [
            "Payment processing — what the card network charges, passed through at cost.",
            "Platform overhead — a percentage covering what it costs to run the platform around your application.",
          ],
          "Usage is metered below one cent, so line items are shown at full precision and the total is rounded up to the nearest cent. The lines will not sum to exactly the total, and the difference is that rounding.",
        ],
      },
      {
        heading: "Teams",
        body: [
          "A flat $4 per month applies once more than two people have committed to a private repository in your organization. Public repositories do not count, and neither do bots.",
          "If the fee is due and unpaid, you cannot launch new projects. Anything already running keeps running.",
        ],
      },
    ],
  },
  {
    slug: "connecting",
    title: "Connecting to your services",
    summary: "Postgres, Valkey, OpenSearch, and object storage — what you get and how to reach it.",
    sections: [
      {
        heading: "What a connection URI is",
        body: [
          "Provisioning a service returns a connection URI once. It is not shown again — store it in your project's environment variables, where your application reads it as it would any other secret.",
          "Every URI points at a SproutOS proxy rather than at the backend itself. You never hold a cloud credential, and we can move what is behind the proxy without your application changing.",
        ],
      },
      {
        heading: "Postgres",
        body: [
          "A standard `postgresql://` URI. Any driver works.",
          "Open connections in your handler and close them before returning, or use a pooler. A connection left open is time you are billed for — see Background workers.",
        ],
      },
      {
        heading: "Valkey and queues",
        body: [
          "A `redis://` URI. BullMQ must use the `keyPrefix` returned with the URI: `new Queue(name, { connection, prefix: process.env.BULLMQ_PREFIX })`. For project-attached services, SproutOS injects `BULLMQ_PREFIX` automatically alongside `REDIS_URL` and `VALKEY_URL`.",
          "Celery is unaffected and works without a prefix because its broker keys are ordinary Valkey keys rather than keys constructed inside Lua arguments.",
          "You do not need to run a worker process. Adding a job invokes your function; see Background workers for what the event looks like.",
        ],
      },
      {
        heading: "OpenSearch",
        body: [
          "An HTTPS endpoint with credentials in the URI. Index names are namespaced to you automatically — you use whatever names you like and cannot see or reach another tenant's indices.",
        ],
      },
      {
        heading: "Object storage",
        body: [
          "An S3-compatible endpoint. Configure your client with the access key, secret, region and endpoint from the URI, and set path-style addressing.",
          "Your bucket name is fixed and is part of the URI. Requests naming any other bucket are refused.",
        ],
      },
    ],
  },
]

export function docBySlug(slug: string): Doc | undefined {
  return DOCS.find((doc) => doc.slug === slug)
}

/**
 * The text a search matches against, derived from the page rather than written beside it.
 *
 * A hand-maintained index misses the page nobody remembered to add, and answers confidently while
 * missing it — which is worse than not searching at all.
 */
export function searchableText(doc: Doc): string {
  const body = doc.sections.flatMap((section) => [
    section.heading,
    ...section.body.flatMap((entry) => (Array.isArray(entry) ? entry : [entry])),
  ])

  return [doc.title, doc.summary, ...body].join(" ").toLowerCase()
}

export type DocMatch = { doc: Doc; heading?: string }

/**
 * Search the docs.
 *
 * Every term must appear, so adding a word narrows the results — which is what a person typing a
 * second word expects. Matching any term would make a longer query return more, and the page that
 * matched only "the" would rank alongside the one that answered the question.
 */
export function searchDocs(query: string): DocMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return DOCS.map((doc) => ({ doc }))

  return DOCS.filter((doc) => {
    const text = searchableText(doc)
    return terms.every((term) => text.includes(term))
  }).map((doc) => {
    // The first heading that matches, so a result can point at the part of the page that answered
    // rather than at the top of a long one.
    const heading = doc.sections.find((section) =>
      terms.every((term) => section.heading.toLowerCase().includes(term)),
    )?.heading
    return heading === undefined ? { doc } : { doc, heading }
  })
}
