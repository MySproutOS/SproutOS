import { fetchOrganization } from "@lib/dao"
import {
  appJwt,
  createGitHubClient,
  envAppJwtSigner,
  linkInstallation,
  userGitHubIdentity,
} from "@lib/github"
import { db } from "@sproutos/db"
import { getCurrentSession } from "@website/lib/auth"
import { cookies } from "next/headers"
import { INSTALL_ORG_COOKIE } from "../install/route"

/** Where GitHub sends somebody after they install the App — the App's "Setup URL". */

/** What `GET /app/installations/{id}` returns, narrowed to the fields stored. */
type Installation = {
  id: number
  account?: { id?: number; login?: string; type?: string } | null
  repository_selection?: string
  permissions?: Record<string, string>
  suspended_at?: string | null
}

function back(path: string, status: string): Response {
  const host = process.env.NEXT_PUBLIC_HOST_URL ?? ""
  const url = new URL(path, host)
  url.searchParams.set("install", status)
  return new Response(null, { status: 302, headers: { Location: url.toString() } })
}

export async function GET(request: Request) {
  /*
    Nothing here is allowed to 500.

    GitHub delivers `installation_id` exactly once, to this URL, and an error page is where that
    fact goes to die — the person is left with an App that is installed on GitHub, invisible here,
    and no way to replay the redirect. Failing onto the settings page at least says so and leaves
    "Install on an account" in reach, which starts the whole flow again.
  */
  try {
    return await handle(request)
  } catch (error) {
    console.error("[github] setup callback failed", error)
    return back("/", "failed")
  }
}

async function handle(request: Request) {
  const params = new URL(request.url).searchParams
  const cookieStore = await cookies()
  const orgSlug = cookieStore.get(INSTALL_ORG_COOKIE)?.value ?? null

  // Consumed either way. A cookie that survives a failed attempt would attach the *next*
  // installation to an organization the person has since navigated away from.
  cookieStore.delete(INSTALL_ORG_COOKIE)

  const settings = orgSlug === null ? "/" : `/orgs/${orgSlug}/settings/github`

  const session = await getCurrentSession()
  if (session === null) {
    /*
      Rebuilt on the public host, never from `request.url`.

      Behind the load balancer the request arrives on the instance's own address, so `request.url`
      is `https://0.0.0.0:8080/github/setup?...`. Handing that to `?next=` sends somebody who signed
      in successfully to a host that does not exist — and it happens only when the session lapsed
      during the install, which is the one case this redirect is here for. The `installation_id` is
      spent by then, so what should be a sign-in becomes an App that is installed on GitHub and
      invisible here.
    */
    const here = new URL(request.url)
    const next = encodeURIComponent(
      `${process.env.NEXT_PUBLIC_HOST_URL ?? ""}${here.pathname}${here.search}`,
    )
    return new Response(null, { status: 302, headers: { Location: `/login?next=${next}` } })
  }

  /*
    `setup_action=request` is not an installation.

    On an organization that requires owner approval, GitHub records a *request* and sends the user
    here with no `installation_id`. Treating that as a failure would tell somebody who did
    everything right that it did not work; there is simply nothing to link until an owner approves,
    and the webhook handles it when they do.
  */
  if (params.get("setup_action") === "request") return back(settings, "requested")

  const installationId = Number(params.get("installation_id"))
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return back(settings, "failed")
  }

  if (orgSlug === null) return back("/", "failed")

  const organization = await fetchOrganization(db).getBySlug(orgSlug, ["id"])
  if (organization === undefined) return back("/", "failed")

  const member = await db
    .selectFrom("organizationMember")
    .select("id")
    .where("organizationId", "=", organization.id)
    .where("userId", "=", session.user.id)
    .where("status", "=", "active")
    .executeTakeFirst()
  if (member === undefined) return back("/", "forbidden")

  /*
    Whether this person may claim this installation, asked of GitHub.

    The obvious call is `GET /user/installations`, and it is the wrong one: it needs a
    *user-to-server* token minted by the GitHub App, and the token on the session comes from the
    OAuth App. Two identities, by design (ADR 0005) — sign-in is the OAuth App's job and
    installations are the GitHub App's — so that endpoint answers "You must authenticate with an
    access token authorized to a GitHub App" no matter who is signed in. It could only ever 500,
    which is exactly what it did.

    The App's own JWT can read the installation, so the question is turned around: ask GitHub who
    this installation belongs to, then check the caller against that. Without some form of this the
    route would take an `installation_id` from a query string and write it against the caller's
    organization — and an installation id is a small integer, so anybody could claim a stranger's
    repositories by counting.
  */
  const client = createGitHubClient()

  let installation: Installation
  try {
    const response = await client.request<Installation>({
      method: "GET",
      path: `/app/installations/${installationId}`,
      credential: appJwt(envAppJwtSigner()()),
    })
    installation = response.data
  } catch {
    // A 404 here is the ordinary refusal: no such installation, or not this App's.
    return back(settings, "forbidden")
  }

  const account = installation.account ?? {}

  if (account.type === "Organization") {
    /*
      An organization installation is claimed by proving membership of that organization.

      GitHub already required owner rights to perform the install, so this is not the primary
      control — it is what stops somebody who is *not* that owner from claiming the result
      afterwards. `read:org` is in `GITHUB_REPOSITORY_SCOPES` but not in the identity scopes, so a
      caller who has only ever signed in is sent to step up rather than refused: the grant exists,
      they simply have not been asked for it yet.
    */
    const credential = await userGitHubIdentity(db, session.user.id)
    if (credential === undefined) return back(settings, "reconnect")

    try {
      await client.request({
        method: "GET",
        path: `/user/memberships/orgs/${account.login ?? ""}`,
        credential,
      })
    } catch {
      return back(settings, "orgscope")
    }
  } else {
    /*
      A personal installation is claimed by being that person.

      Compared on GitHub's numeric id rather than the login, because a login can be changed by its
      owner and then reused by somebody else — matching on it would hand the new holder of a
      recycled name a claim on the old holder's installation.
    */
    const linkedAccount = await db
      .selectFrom("account")
      .select("providerAccountId")
      .where("userId", "=", session.user.id)
      .where("provider", "=", "github")
      .executeTakeFirst()

    if (
      linkedAccount === undefined ||
      account.id === undefined ||
      String(account.id) !== linkedAccount.providerAccountId
    ) {
      return back(settings, "forbidden")
    }
  }

  await linkInstallation(db, organization.id, {
    id: installation.id,
    login: account.login ?? "",
    accountType: account.type ?? "User",
    repositorySelection: installation.repository_selection ?? "selected",
    permissions: installation.permissions ?? {},
    suspended: installation.suspended_at != null,
  })

  return back(settings, "installed")
}
