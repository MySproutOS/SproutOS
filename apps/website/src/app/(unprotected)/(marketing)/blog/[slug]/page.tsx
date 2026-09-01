import Markdoc from "@markdoc/markdoc"
import { siteOrigin } from "@website/app/layout"
import { formatPostDate, type Post, POSTS, postBySlug } from "@website/lib/blog"
import { postContent } from "@website/lib/blog-content"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import React from "react"
import { MARKDOC_COMPONENTS } from "../../docs/_components/markdoc-components"

export function generateStaticParams() {
  return POSTS.map((post) => ({ slug: post.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const post = postBySlug(slug)
  if (post === undefined) return { title: "Blog · SproutOS" }

  const url = `/blog/${post.slug}`
  return {
    title: `${post.title} · SproutOS`,
    description: post.summary,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.summary,
      url,
      publishedTime: post.date,
    },
  }
}

/**
 * `BlogPosting` plus a breadcrumb.
 *
 * `kind` rides along as `genre` — the posts are worked examples rather than customer stories, and
 * saying so in the structured data costs nothing and keeps the claim consistent with the badge a
 * reader sees.
 */
function structuredData(post: Post) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": `${siteOrigin}/blog/${post.slug}`,
        headline: post.title,
        description: post.summary,
        datePublished: post.date,
        genre: post.kind,
        inLanguage: "en",
        isPartOf: { "@type": "Blog", "@id": `${siteOrigin}/blog`, name: "SproutOS Blog" },
        publisher: { "@type": "Organization", name: "SproutOS", url: siteOrigin },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Blog", item: `${siteOrigin}/blog` },
          { "@type": "ListItem", position: 2, name: post.title },
        ],
      },
    ],
  }
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = postBySlug(slug)
  if (post === undefined) notFound()

  const content = postContent(post.slug)
  if (content === undefined) notFound()

  const body = Markdoc.renderers.react(content, React, { components: MARKDOC_COMPONENTS })

  return (
    <article className="container-page py-16">
      <script
        type="application/ld+json"
        // Built from front matter above; no post body reaches this as markup.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData(post)) }}
      />

      <Link href="/blog" className="font-mono text-xs text-muted-foreground hover:text-primary">
        ← Blog
      </Link>

      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <span className="eyebrow">{post.audience}</span>
        <span className="rounded border rule-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-[0.1em] uppercase text-muted-foreground">
          {post.kind}
        </span>
      </div>

      <h1 className="mt-4 max-w-3xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {post.title}
      </h1>
      <p className="mt-3 max-w-2xl text-lg text-muted-foreground text-pretty">{post.summary}</p>
      <p className="mt-4 font-mono text-xs text-muted-foreground">
        <time dateTime={post.date}>{formatPostDate(post.date)}</time>
      </p>

      <div className="prose prose-neutral mt-12 max-w-2xl dark:prose-invert prose-headings:font-display prose-a:text-primary prose-code:before:content-none prose-code:after:content-none">
        {body}
      </div>

      <p className="mt-14 max-w-2xl border-t rule-soft pt-6 text-sm text-muted-foreground text-pretty">
        This describes how the platform works rather than a deployment we have run. When there is a
        customer story to tell, it will say so.
      </p>
    </article>
  )
}
