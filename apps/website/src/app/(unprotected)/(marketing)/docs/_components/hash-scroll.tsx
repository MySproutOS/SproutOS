"use client"

import { useEffect } from "react"

/**
 * Land on the section a deep link asked for.
 *
 * Loading `/docs/github-action#deployment-templates` cold leaves the page at the top: the browser
 * begins the jump, `scroll-behavior: smooth` turns it into an animation, and hydration cancels the
 * animation before it arrives. Measured on a cold tab, the target sat 2,911px down and the page
 * stayed at 0.
 *
 * That is the failure mode that matters most for documentation. Section anchors are what a search
 * engine offers as "jump to" links and what people paste to each other, and every one of them was
 * landing on the introduction instead of the answer.
 *
 * So the scroll is re-applied once, after hydration, explicitly instant — `behavior: "instant"`
 * overrides the inherited smooth, because re-animating a jump the reader did not ask to watch is
 * the same bug wearing a nicer coat. `scrollIntoView` honours the heading's `scroll-mt-24`, so the
 * heading clears the fixed header rather than hiding behind it.
 *
 * A second pass after the webfonts settle: Bricolage and Geist change line heights when they swap
 * in, which moves every heading below the fold by enough to matter.
 */
export function HashScroll() {
  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash === "") return

    const scrollToTarget = () => {
      // `getElementById` rather than `querySelector`: a heading id can start with a digit, which is
      // valid HTML and an invalid CSS selector.
      const target = document.getElementById(decodeURIComponent(hash))
      target?.scrollIntoView({ behavior: "instant", block: "start" })
    }

    scrollToTarget()

    let cancelled = false
    void document.fonts?.ready.then(() => {
      if (!cancelled) scrollToTarget()
    })
    return () => {
      cancelled = true
    }
  }, [])

  return null
}
