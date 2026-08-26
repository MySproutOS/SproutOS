import { createGitHubClient, envAppJwtSigner, githubAppSlug } from "@lib/github"
import { cookieDomain } from "@website/lib/auth"
import { cookies } from "next/headers"

export const INSTALL_ORG_COOKIE = "github_install_org"

/**
 * The first half of installing the GitHub App, and the reason the second half can work at all.
 *
 * Installing used to be a link straight to `github.com/apps/<slug>/installations/new`, which is a
 * one-way trip. GitHub records the installation and sends a webhook, and that webhook says which
 * GitHub *account* the App landed on and cannot say which SproutOS organization wanted it — so
 * `installationSync` fell back to guessing from `repository.owner_login`, found nothing for anyone
 * who had not already created a repository under that account, and dropped the delivery. Installing
 * the App from a brand-new organization therefore did nothing at all, twice over: no redirect back,
 * and no row.
 *
 * Going through here instead means the answer is not guessed. The organization is written to a
 * short-lived cookie on the way out and read on the way back, and the person holding that cookie is
 * still signed in — so the setup route knows both halves and never has to infer one from the other.
 *
 * No session check. This route reveals nothing and does nothing; `/github/setup` is where the
 * caller has to prove who they are, and doing it here as well would only mean two places to get it
 * wrong.
 */
export async function GET(request: Request) {
  const orgSlug = new URL(request.url).searchParams.get("org")

  if (orgSlug !== null) {
    const cookieStore = await cookies()
    cookieStore.set(INSTALL_ORG_COOKIE, orgSlug, {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      // Long enough to pick an account and choose repositories on GitHub, short enough that a
      // cookie left behind by an abandoned install cannot steer a later one.
      maxAge: 60 * 15,
      sameSite: "lax",
      domain: cookieDomain(),
    })
  }

  const slug = await githubAppSlug(createGitHubClient(), envAppJwtSigner())

  return new Response(null, {
    status: 302,
    headers: { Location: `https://github.com/apps/${slug}/installations/new` },
  })
}
