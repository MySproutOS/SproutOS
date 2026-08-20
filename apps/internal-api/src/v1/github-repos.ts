import { fetchGithubInstallation } from "@lib/dao"
import {
  createGitHubClient,
  createInstallationTokenStore,
  envAppJwtSigner,
  GitHubRateLimitError,
  GitHubTransportError,
  listInstallationRepositories,
  MissingGitHubAppConfigError,
} from "@lib/github"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { collectionResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwError, throwNotFound, throwTooManyRequests } from "../utils/http-exception"
import {
  githubSchemaOrgParam,
  githubSchemaRepositoryListQuery,
  githubSchemaRepositoryListResponse,
} from "./github-repos.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * One token store per process.
 *
 * The cache inside it is the point — an installation token lasts an hour and every mint costs a
 * JWT signature plus a round trip. Rebuilding the store per request would make the cache useless.
 * `envAppJwtSigner()` reads the environment lazily, so constructing this at import time does not
 * require the key to exist.
 */
const tokens = createInstallationTokenStore({
  client: createGitHubClient(),
  signJwt: envAppJwtSigner(),
})

/**
 * The repository picker's data source.
 *
 * This is the one place in the request path that talks to GitHub, and it is a read. Everything
 * that *writes* to GitHub goes through a `project_job`, because a fork takes long enough that a
 * request handler would time out holding a half-created repository.
 */
const app = new Hono().use(authMiddleware).get(
  "/:orgSlug/github/repositories",
  describeRoute({
    description: "Lists the repositories the organization's GitHub App installation can reach",
    responses: {
      200: {
        description: "Repositories the installation can reach",
        content: {
          "application/json": { schema: resolver(githubSchemaRepositoryListResponse) },
        },
      },
      403: { description: "Caller lacks github:read", ...errorResponse },
      404: { description: "No usable GitHub installation for this organization", ...errorResponse },
      429: { description: "GitHub rate limit reached", ...errorResponse },
      503: {
        description: "GitHub App credentials are not configured, or GitHub is unreachable",
        ...errorResponse,
      },
    },
  }),
  validator("param", githubSchemaOrgParam),
  validator("query", githubSchemaRepositoryListQuery),
  requirePermission("github:read", collectionResource("github", "installation")),
  async (c) => {
    const organization = c.var.organization
    const query = c.req.valid("query")

    const installations = await fetchGithubInstallation(db).listUsable(organization.id, [
      "id",
      "installationId",
      "accountLogin",
    ])

    const installation = installations[0]
    if (installation === undefined) {
      return throwNotFound(
        c,
        "This organization has no active GitHub App installation. Install the SproutOS app on the account that owns the repositories.",
      )
    }

    try {
      const credential = await tokens.get(Number(installation.installationId))
      const page = await listInstallationRepositories(createGitHubClient(), credential, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 100,
      })

      return c.json({
        data: page.repositories.map((repository) => ({
          defaultBranch: repository.defaultBranch,
          fork: repository.fork,
          fullName: repository.fullName,
          githubRepoId: String(repository.id),
          name: repository.name,
          ownerLogin: repository.ownerLogin,
          private: repository.private,
        })),
        installationAccountLogin: installation.accountLogin,
        totalCount: page.totalCount,
      })
    } catch (error) {
      // `GITHUB_APP_PRIVATE_KEY` is empty in a fresh checkout, and this is the first route that
      // needs it. Reporting it as a configuration problem rather than letting an OpenSSL
      // decoder error surface as a 500 is the difference between a one-line fix and an hour.
      if (error instanceof MissingGitHubAppConfigError) {
        return throwError(c, 503, ErrorCode.ServiceUnavailable, error.message)
      }

      if (error instanceof GitHubRateLimitError) {
        return throwTooManyRequests(
          c,
          `GitHub rate limit reached. Retry in ${error.retryAfterSeconds} seconds.`,
          ErrorCode.RateLimitExceeded,
        )
      }

      if (error instanceof GitHubTransportError) {
        return throwError(c, 503, ErrorCode.ServiceUnavailable, "GitHub is unreachable")
      }

      throw error
    }
  },
)

export default app
