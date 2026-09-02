import { describe, expect, it } from "vitest"
import { buildMarqueeSequence, type MarqueeListing } from "./app-marquee"

const LISTINGS: MarqueeListing[] = [
  {
    id: "umami",
    slug: "umami",
    name: "Umami",
    tagline: "Privacy-focused analytics.",
    upstreamOwner: "umami-software",
    upstreamRepo: "umami",
    licenseSpdx: "MIT",
  },
  {
    id: "memos",
    slug: "memos",
    name: "Memos",
    tagline: "Privacy-first notes.",
    upstreamOwner: "usememos",
    upstreamRepo: "memos",
    licenseSpdx: "MIT",
  },
]

describe("AppMarquee", () => {
  it("fills both halves when the catalogue is shorter than the viewport", () => {
    const sequence = buildMarqueeSequence(LISTINGS)

    expect(sequence).toHaveLength(12)
    expect(sequence.map(({ listing }) => listing.id)).toEqual([
      "umami",
      "memos",
      "umami",
      "memos",
      "umami",
      "memos",
      "umami",
      "memos",
      "umami",
      "memos",
      "umami",
      "memos",
    ])
  })
})
