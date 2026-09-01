import { formatPostDate, POSTS } from "@website/lib/blog"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Blog · SproutOS",
  description:
    "Short pieces on owning your data, personalizing software, and what it costs to run any of it.",
  alternates: { canonical: "/blog" },
}

export default function BlogPage() {
  return (
    <div className="container-page py-16">
      <p className="eyebrow mb-4">Blog</p>
      <h1 className="max-w-3xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
        Writing about owning your data.
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-muted-foreground text-pretty">
        Short pieces, one idea each.
      </p>

      {POSTS.length === 0 ? (
        <p className="mt-12 text-sm text-muted-foreground">Nothing published yet.</p>
      ) : (
        <ul className="mt-12 grid gap-5 lg:grid-cols-2">
          {POSTS.map((post) => (
            <li
              key={post.slug}
              className="relative rounded-2xl border rule-soft bg-card/60 p-7 transition-colors hover:border-primary/40"
            >
              <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
                <span className="eyebrow">{post.audience}</span>
                <span className="rounded border rule-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-[0.1em] uppercase text-muted-foreground">
                  {post.kind}
                </span>
              </div>
              <h2 className="font-display text-xl font-semibold tracking-tight text-balance">
                <Link href={`/blog/${post.slug}`} className="before:absolute before:inset-0">
                  {post.title}
                </Link>
              </h2>
              <p className="mt-3 text-sm text-muted-foreground text-pretty">{post.summary}</p>
              <p className="mt-5 font-mono text-xs text-muted-foreground">
                <time dateTime={post.date}>{formatPostDate(post.date)}</time>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
