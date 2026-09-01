import { AUDIENCE_SUMMARY } from "@website/lib/docs"
import type { Metadata } from "next"
import { AudienceIndex } from "../_components/audience-index"

export const metadata: Metadata = {
  title: "Docs for users · SproutOS",
  description: AUDIENCE_SUMMARY.user,
  alternates: { canonical: "/docs/users" },
}

export default function UserDocsPage() {
  return <AudienceIndex audience="user" />
}
