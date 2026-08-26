import { fetchOrganization } from "@lib/dao"
import { createGitHubClient, linkInstallation, userGitHubIdentity } from "@lib/github"
import { db } from "@sproutos/db"
import { getCurrentSession } from "@website/lib/auth"
import { cookies } from "next/headers"
import { INSTALL_ORG_COOKIE } from "../install/route"

/** Where GitHub sends somebody after they install the App — the App's "Setup URL". */

/** What `GET /user/installations` returns, narrowed to the fields stored. */
type UserInstallation = {
  id: number
  account?: { login?: string; type?: string } | null
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
  const params = new URL(request.url).searchParams
  const cookieStore = await cookies()
  const orgSlug = cookieStore.get(INSTALL_ORG_COOKIE)?.value ?? null

  // Consumed either way. A cookie that survives a failed attempt would attach the *next*
  // installation to an organization the person has since navigated away from.
  cookieStore.delete(INSTALL_ORG_COOKIE)

  const settings = orgSlug === null ? "/" : `/orgs/${orgSlug}/settings/github`

  const session = await getCurrentSession()
  if (session === null) {
    const next = encodeURIComponent(request.url)
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
    GitHub decides whether this person may link this installation, because only GitHub knows.

    The tempting check is to compare the installation's account login to the user's own, which is
    right for a personal account and wrong for every organization — the whole point of installing on
    an organization is that it is not you. `GET /user/installations` is the question actually being
    asked: it returns exactly the installations this token's owner may administer, so an id that
    comes back is an id they are entitled to attach here, and one that does not is refused without
    the platform having to model GitHub's permission rules a second time.

    Without it this route would take an `installation_id` from a query string and write it against
    whatever organization the caller is a member of — which is to say, anybody could claim anybody
    else's installation by guessing a small integer.
  */
  const credential = await userGitHubIdentity(db, session.user.id)
  if (credential === undefined) return back(settings, "reconnect")

  const response = await createGitHubClient().request<{ installations: UserInstallation[] }>({
    method: "GET",
    path: "/user/installations?per_page=100",
    credential: credential,
  })

  const match = response.data.installations.find(
    (entry: UserInstallation) => entry.id === installationId,
  )
  if (match === undefined) return back(settings, "forbidden")

  await linkInstallation(db, organization.id, {
    id: match.id,
    login: match.account?.login ?? "",
    accountType: match.account?.type ?? "User",
    repositorySelection: match.repository_selection ?? "selected",
    permissions: match.permissions ?? {},
    suspended: match.suspended_at != null,
  })

  return back(settings, "installed")
}
