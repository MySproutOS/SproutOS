import { usePlaceholderQuery } from "@frontends/dashboard/data/placeholder"

export type StoreListing = {
  slug: string
  name: string
  glyph: string
  tagline: string
  author: string
  installs: string
  estimatedMonthlyCostMicros: bigint
  tags: string[]
}

export type StoreListingDetail = StoreListing & {
  description: string
  repo: string
  version: string
  requires: string[]
}

const LISTINGS: StoreListing[] = [
  {
    slug: "recipe-box",
    name: "Recipe Box",
    glyph: "🍲",
    tagline: "A private recipe site with photo upload and a weekly shopping list.",
    author: "andrew-chen-wang",
    installs: "1,204",
    estimatedMonthlyCostMicros: 400_000n,
    tags: ["Postgres", "Auth"],
  },
  {
    slug: "imessage-rag",
    name: "Message Search",
    glyph: "💬",
    tagline: "Full-text and semantic search over an exported message archive.",
    author: "andrew-chen-wang",
    installs: "842",
    estimatedMonthlyCostMicros: 2_100_000n,
    tags: ["OpenSearch", "Workflows"],
  },
  {
    slug: "csm-automations",
    name: "Client Follow-ups",
    glyph: "📮",
    tagline: "Watches a shared inbox and drafts follow-ups on a schedule.",
    author: "acme-co",
    installs: "377",
    estimatedMonthlyCostMicros: 350_000n,
    tags: ["Queue", "Email"],
  },
  {
    slug: "weekly-digest",
    name: "Weekly Digest",
    glyph: "📊",
    tagline: "Rolls up the week's numbers and mails a single summary on Mondays.",
    author: "andrew-chen-wang",
    installs: "265",
    estimatedMonthlyCostMicros: 50_000n,
    tags: ["Workflows", "Email"],
  },
]

/** PLACEHOLDER — swap for `getV1StoreListingOptions()`. */
export function useStoreListings() {
  return usePlaceholderQuery(["store", "listings"], LISTINGS)
}

/** PLACEHOLDER — swap for `getV1StoreListingBySlugOptions({ path: { slug } })`. */
export function useStoreListing(slug: string) {
  const base = LISTINGS.find((listing) => listing.slug === slug) ?? LISTINGS[0]
  const detail: StoreListingDetail = {
    ...base,
    slug,
    description:
      "Forking this listing copies the repository into your organization, provisions the resources it declares, and deploys it. Upstream releases show up as an update you choose to take.",
    repo: `${base.author}/${base.slug}`,
    version: "v3",
    requires: base.tags,
  }
  return usePlaceholderQuery(["store", "listings", slug], detail)
}
