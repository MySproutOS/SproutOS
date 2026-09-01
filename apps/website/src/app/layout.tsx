import "./globals.css"
import { ClientProviders } from "@website/components/ClientProviders"
import type { Metadata } from "next"

/**
 * Canonical and Open Graph URLs are written relative — `alternates.canonical: "/personalize"` — and
 * Next only resolves those to absolute URLs when it has a base. Without this the store listing
 * pages have been emitting relative `og:url` values, which crawlers do not follow.
 */
export const siteOrigin = process.env.NEXT_PUBLIC_HOST_URL ?? "http://localhost:3000"

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: "SproutOS — make an app yours, own the data",
  description:
    "Start from an open source app that already works, say in a sentence what you want changed, and SproutOS deploys it with a database that belongs to you — for a few cents a month. No code.",
  openGraph: {
    title: "SproutOS — make an app yours, own the data",
    description:
      "Personalize an app that already works, keep your own database, and deploy it for a few cents a month. No code, no lock-in.",
    type: "website",
  },
}

// Scroll reveals only hide content once we know scripting is available; without
// this class every revealed section would stay invisible with JS disabled.
const JS_GATE = { __html: "document.documentElement.classList.add('js')" }

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={JS_GATE} />
      </head>
      <body>
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  )
}
