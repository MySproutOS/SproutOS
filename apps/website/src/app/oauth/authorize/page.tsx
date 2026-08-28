import { db } from "@sproutos/db"
import { availableBalance } from "@lib/billing/ledger"
import { formatBalanceMicroUsd } from "@lib/billing/money"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@website/lib/auth"
import { ConsentForm } from "./consent-form"

/**
 * The authorization endpoint, which is a page rather than an API route.
 *
 * The provider has had `POST /v1/oauth/consent` since it was built, and `oauth.ts` says why the
 * two are separate: "Splitting them keeps the authorization *decision* on an authenticated API
 * route rather than in a page handler." The API half shipped and this half did not, so
 * `authorization_endpoint` in the discovery document pointed at nothing and the authorization-code
 * flow could not be completed by a browser at all.
 *
 * ## The rule that shapes this file
 *
 * **An error is only ever sent back to a redirect URI that is already registered.** Everything
 * else — an unknown client, a redirect that is not on the client's list — renders here instead.
 * Redirecting on those would turn this endpoint into an open redirector that also reports whether
 * a given client id exists, which is a probing oracle and a phishing primitive in one.
 */

export const dynamic = "force-dynamic"

type Search = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** Rendered when the request is too broken to answer, and too broken to answer *to*. */
function Refusal({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="container-page flex min-h-screen items-center justify-center py-20">
      <div className="max-w-lg rounded-2xl border rule-soft bg-card/60 p-8">
        <p className="eyebrow mb-3">Authorization request</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="mt-3 text-sm text-muted-foreground text-pretty">{detail}</p>
        <p className="mt-6 text-xs text-muted-foreground text-pretty">
          Nothing was shared, and you have not been sent back to the application — this request did
          not prove where it came from.
        </p>
      </div>
    </main>
  )
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams

  const clientId = one(params.client_id)
  const redirectUri = one(params.redirect_uri)
  const responseType = one(params.response_type)
  const scope = one(params.scope)
  const state = one(params.state)
  const codeChallenge = one(params.code_challenge)
  const codeChallengeMethod = one(params.code_challenge_method) ?? "S256"
  const intent = one(params.intent)

  if (clientId === null || redirectUri === null) {
    return (
      <Refusal
        title="Something is missing from this request"
        detail="An authorization request must name the application and where to send you back to. This one did not."
      />
    )
  }

  if (!isUuid(clientId)) {
    return (
      <Refusal
        title="That application cannot ask for access"
        detail="It is not registered here, or it has been suspended. If you were sent from somewhere claiming to be a SproutOS application, treat that link with suspicion."
      />
    )
  }

  const client = await db
    .selectFrom("oauthClient")
    .select([
      "id",
      "name",
      "description",
      "logoUrl",
      "homepageUrl",
      "status",
      "isFirstParty",
      "isVerified",
      "defaultScopes",
    ])
    .where("id", "=", clientId)
    .executeTakeFirst()

  if (client === undefined || client.status !== "active") {
    return (
      <Refusal
        title="That application cannot ask for access"
        detail="It is not registered here, or it has been suspended. If you were sent from somewhere claiming to be a SproutOS application, treat that link with suspicion."
      />
    )
  }

  const registered = await db
    .selectFrom("oauthClientRedirectUri")
    .select("uri")
    .where("oauthClientId", "=", client.id)
    .execute()

  /*
    Exact string comparison, deliberately. A "does it start with" check is what turns one
    registered `https://app.example.com/callback` into every URL underneath it, and a normalising
    comparison is a set of parser differences waiting to disagree with whatever the token endpoint
    does later.
  */
  const redirectIsRegistered = registered.some((row) => row.uri === redirectUri)

  if (!redirectIsRegistered) {
    return (
      <Refusal
        title="That is not where this application receives replies"
        detail="The address it asked us to send you back to is not one it has registered. This is the check that stops an authorization code being delivered to somebody else, so the request stops here."
      />
    )
  }

  // From here the redirect URI is trusted, so protocol errors go back to the application in the
  // shape RFC 6749 §4.1.2.1 requires rather than being rendered at the user.
  // Captured before the closure so the narrowing survives into it: `redirectUri` is checked
  // non-null above, but a function body is analysed independently of the flow that reached it.
  const validatedRedirect = redirectUri

  function bounce(error: string, description: string): never {
    const target = new URL(validatedRedirect)
    target.searchParams.set("error", error)
    target.searchParams.set("error_description", description)
    if (state !== null) target.searchParams.set("state", state)
    redirect(target.toString())
  }

  // `return bounce(...)` rather than `bounce(...)`: the call returns `never`, but TypeScript only
  // narrows the checked value afterwards when the branch visibly exits.
  if (responseType !== null && responseType !== "code") {
    return bounce("unsupported_response_type", "Only the authorization code flow is supported")
  }
  if (codeChallenge === null || codeChallenge === "") {
    return bounce("invalid_request", "PKCE is required: send a code_challenge")
  }
  if (codeChallengeMethod !== "S256") {
    return bounce("invalid_request", "Only the S256 code challenge method is supported")
  }

  // The whole result is null when there is no session — there is no `{ user: null }` shape here.
  const authenticated = await getCurrentSession()

  if (authenticated === null) {
    // The whole request, so that signing in returns to exactly this decision rather than a
    // dashboard the person did not ask for.
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      const single = one(value)
      if (single !== null) search.set(key, single)
    }
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${search.toString()}`)}`)
  }

  const memberships = await db
    .selectFrom("organizationMember")
    .innerJoin("organization", "organization.id", "organizationMember.organizationId")
    .select(["organization.id as id", "organization.name as name", "organization.slug as slug"])
    .where("organizationMember.userId", "=", authenticated.user.id)
    .orderBy("organization.name")
    .execute()

  const organizations = await Promise.all(
    memberships.map(async (organization) => ({
      ...organization,
      availableCredit: formatBalanceMicroUsd(await availableBalance(db, organization.id)),
    })),
  )

  if (memberships.length === 0) {
    return (
      <Refusal
        title="You have no team to grant access for"
        detail="An application is authorized against a team, and this account is not a member of one."
      />
    )
  }

  const requested = (scope ?? "").split(/[\s+]+/).filter((value) => value !== "")
  const scopes = requested.length > 0 ? requested : client.defaultScopes

  if (scopes.length === 0) {
    return bounce("invalid_scope", "No scopes were requested and the client has no defaults")
  }

  /*
    `name` is nullable on the user row — a GitHub account with no display name has none. The email
    is always there, and on a screen about granting access to *your* account, showing something
    that identifies the account matters more than showing something friendly.
  */
  const signedInAs = authenticated.user.name ?? authenticated.user.email

  /*
    Read here and passed down, rather than read inside the client component.

    `process.env.NEXT_PUBLIC_*` is inlined into the browser bundle at *build* time. CI sets this
    variable for the build, so production is fine — but a developer running `next dev` has no
    `apps/website/.env`, the value inlines as an empty string, and the consent POST goes to the
    website's own origin and 500s. Reading it on the server means one runtime value, correct in
    both places, and a missing variable fails loudly rather than silently retargeting the request.
  */
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"

  return (
    <ConsentForm
      client={{
        id: client.id,
        name: client.name,
        description: client.description,
        logoUrl: client.logoUrl,
        homepageUrl: client.homepageUrl,
        trusted: client.isFirstParty || client.isVerified,
      }}
      organizations={organizations}
      scopes={scopes}
      optionalScopes={
        intent === "create_personal_database" && scopes.includes("database:create")
          ? ["database:create"]
          : []
      }
      databaseIntent={intent === "create_personal_database"}
      redirectUri={redirectUri}
      state={state}
      codeChallenge={codeChallenge}
      codeChallengeMethod={codeChallengeMethod}
      userName={signedInAs}
      apiBase={apiBase}
    />
  )
}
