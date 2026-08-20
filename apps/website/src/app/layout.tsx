import "./globals.css"
import { ClientProviders } from "@website/components/ClientProviders"
import type { Metadata } from "next"

export const metadata: Metadata = {
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
