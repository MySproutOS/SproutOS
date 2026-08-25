import { getCurrentSession } from "@website/lib/auth"
import { redirect } from "next/navigation"
import { AppStore } from "./_components/landing/app-store"
import { Automations } from "./_components/landing/automations"
import { BackendOps } from "./_components/landing/backend-ops"
import { FinalCta } from "./_components/landing/final-cta"
import { ForBusiness } from "./_components/landing/for-business"
import { Hero } from "./_components/landing/hero"
import { Nav } from "./_components/landing/nav"
import { Ownership } from "./_components/landing/ownership"
import { Pipelines } from "./_components/landing/pipelines"
import { SiteFooter } from "./_components/landing/site-footer"

export default async function Page() {
  const session = await getCurrentSession()
  if (session) {
    return redirect("/dashboard")
  }

  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Automations />
        <AppStore />
        <ForBusiness />
        <BackendOps />
        <Ownership />
        <Pipelines />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  )
}
