// Generated from src/content/docs/*.md by scripts/generate-docs.ts.
// Metadata and search text only — safe to import from a client component.
export const GENERATED_DOCS = [
  {
    slug: "background-workers",
    title: "Background workers and open connections",
    summary: "Return after each batch so idle connections do not keep consuming compute.",
    audience: "developer",
    category: "Building on SproutOS",
    order: 3,
    headings: [
      {
        id: "how-work-starts",
        level: 2,
        title: "How work starts",
      },
      {
        id: "return-when-work-is-done",
        level: 2,
        title: "Return when work is done",
      },
    ],
    text: "How work starts SproutOS invokes your application when a queue has work. Handle the queue.drain event, process the supplied batch, and return. The same deployed function can serve HTTP and workflow invocations. Return when work is done Compute is billed in GB-seconds until the handler returns. Close database connections and do not leave a Redis subscribe, blocking read, timer, or worker loop alive. SproutOS invokes the function again when more work arrives. Use a workflow step for work that must continue later. Split work that cannot finish within one invocation, enqueue the remainder, and return.",
  },
  {
    slug: "billing",
    title: "Understand billing",
    summary: "Read service usage, credit, overhead, and queue residency without hidden rounding.",
    audience: "user",
    category: "Billing & limits",
    order: 2,
    headings: [
      {
        id: "usage-and-credit",
        level: 2,
        title: "Usage and credit",
      },
      {
        id: "queue-residency",
        level: 2,
        title: "Queue residency",
      },
      {
        id: "object-storage",
        level: 2,
        title: "Object storage",
      },
      {
        id: "platform-fees",
        level: 2,
        title: "Platform fees",
      },
    ],
    text: "Usage and credit Usage is recorded in an append-only ledger and grouped by service. Line items retain sub-cent precision; spendable credit is displayed in cents. SproutOS is prepaid: new work is refused once spendable credit is exhausted, delayed usage is capped at the available credit when posted, and provider-backed work cannot settle past the credit available after its reservation is released. Queue residency Queue residency is queued payload bytes multiplied by how long they remain queued. It is storage over time, not a count of jobs and not ordinary cache usage. Object storage Mutable object storage records write and list requests, read requests, bytes delivered outside AWS, and stored byte-time. Deletes are free. These dimensions have no SproutOS markup. Spendable credit includes a protected reserve for 48 hours of the latest measured object-storage bytes. When credit reaches that floor, new service requests stop while the funded retention window preserves the stored data. Adding credit clears the cutoff. Platform fees Dimensions without an item-specific override use the standard 12% platform fee. Postgres compute has a 2% fee. Postgres storage, sandbox resources and egress, platform-funded AI, and operational agent duration use 0%; user-funded AI is recorded as externally charged rather than billed again. Payment processing is passed through separately.",
  },
  {
    slug: "connecting",
    title: "Connect to services",
    summary: "Use tenant-scoped credentials for Postgres, Valkey, search, and object storage.",
    audience: "developer",
    category: "Deploying",
    order: 1,
    headings: [
      {
        id: "tenant-scoped-credentials",
        level: 2,
        title: "Tenant-scoped credentials",
      },
      {
        id: "service-variables",
        level: 2,
        title: "Service variables",
      },
    ],
    text: "Tenant-scoped credentials Provisioning or rotating Postgres, Valkey, or OpenSearch returns its connection URI once. Put it in the project's encrypted environment variables. SproutOS stores a verifier, not a recoverable copy, so those URIs cannot be revealed later. Object storage is the exception. Its secret is derived rather than stored, so an authorized organization member can use View credentials again. Rotation still revokes the old access immediately at the storage proxy. See /docs/object-storage Use object storage for SDK configuration and supported operations. Service variables Postgres uses DATABASE_URL . Valkey uses VALKEY_URL or REDIS_URL ; BullMQ also uses the injected BULLMQ_PREFIX . OpenSearch uses ELASTICSEARCH_URL and automatically scopes index names. Object storage uses S3_ENDPOINT , S3_REGION , S3_BUCKET_NAME , S3_ACCESS_KEY_ID , S3_SECRET_ACCESS_KEY , and path-style addressing. All endpoints pass through tenant-enforcing SproutOS proxies. Close connections before a function returns.",
  },
  {
    slug: "database-migrations",
    title: "Run database migrations",
    summary:
      "Run production migrations from GitHub Actions before deploying every project that depends on them.",
    audience: "developer",
    category: "Deploying",
    order: 2,
    headings: [
      {
        id: "the-workflow-owns-production-migrations",
        level: 2,
        title: "The workflow owns production migrations",
      },
      {
        id: "recommended-deploy-a-migrator-project-first",
        level: 2,
        title: "Recommended: deploy a migrator project first",
      },
      {
        id: "alternative-run-the-command-directly-in-ci",
        level: 2,
        title: "Alternative: run the command directly in CI",
      },
      {
        id: "make-schema-changes-safe-for-several-projects",
        level: 2,
        title: "Make schema changes safe for several projects",
      },
      {
        id: "sandboxes-do-not-migrate-production",
        level: 2,
        title: "Sandboxes do not migrate production",
      },
    ],
    text: "The workflow owns production migrations Your GitHub Actions workflow decides when production database migrations run. SproutOS does not scan a repository, discover a migration command, or start a migration because application code was deployed. The recommended setup is a dedicated SproutOS migrator project . Its GitHub Actions job uploads the built migrator, waits for SproutOS to finish running it, and only then allows the application projects that use that database to deploy. Give one project responsibility for each database. Do not attach the same migration to several application projects and let them race. Recommended: deploy a migrator project first Build the migrator separately from the request-serving application and pass it to the deploy action with migration-directory . The action waits for a terminal result, so GitHub's needs dependency is the gate between the schema and the applications: name: Migrate and deploy to SproutOS on: push: branches: [main] permissions: contents: read id-token: write jobs: migrate: runs-on: ubuntu-latest steps: - uses: actions/checkout@v5 - uses: actions/setup-node@v4 with: node-version: 22 - run: npm ci - run: npm run build:migrator - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 with: preset: hono directory: apps/migrator/dist project: my-app-migrator migration-directory: apps/migrator/dist migration-handler: migrate.handler api-url: https://api.sproutos.me deploy-web: needs: migrate runs-on: ubuntu-latest steps: - uses: actions/checkout@v5 - uses: actions/setup-node@v4 with: node-version: 22 - run: npm ci - run: npm run build - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 with: preset: next directory: apps/website/.next/standalone project: my-app-web api-url: https://api.sproutos.me Replace the commands, preset, directories, and handler with the repository's real build. The migrator project is a deployable project, but it should not be the group's customer-facing primary project. Add needs: migrate to every job that deploys code against the migrated database. When several applications share one database, they may deploy in parallel after that one migration succeeds. When applications use different databases, give each database its own migrator job and depend only on the relevant one. SproutOS runs the uploaded migrator with that project's production environment, including its DATABASE_URL , before publishing the migrator project's new version. A failed migration fails the GitHub job and leaves dependent jobs unstarted. SproutOS does not retry a migration automatically: after a failure, inspect whether it partially applied before starting another run. Alternative: run the command directly in CI You may run the repository's migration command directly on the GitHub runner instead. In that model, GitHub needs a production database credential stored as an Actions secret; the OIDC token used by the SproutOS deploy action is not a database credential. jobs: migrate: runs-on: ubuntu-latest env: DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }} steps: - uses: actions/checkout@v5 - uses: actions/setup-node@v4 with: node-version: 22 - run: npm ci - run: npm run migrate deploy-web: needs: migrate # Build and deploy the application here. Use this pattern when the migration cannot run in the SproutOS migrator runtime or your existing CI already owns database access. Never commit the connection URI or print it in workflow output. Make schema changes safe for several projects The old application versions keep serving until their deployment jobs finish. Write migrations so both old and new code can use the intermediate schema: add before removing, deploy readers before dropping old columns, and move destructive cleanup into a later migration. Do not run migrations during application startup. Several function instances may start at once, which turns one schema change into concurrent migration attempts. If a project has no database or no migrations, say so in the workflow or repository instructions rather than leaving ownership ambiguous. Sandboxes do not migrate production A SproutOS coding-agent sandbox starts without DATABASE_URL . The agent can request a named, disposable 24-hour branch of the project's database through its scoped sandbox action. Run migrations against that isolated branch to verify the schema, seed data, and application together. A successful sandbox migration does not replace the GitHub Actions migration job and does not prove that production was migrated.",
  },
  {
    slug: "github-action",
    title: "Deploy from GitHub or your local agent",
    summary:
      "Use the same sprout deployment contract from GitHub Actions, a terminal, or a coding-agent harness.",
    audience: "developer",
    category: "Deploying",
    order: 3,
    headings: [
      {
        id: "github-actions",
        level: 2,
        title: "GitHub Actions",
      },
      {
        id: "run-the-same-deployment-locally",
        level: 2,
        title: "Run the same deployment locally",
      },
      {
        id: "give-a-local-coding-agent-the-sproutos-skill",
        level: 2,
        title: "Give a local coding agent the SproutOS skill",
      },
      {
        id: "deployment-templates",
        level: 2,
        title: "Deployment templates",
      },
    ],
    text: "GitHub Actions Build the target, then call the Marketplace action. The reviewed action at commit 0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 is a thin wrapper around the published sprout CLI v0.1.0. The local CLI is v0.1.2 because it corrects the production control-plane defaults and publishes direct static deploys through the same asset path as the action; both use the same packaging and deployment protocol. name: Deploy to SproutOS on: push: branches: [main] permissions: contents: read id-token: write jobs: deploy: runs-on: ubuntu-latest steps: - uses: actions/checkout@v5 - uses: actions/setup-node@v4 with: node-version: 22 - run: npm ci - run: npm run build - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 with: preset: next directory: apps/website/.next/standalone project: my-web-project api-url: https://api.sproutos.me id-token: write lets GitHub identify the repository to SproutOS without a stored deployment secret. Do not add a long-lived SproutOS token to GitHub for this workflow. The platform verifies the repository and workflow identity before issuing a short-lived deployment credential. The action uploads build output; it does not decide how your application builds. Use next , hono , web , static , or android as the preset and point directory at the finished artifact. In a monorepo, use one workflow step per deployable target and always name project . Internally, the wrapper exchanges GitHub's OIDC assertion for a short-lived deployment token and passes it to the pinned CLI through the environment, never a command-line argument. That token is not a secret developers create or store. The action waits for a terminal deployment state. A missing artifact or rejected repository identity fails the GitHub job instead of reporting a successful upload. Production migrations remain part of the customer's GitHub Actions workflow. Use a dedicated migrator project and make application deploy jobs wait for it, or run the migration command directly in CI. See /docs/database-migrations Run database migrations for both patterns and their failure boundaries. Run the same deployment locally Install sprout from the checksummed binaries in the https://github.com/MySproutOS/SproutOS/releases/tag/cli-v0.1.2 SproutOS CLI v0.1.2 release , then sign in and deploy: sprout auth login sprout org use my-team sprout deploy my-web-project --preset next \\ --path apps/website/.next/standalone Browser login uses PKCE and stores the resulting credential in your operating system's credential store. SPROUTOS_TOKEN is the headless CI path; do not put it in a repository or pass it on a command line that will be saved in shell history. Every command also supports stable --json output for scripts and coding agents. Destructive commands require confirmation or --yes . The release contains macOS arm64 and x86-64, Linux arm64 and x86-64, and Windows x86-64 binaries, plus SHA256SUMS and sprout-v0.1.2-manifest.json . Verify the selected archive against both files. The action also verifies GitHub's artifact attestation and the release's exact source revision before it executes the binary. Give a local coding agent the SproutOS skill Download /skills/sproutos/SKILL.md the public SproutOS skill . It teaches an agent the project, service, environment, migration, template, and deployment boundaries without starting a paid SproutOS sandbox. Claude Code: save it as .claude/skills/sproutos/SKILL.md in the repository. Codex: save it as ~/.codex/skills/sproutos/SKILL.md for your account. An AGENTS.md -only harness: preserve the existing file and add a short instruction telling the agent to read the downloaded SKILL.md ; do not replace repository instructions. A local agent uses your computer and the model account configured in your harness. SproutOS does not charge sandbox time or model usage for that work. Databases, deployments, storage, and other SproutOS resources created by the agent are still metered normally. The skill is instructions, not a credential. Authenticate the sprout CLI yourself, or set SPROUTOS_TOKEN only in a trusted headless environment. Deployment templates App Store eligibility and deployment behavior come only from the signed MySproutOS/Deployment-Templates catalogue. SproutOS verifies the catalogue provenance, exact upstream commit, and immutable plugin digest before applying a recipe. The reviewed template source at commit c86dfdb7f055cb6cdf499b23f84ab91d640ca7a1 generates the canonical OIDC workflows for Umami and Memos. Those workflows pin the deploy action to the full commit above; they do not follow a mutable action tag. Generated forks may contain .config/sproutos.toml . It is declarative, contains no secret values, and helps humans and agents understand the chosen services and bindings. It is not the catalogue authority and cannot choose or replace executable template code. Never discover deployment behavior from an instruction file in an arbitrary upstream repository. Template plugins run without network, GitHub, SproutOS, or customer credentials; the control-plane worker owns provisioning, commits, pushes, and deployment.",
  },
  {
    slug: "limits",
    title: "Limits",
    summary: "Function duration, request size, memory, and concurrency.",
    audience: "user",
    category: "Billing & limits",
    order: 3,
    headings: [
      {
        id: "runtime",
        level: 2,
        title: "Runtime",
      },
      {
        id: "payloads-and-builds",
        level: 2,
        title: "Payloads and builds",
      },
      {
        id: "concurrency",
        level: 2,
        title: "Concurrency",
      },
    ],
    text: "Runtime An invocation runs for at most 15 minutes. Split longer jobs and enqueue the remainder. Memory is configurable from 128 MB to 10 GB and CPU grows with memory. Payloads and builds Request and response bodies are limited to 6 MB; use object storage for larger data. The deploy tooling refuses application bundles over 200 MB uncompressed, ahead of Lambda's 250 MB hard limit. Concurrency Invocations may run concurrently in isolated environments. Pools created at module scope may be reused by a warm instance; never store a user's session or request state there.",
  },
  {
    slug: "navigation",
    title: "Navigate SproutOS",
    summary: "Where repositories, deployable projects, workflows, services, and usage live.",
    audience: "user",
    category: "Getting started",
    order: 1,
    headings: [
      {
        id: "organizations-and-groups",
        level: 2,
        title: "Organizations and groups",
      },
      {
        id: "projects-and-domains",
        level: 2,
        title: "Projects and domains",
      },
      {
        id: "databases-and-other-services",
        level: 2,
        title: "Databases and other services",
      },
      {
        id: "workflows-and-agents",
        level: 2,
        title: "Workflows and agents",
      },
      {
        id: "billing-and-deletion",
        level: 2,
        title: "Billing and deletion",
      },
    ],
    text: "Organizations and groups An organization owns billing and access. A group is one GitHub repository. Its child projects are the deployable targets inside that repository, such as a web app and an API. Open Projects to see groups and their children. Group settings hold repository-wide choices such as upstream updates and the primary deployed project. Projects and domains A project is one deployable directory and branch. Its overview shows the live SproutOS hostname; Domains adds a custom hostname. Environment stores encrypted variables and Observability shows requests, logs, and failures. Databases and other services Use Databases for Postgres and the project service screens for Valkey, search, and object storage. Postgres, Valkey, and search credentials are shown once when created or rotated. Object-storage credentials can be viewed again because their secret is derived; rotation still revokes the previous credential. Workflows and agents Workflows attached to a repository appear inside its group. The global Workflows page is for standalone automation repositories. Agent conversations and previews stay with the project they modify. Billing and deletion Billing groups measured usage by service and keeps an append-only credit ledger. Deleting a project tears down its resources but retains billing and audit history. GitHub repositories are retained unless you explicitly select them for deletion.",
  },
  {
    slug: "oauth-applications",
    title: "Build a SproutOS OAuth application",
    summary: "Authorization Code with PKCE, optional database access, tokens, and revocation.",
    audience: "developer",
    category: "Building on SproutOS",
    order: 4,
    headings: [
      {
        id: "register-and-redirect",
        level: 2,
        title: "Register and redirect",
      },
      {
        id: "ask-only-for-needed-access",
        level: 2,
        title: "Ask only for needed access",
      },
      {
        id: "tokens-and-credentials",
        level: 2,
        title: "Tokens and credentials",
      },
      {
        id: "revocation",
        level: 2,
        title: "Revocation",
      },
    ],
    text: "Register and redirect Register an OAuth client in SproutOS and add exact HTTPS redirect URIs. Public clients must use Authorization Code with PKCE ( S256 ) and must never ship a client secret. Send users to the authorization endpoint with client_id , redirect_uri , response_type=code , code_challenge , code_challenge_method=S256 , state , and the scopes you need. Validate state before exchanging the returned code. Ask only for needed access Database creation uses database:create and spends the user's SproutOS credit. When the authorization request includes intent=create_personal_database , consent explains the expected billing. The user may omit that optional permission and still sign in to your application. Pressing Cancel stops authorization. A grant may include database creation even when the account has no credit. The creation request itself returns HTTP 402 until credit is available. Tokens and credentials Exchange the code with its original code_verifier . Send access tokens as Authorization: Bearer … . Refresh tokens are rotated; replace the stored refresh token after every successful refresh. Database credentials belong to the OAuth grant that created them. Rotating an application credential does not rotate the user's credential or another application's credential. Connection URIs are returned once and cannot be revealed later. Revocation Users can revoke your grant from settings. Revocation stops new API calls and revokes credentials owned by that grant. Resources the user chooses to keep remain theirs.",
  },
  {
    slug: "object-storage",
    title: "Use object storage",
    summary:
      "Connect ordinary S3 SDKs to mutable application storage through the SproutOS storage proxy.",
    audience: "developer",
    category: "Building on SproutOS",
    order: 2,
    headings: [
      {
        id: "mutable-storage-and-static-deployments",
        level: 2,
        title: "Mutable storage and static deployments",
      },
      {
        id: "get-the-connection-values",
        level: 2,
        title: "Get the connection values",
      },
      {
        id: "python-with-boto3",
        level: 2,
        title: "Python with boto3",
      },
      {
        id: "typescript-with-the-aws-sdk",
        level: 2,
        title: "TypeScript with the AWS SDK",
      },
      {
        id: "supported-operations-and-limits",
        level: 2,
        title: "Supported operations and limits",
      },
      {
        id: "metering-and-credit-cutoff",
        level: 2,
        title: "Metering and credit cutoff",
      },
    ],
    text: 'Mutable storage and static deployments Object storage is mutable application data: uploads, photos, attachments, exports, and other files your application reads and changes while it runs. An ordinary S3 SDK talks to the SproutOS storage endpoint, which authenticates the project, confines every request to its bucket, and forwards it to S3. A static deployment is different. SproutOS expands an immutable build artifact and serves it through CloudFront. Customers do not receive credentials to edit that release in place; publish another deployment to change it. Get the connection values Open Databases , find the object-storage service, and select View credentials . The panel provides: S3_ENDPOINT S3_REGION S3_BUCKET_NAME S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE=true The project receives the same values as encrypted environment variables when the service is attached. Object storage is the exception to the usual one-time credential rule: View credentials can reconstruct its derived secret later. Keep it private. Rotating or deleting the credential revokes the old access at the SproutOS proxy; it is not an AWS credential and cannot be used against AWS directly. Python with boto3 import os import boto3 from botocore.config import Config s3 = boto3.client( "s3", endpoint_url=os.environ["S3_ENDPOINT"], region_name=os.environ["S3_REGION"], aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"], config=Config(s3={"addressing_style": "path"}), ) bucket = os.environ["S3_BUCKET_NAME"] s3.put_object(Bucket=bucket, Key="photos/cat.jpg", Body=image_bytes) photo = s3.get_object(Bucket=bucket, Key="photos/cat.jpg")["Body"].read() Do not set an AWS session token. Always pass the displayed endpoint and use path-style addressing; the bucket must remain in the URL path rather than the hostname. TypeScript with the AWS SDK import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3" const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!, }, forcePathStyle: true, }) const Bucket = process.env.S3_BUCKET_NAME! await s3.send(new PutObjectCommand({ Bucket, Key: "exports/report.json", Body: report })) const stored = await s3.send(new GetObjectCommand({ Bucket, Key: "exports/report.json" })) Supported operations and limits Object reads, writes, heads, deletes, listings, and ordinary SDK multipart uploads are supported. Multipart upload is the right choice when one upload request would exceed the service\'s per-request body limit. Presigned URLs, virtual-host bucket addressing, SigV4 streaming-chunked uploads, server-side CopyObject , and conditional or range reads are not supported. Download the source and upload a new object instead of using CopyObject ; download a whole object rather than depending on a byte range. A presigned URL would let a request outlive the live credential check, virtual-host addressing would move the tenant decision into customer-controlled DNS, and streaming-chunked SigV4 requires verification of every signed frame. The proxy spools an upload to bounded disk while verifying its payload signature, then streams it to S3. Downloads stream with backpressure rather than being loaded into application memory. Metering and credit cutoff Object storage meters write and list requests, read requests, bytes delivered outside AWS, and stored byte-time. Deletes are not charged. SproutOS adds no platform markup to these dimensions. The billing system protects enough spendable credit for 48 hours of the latest measured stored bytes. When the remaining credit reaches that reserve, new storage requests are refused while the already-funded retention window keeps the data. Add credit before retrying a refused request.',
  },
] as const
