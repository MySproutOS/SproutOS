"use client"

import { SproutMark } from "@website/components/icons"
import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { useEffect, useState } from "react"

const LINKS = [
  { href: "#app-store", label: "App store" },
  { href: "#business", label: "For teams" },
  { href: "#backend", label: "What you get" },
  { href: "#ownership", label: "Your data" },
]

/**
 * `homeHref` is "" on the landing page, where the section links are same-page anchors, and "/"
 * everywhere else, where they have to navigate home first or they scroll to nothing.
 */
export function Nav({ homeHref = "" }: { homeHref?: string }) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 12)
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll)
    }
  }, [])

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? "border-b rule-soft bg-background/85 backdrop-blur-md"
          : "border-b border-transparent"
      }`}
    >
      <nav className="container-page flex h-16 items-center justify-between gap-6">
        <a
          href={homeHref === "" ? "#top" : homeHref}
          className="flex items-center gap-2.5 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <SproutMark className="size-6 text-primary" />
          <span className="font-display text-[1.0625rem] font-semibold tracking-tight">
            SproutOS
          </span>
        </a>

        <div className="hidden items-center gap-7 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={`${homeHref}${link.href}`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </div>

        <LoginWithGitHubButton size="sm" withArrow={false} />
      </nav>
    </header>
  )
}
