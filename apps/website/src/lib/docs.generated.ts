// Generated from src/content/docs/*.md by scripts/generate-docs.ts.
export const GENERATED_DOCS = [
  {
    slug: "background-workers",
    title: "Background workers and open connections",
    summary: "Return after each batch so idle connections do not keep consuming compute.",
    content:
      "## How work starts\n\nSproutOS invokes your application when a queue has work. Handle the `queue.drain` event, process the supplied batch, and return. The same deployed function can serve HTTP and workflow invocations.\n\n## Return when work is done\n\nCompute is billed in GB-seconds until the handler returns. Close database connections and do not leave a Redis subscribe, blocking read, timer, or worker loop alive. SproutOS invokes the function again when more work arrives.\n\nUse a workflow step for work that must continue later. Split work that cannot finish within one invocation, enqueue the remainder, and return.",
  },
  {
    slug: "billing",
    title: "Understand billing",
    summary: "Read service usage, credit, overhead, and queue residency without hidden rounding.",
    content:
      "## Usage and credit\n\nUsage is recorded in an append-only ledger and grouped by service. Line items retain sub-cent precision; spendable credit is displayed in cents. A balance cannot be spent below zero.\n\n## Queue residency\n\nQueue residency is queued payload bytes multiplied by how long they remain queued. It is storage over time, not a count of jobs and not ordinary cache usage.\n\n## Platform fees\n\nSandbox usage, sandbox egress, Postgres storage, and user-funded AI have no added platform percentage. Postgres compute has a 2% platform fee. Payment processing is passed through separately.",
  },
  {
    slug: "connecting",
    title: "Connect to services",
    summary: "Use one-time, tenant-scoped credentials for Postgres, Valkey, search, and storage.",
    content:
      "## One-time credentials\n\nProvisioning or rotating a service returns its connection URI once. Put it in the project's encrypted environment variables. SproutOS stores a verifier, not a recoverable copy, so the URI cannot be revealed later.\n\n## Service variables\n\n- Postgres uses `DATABASE_URL`.\n- Valkey uses `VALKEY_URL` or `REDIS_URL`; BullMQ also uses the injected `BULLMQ_PREFIX`.\n- OpenSearch uses `SEARCH_URL` and automatically scopes index names.\n- Object storage uses the injected `S3_*` values and path-style addressing.\n\nAll endpoints pass through tenant-enforcing SproutOS proxies. Close connections before a function returns.",
  },
  {
    slug: "github-action",
    title: "Deploy with GitHub Actions",
    summary: "Authenticate with GitHub OIDC and deploy one target from a repository.",
    content:
      "## Minimal workflow\n\n```yaml\npermissions:\n  contents: read\n  id-token: write\n\nsteps:\n  - uses: actions/checkout@v4\n  - uses: MySproutOS/sproutos-deploy-action@v1\n    with:\n      preset: next\n      directory: apps/website\n      project: my-web-project\n      api-url: https://api.sproutos.me\n```\n\n`id-token: write` lets GitHub identify the repository to SproutOS without a stored deployment secret. In a monorepo, use one workflow step per deployable target and set both `directory` and `project`.\n\n## Presets and migrations\n\nUse `next`, `hono`, `static`, or `android` as the preset. Server projects may declare a migration command; it completes before traffic moves to the new release. Static assets are uploaded to the project CDN.\n\nThe action waits for a terminal deployment state. A failed migration, missing artifact, or rejected repository identity fails the GitHub job instead of reporting a successful upload.\n\n## Use the deployment skill locally\n\nDownload [the SproutOS skill](/skills/sproutos/SKILL.md) into `.claude/skills/sproutos/SKILL.md` for Claude Code. For an AGENTS.md-based CLI harness, append its instructions to your repository's `AGENTS.md` while preserving the instructions already there.\n\nRunning your own local agent uses your machine and model account, so SproutOS does not charge sandbox or model usage. Resources you deploy through SproutOS are still billed normally.",
  },
  {
    slug: "limits",
    title: "Limits",
    summary: "Function duration, request size, memory, and concurrency.",
    content:
      "## Runtime\n\nAn invocation runs for at most 15 minutes. Split longer jobs and enqueue the remainder. Memory is configurable from 128 MB to 10 GB and CPU grows with memory.\n\n## Payloads and builds\n\nRequest and response bodies are limited to 6 MB; use object storage for larger data. Deployable application bundles are limited to 250 MB uncompressed and are rejected before upload when over the build threshold.\n\n## Concurrency\n\nInvocations may run concurrently in isolated environments. Pools created at module scope may be reused by a warm instance; never store a user's session or request state there.",
  },
  {
    slug: "navigation",
    title: "Navigate SproutOS",
    summary: "Where repositories, deployable projects, workflows, services, and usage live.",
    content:
      "## Organizations and groups\n\nAn organization owns billing and access. A **group** is one GitHub repository. Its child projects are the deployable targets inside that repository, such as a web app and an API.\n\nOpen **Projects** to see groups and their children. Group settings hold repository-wide choices such as upstream updates and the primary deployed project.\n\n## Projects and domains\n\nA project is one deployable directory and branch. Its overview shows the live SproutOS hostname; **Domains** adds a custom hostname. **Environment** stores encrypted variables and **Observability** shows requests, logs, and failures.\n\n## Databases and other services\n\nUse **Databases** for Postgres and the project service screens for Valkey, search, and object storage. A connection credential is shown once when it is created or rotated. Store it in a project environment variable; it cannot be revealed later.\n\n## Workflows and agents\n\nWorkflows attached to a repository appear inside its group. The global **Workflows** page is for standalone automation repositories. Agent conversations and previews stay with the project they modify.\n\n## Billing and deletion\n\nBilling groups measured usage by service and keeps an append-only credit ledger. Deleting a project tears down its resources but retains billing and audit history. GitHub repositories are retained unless you explicitly select them for deletion.",
  },
  {
    slug: "oauth-applications",
    title: "Build a SproutOS OAuth application",
    summary: "Authorization Code with PKCE, optional database access, tokens, and revocation.",
    content:
      "## Register and redirect\n\nRegister an OAuth client in SproutOS and add exact HTTPS redirect URIs. Public clients must use Authorization Code with PKCE (`S256`) and must never ship a client secret.\n\nSend users to the authorization endpoint with `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `state`, and the scopes you need. Validate `state` before exchanging the returned code.\n\n## Ask only for needed access\n\nDatabase creation uses `database:create` and spends the user's SproutOS credit. When the authorization request includes `intent=create_personal_database`, consent explains the expected billing. The user may omit that optional permission and still sign in to your application. Pressing Cancel stops authorization.\n\nA grant may include database creation even when the account has no credit. The creation request itself returns HTTP 402 until credit is available.\n\n## Tokens and credentials\n\nExchange the code with its original `code_verifier`. Send access tokens as `Authorization: Bearer …`. Refresh tokens are rotated; replace the stored refresh token after every successful refresh.\n\nDatabase credentials belong to the OAuth grant that created them. Rotating an application credential does not rotate the user's credential or another application's credential. Connection URIs are returned once and cannot be revealed later.\n\n## Revocation\n\nUsers can revoke your grant from settings. Revocation stops new API calls and revokes credentials owned by that grant. Resources the user chooses to keep remain theirs.",
  },
] as const
