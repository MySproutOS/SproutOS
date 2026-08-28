import { Hono } from "hono"
import { RegExpRouter } from "hono/router/reg-exp-router"
import agent from "./agent"
import agentChat from "./agent-chat"
import analysis from "./analysis"
import deployments from "./deployments"
import customDomains from "./custom-domains"
import deployWorkflow from "./deploy-workflow"
import regions from "./regions"
import metering from "./metering"
import deploy from "./deploy"
import android from "./android"
import androidApps from "./android-apps"
import apkSigning from "./apk-signing"
import pgResolve from "./pg-resolve"
import auth from "./auth"
import billing from "./billing"
import githubRepos from "./github-repos"
import members, { invites } from "./members"
import oauth from "./oauth"
import oauthClients from "./oauth-clients"
import oauthGrants from "./oauth-grants"
import organizations from "./organizations"
import projects from "./projects"
import sandboxes from "./sandboxes"
import roles from "./roles"
import services from "./services"
import store, { storeModeration } from "./store"
import apiKeys from "./api-keys"
import observability from "./observability"
import otlp from "./otlp"
import stripeWebhooks from "./stripe-webhooks"
import user from "./user"
import webhooks from "./webhooks"
import workflows from "./workflows"

/*
  Grouped rather than chained flat.

  `.route()` returns a type accumulating every path registered so far, so a single chain of
  nineteen of them hits `TS2589: Type instantiation is excessively deep` — and it does so with no
  file or line, which makes it a genuinely unpleasant thing to hit while adding route twenty.

  Splitting into groups keeps each chain short. Nothing depends on the accumulated type: the typed
  client is generated from the OpenAPI document, not from Hono's inference.
*/

/**
 * Everything scoped to an organization, mounted at /orgs.
 *
 * Annotated `Hono` and registered with statements rather than a chain. Each `.route()` returns a
 * type carrying every path registered so far, so the chain is what accumulates — the annotation
 * stops it, and the statements make it stay stopped.
 */
const orgs: Hono = new Hono()
orgs.route("/", organizations)
orgs.route("/", members)
orgs.route("/", roles)
orgs.route("/", projects)
orgs.route("/", androidApps)
orgs.route("/", sandboxes)
orgs.route("/", githubRepos)
orgs.route("/", agent)
orgs.route("/", agentChat)
orgs.route("/", services)
orgs.route("/", analysis)
orgs.route("/", deployments)
orgs.route("/", customDomains)
orgs.route("/", deployWorkflow)
orgs.route("/", workflows)
// The store catalogue itself is public (TASK 4); only moderation is org-scoped, and it lives here
// so the organization whose grants apply is named in the path rather than inferred from
// `user_preference.last_org_id`.
orgs.route("/", storeModeration)
orgs.route("/:orgSlug/billing", billing)
orgs.route("/", observability)
orgs.route("/", apiKeys)
// Registering an application against our own OAuth provider. Org-scoped and authenticated, unlike
// `/oauth/*` below, which is the provider itself and authenticates the client rather than a session.
orgs.route("/", oauthClients)
// Applications this user authorized, which is the other side of the clients they publish.
orgs.route("/", oauthGrants)

/**
 * Unauthenticated by design.
 *
 * GitHub and Stripe each sign their deliveries and the handlers verify over the raw bytes, so
 * `authMiddleware` here would reject every delivery. The OAuth endpoints authenticate the *client*
 * rather than a session, and discovery is public by definition.
 */
const unauthenticated: Hono = new Hono()
unauthenticated.route("/webhooks", webhooks)
unauthenticated.route("/webhooks", stripeWebhooks)
unauthenticated.route("/oauth", oauth)
/*
  OTLP ingest authenticates with a project ingest key, not a session: the caller is a customer's own
  container or collector. The nested `/v1` is not a mistake — an OTel exporter appends `/v1/logs` to
  whatever endpoint it is given, so `.../v1/otlp` is the whole of what a customer configures.
*/
unauthenticated.route("/otlp", otlp)
/*
  Metering ingest authenticates with an HMAC over a canonical form, not a session: the caller is a
  DaemonSet on every node. `/internal` because nothing outside the platform has any business posting
  usage — it is not part of the customer-facing API surface, and saying so in the path means a future
  reader does not have to infer it from the absence of `authMiddleware`.
*/
unauthenticated.route("/internal", metering)
/*
  Where `pg-proxy` asks which database to connect onward to for a tenant. Same `/internal` prefix
  and same reason as metering: the caller is a platform component, not a customer.
*/
unauthenticated.route("/internal", pgResolve)
/*
  What the deploy action calls. Authenticated by a GitHub Actions OIDC token rather than a session:
  the caller is a workflow, not a person, and the repository claim is what decides which project it
  may deploy.
*/
unauthenticated.route("/", deploy)
/*
  What the on-premises APK signer polls. Deliberately *not* under `/internal`: that prefix means
  "reachable only inside the VPC", and this caller is a machine behind somebody's firewall reaching
  out over the public internet. It carries its own bearer credential instead.
*/
unauthenticated.route("/", apkSigning)
/*
  The Android client's catalogue. Optionally authenticated rather than unauthenticated: the public
  tab must be readable by somebody deciding whether to install the client, and the personal tab is
  built from whoever is asking.
*/
unauthenticated.route("/", android)
/*
  There was a `/internal/neon` route here and it is gone with the self-hosted storage layer.

  It served two endpoints, and ADR 0025 records why neither survives: `notify-attach`, because a
  self-hosted storage controller panics without a control plane to tell which pageserver holds a
  tenant, and `wake`, because **Neon's own proxy does wake-on-connect** — the feature we had
  reimplemented.
*/

const app: Hono = new Hono({ router: new RegExpRouter() }).basePath("/v1")
app.route("/auth", auth)
app.route("/invites", invites)
app.route("/orgs", orgs)
/*
  Not under `/orgs`. A region is a property of the platform, not of a tenant — every organization is
  offered the same set, and scoping it would imply otherwise.
*/
app.route("/regions", regions)
app.route("/store", store)
app.route("/user", user)
app.route("/", unauthenticated)

export default app
