import { Button } from "@ui/base/ui/button"
import { NavLinks } from "@ui/seo-shared/nav-links"
import { getCurrentSession } from "@website/lib/auth"
import Link from "next/link"
import { redirect } from "next/navigation"

const footerLinks = [
  { href: "/blog", label: "Blog" },
  { href: "/legal", label: "Legal" },
]

export default async function Page() {
  const session = await getCurrentSession()
  if (session) {
    return redirect("/dashboard")
  }

  return (
    <div>
      <Link href={"/login"}>
        <Button>Login</Button>
      </Link>
      <NavLinks className="mt-8" links={footerLinks} />
    </div>
  )
}
