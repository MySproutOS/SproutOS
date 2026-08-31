import { getCurrentSession } from "@website/lib/auth"
import { redirect } from "next/navigation"
import { FinalCta } from "./_components/landing/final-cta"
import { Hero } from "./_components/landing/hero"
import { Teasers } from "./_components/landing/teasers"

export default async function Page() {
  const session = await getCurrentSession()
  if (session) {
    return redirect("/dashboard")
  }

  return (
    <>
      <Hero />
      <Teasers />
      <FinalCta />
    </>
  )
}
