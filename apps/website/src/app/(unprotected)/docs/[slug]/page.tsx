import Link from "next/link"
import { notFound } from "next/navigation"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { DOCS, docBySlug } from "@website/lib/docs"

const MARKDOWN_PLUGINS = [remarkGfm]

/** Statically rendered, one file per page: there is nothing here a server needs to decide. */
export function generateStaticParams() {
  return DOCS.map((doc) => ({ slug: doc.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const doc = docBySlug(slug)
  return {
    title: doc === undefined ? "Documentation · SproutOS" : `${doc.title} · SproutOS`,
    description: doc?.summary,
  }
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const doc = docBySlug(slug)
  if (doc === undefined) notFound()

  return (
    <main className="container-page py-16">
      <Link href="/docs" className="font-mono text-xs text-muted-foreground hover:text-primary">
        ← Documentation
      </Link>

      <h1 className="mt-6 text-3xl font-semibold">{doc.title}</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">{doc.summary}</p>

      <div className="prose prose-neutral mt-10 max-w-2xl dark:prose-invert prose-headings:font-display prose-a:text-primary">
        <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{doc.content}</ReactMarkdown>
      </div>
    </main>
  )
}
