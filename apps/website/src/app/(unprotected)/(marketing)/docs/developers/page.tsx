import { AUDIENCE_SUMMARY } from "@website/lib/docs"
import type { Metadata } from "next"
import { AudienceIndex } from "../_components/audience-index"

export const metadata: Metadata = {
  title: "Docs for developers · SproutOS",
  description: AUDIENCE_SUMMARY.developer,
  alternates: { canonical: "/docs/developers" },
}

export default function DeveloperDocsPage() {
  return <AudienceIndex audience="developer" />
}
