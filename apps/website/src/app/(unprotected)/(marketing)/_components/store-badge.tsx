import { AndroidMark, SproutMark } from "@website/components/icons"
import Link from "next/link"
import type { ReactNode } from "react"

/*
  The two front doors, as badges.

  Shaped like the app-store badges people already recognise — a mark, a small line over a larger one
  — because that shape is what tells someone at a glance that this is where you get the thing.

  What it deliberately is not is a Google Play badge. The Android client is not on Play (see
  `/download`, which walks through the sideload permission), so a Play badge would be a lie in the
  most legible position on the page.
*/

function Badge({
  href,
  icon,
  over,
  under,
  tone = "outline",
  external = false,
}: {
  href: string
  icon: ReactNode
  over: string
  under: string
  tone?: "outline" | "filled"
  external?: boolean
}) {
  const className = [
    "inline-flex items-center gap-3.5 rounded-2xl px-5 py-3 transition-colors",
    "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
    tone === "filled"
      ? "bg-primary text-primary-foreground hover:bg-primary/85"
      : "border border-border bg-card text-foreground hover:bg-secondary",
  ].join(" ")

  const content = (
    <>
      <span className={tone === "filled" ? "" : "text-primary"}>{icon}</span>
      <span className="flex flex-col text-left leading-tight">
        <span
          className={`font-mono text-[0.625rem] tracking-[0.12em] uppercase ${
            tone === "filled" ? "opacity-75" : "text-muted-foreground"
          }`}
        >
          {over}
        </span>
        <span className="font-display text-[1.0625rem] font-semibold tracking-tight">{under}</span>
      </span>
    </>
  )

  if (external) {
    return (
      <a href={href} className={className}>
        {content}
      </a>
    )
  }
  return (
    <Link href={href} className={className}>
      {content}
    </Link>
  )
}

export function StoreBadge({ tone }: { tone?: "outline" | "filled" }) {
  return (
    <Badge
      href="/store"
      icon={<SproutMark className="size-6" />}
      over="Browse the"
      under="SproutOS Store"
      tone={tone}
    />
  )
}

/**
 * `href` is the APK when there is a published build, and `/download` otherwise — the download page
 * is where the checksums and the permission walkthrough live, so sending somebody there is never
 * the wrong answer.
 */
export function AndroidBadge({
  href = "/download",
  tone = "outline",
  external = false,
}: {
  href?: string
  tone?: "outline" | "filled"
  external?: boolean
}) {
  return (
    <Badge
      href={href}
      icon={<AndroidMark className="size-6" />}
      over={external ? "Download for" : "Get it for"}
      under="Android"
      tone={tone}
      external={external}
    />
  )
}
