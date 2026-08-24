import { DocSearch } from "./_components/search"

export const metadata = { title: "Documentation · SproutOS" }

/**
 * The docs index.
 *
 * Statically rendered: the content is a TypeScript module, so there is nothing to fetch and no
 * reason for a visitor to wait on a server. The search below is the only client component.
 */
export default function DocsPage() {
  return (
    <main className="container-page py-16">
      <h1 className="text-3xl font-semibold">Documentation</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        How your application runs here, what it costs, and the handful of things that are different
        from a server you rent by the month.
      </p>

      <div className="mt-10 max-w-2xl">
        <DocSearch />
      </div>
    </main>
  )
}
