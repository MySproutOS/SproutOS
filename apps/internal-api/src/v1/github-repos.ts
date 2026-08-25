import { fetchGithubInstallation } from "@lib/dao"
import {
  createGitHubClient,
  createInstallationTokenStore,
  envAppJwtSigner,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubTransportError,
  getRepository,
  listInstallationRepositories,
  MissingGitHubAppConfigError,
} from "@lib/github"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { authMiddleware } from "../middleware"
import { collectionResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwError, throwNotFound, throwTooManyRequests } from "../utils/http-exception"
import {
  githubSchemaNameCheckQuery,
  githubSchemaNameCheckResponse,
  githubSchemaOwnerListResponse,
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
/**
 * What GitHub will refuse, checked here so a person learns about it while typing.
 *
 * GitHub's own rules are narrower than they look: a name is `[A-Za-z0-9._-]+`, cannot be `.` or
 * `..`, and cannot end in `.git` or a dot. Returning the specific problem rather than a boolean is
 * the whole point — "that name will not work" sends somebody hunting, and "names cannot contain
 * spaces" does not.
 */
export function repositoryNameProblem(name: string): string | null {
  if (name === "." || name === "..") return "A repository cannot be named . or .."
  if (name.endsWith(".git")) return "A repository name cannot end in .git"
  if (name.endsWith(".")) return "A repository name cannot end in a dot"
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return "Use letters, numbers, hyphens, underscores and dots only — no spaces."
  }
  return null
}

const app = new Hono()
  .use(authMiddleware)
  .get(
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
        404: {
          description: "No usable GitHub installation for this organization",
          ...errorResponse,
        },
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
  .get(
    "/:orgSlug/github/owners",
    describeRoute({
      description: "GitHub accounts a new repository could be created on",
      responses: {
        200: {
          description: "One entry per usable installation, oldest first",
          content: { "application/json": { schema: resolver(githubSchemaOwnerListResponse) } },
        },
        403: { description: "Caller lacks github:read", ...errorResponse },
      },
    }),
    validator("param", githubSchemaOrgParam),
    requirePermission("github:read", collectionResource("github", "installation")),
    async (c) => {
      const installations = await fetchGithubInstallation(db).listUsable(c.var.organization.id, [
        "accountLogin",
        "accountType",
      ])

      /*
        An empty list, not a 404.

        "Where should this live" with no answers is a legitimate state — the App is simply not
        installed yet — and the dialog has something useful to say about it. A 404 here would make
        the picker indistinguishable from a broken request.
      */
      return c.json({
        data: installations.map((installation, index) => ({
          login: installation.accountLogin,
          accountType: installation.accountType,
          isDefault: index === 0,
        })),
      })
    },
  )
  .get(
    "/:orgSlug/github/repository-name",
    describeRoute({
      description: "Whether a repository name is free on the account a new project would use",
      responses: {
        200: {
          description: "The verdict, with a reason when it is not available",
          content: { "application/json": { schema: resolver(githubSchemaNameCheckResponse) } },
        },
        403: { description: "Caller lacks github:read", ...errorResponse },
        429: { description: "GitHub rate limit reached", ...errorResponse },
        503: { description: "GitHub is unreachable", ...errorResponse },
      },
    }),
    validator("param", githubSchemaOrgParam),
    validator("query", githubSchemaNameCheckQuery),
    requirePermission("github:read", collectionResource("github", "installation")),
    async (c) => {
      const organization = c.var.organization
      const { name, owner } = c.req.valid("query")

      /*
        The shape rules first, because they are the ones a person can fix while typing and they
        cost no round trip. GitHub's own error for a bad name arrives only after the create is
        attempted, which in this platform is inside a background job — so the customer would learn
        about a trailing dot from a failed provision minutes later.
      */
      const shape = repositoryNameProblem(name)
      if (shape !== null) {
        return c.json({
          name,
          ownerLogin: null,
          available: false,
          reason: shape,
          conflict: "invalid_name" as const,
        })
      }

      const installations = await fetchGithubInstallation(db).listUsable(organization.id, [
        "id",
        "installationId",
        "accountLogin",
      ])

      /*
        Check against the account the caller actually picked.

        Before the owner picker this took `installations[0]` unconditionally. With a picker that is
        a wrong answer rather than an approximate one: a name free on the personal account and taken
        on the organization would be reported free, and the failure would surface as a failed
        provision. An unrecognised owner falls through to `undefined`, which the branch below
        already explains rather than guessing at.
      */
      const installation =
        owner === undefined
          ? installations[0]
          : installations.find(
              (candidate) => candidate.accountLogin.toLowerCase() === owner.toLowerCase(),
            )

      /*
        No installation is not "unavailable".

        Nothing can be checked, and saying `available: false` would tell somebody their perfectly
        good name is taken. The reason names the actual blocker, which is the one they have to
        resolve before any of this works.
      */
      if (installation === undefined) {
        return c.json({
          name,
          ownerLogin: null,
          available: false,
          reason:
            owner === undefined
              ? "No GitHub account is connected to this organization yet, so the name cannot be checked. Install the SproutOS GitHub App on the account that should own the repository."
              : `The SproutOS GitHub App is not installed on ${owner}, so the name cannot be checked there.`,
          conflict: "no_installation" as const,
        })
      }

      try {
        const credential = await tokens.get(Number(installation.installationId))
        await getRepository(createGitHubClient(), credential, installation.accountLogin, name)

        // It resolved, so something is already there.
        return c.json({
          name,
          ownerLogin: installation.accountLogin,
          available: false,
          reason: `${installation.accountLogin}/${name} already exists.`,
          conflict: "exists" as const,
        })
      } catch (error) {
        /*
          404 is the answer, not the error. It is the only way GitHub says "nothing here", and the
          only outcome of this endpoint that means yes.
        */
        if (error instanceof GitHubNotFoundError) {
          return c.json({
            name,
            ownerLogin: installation.accountLogin,
            available: true,
            reason: null,
            conflict: null,
          })
        }

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
