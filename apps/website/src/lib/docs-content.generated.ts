// Generated from src/content/docs/*.md by scripts/generate-docs.ts.
// Markdoc renderable trees. Server-only: see the note in scripts/generate-docs.ts.
import type { RenderableTreeNode } from "@markdoc/markdoc"

export const GENERATED_DOC_CONTENT: Record<string, RenderableTreeNode[]> = {
  "background-workers": [
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "how-work-starts",
      },
      children: ["How work starts"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "SproutOS invokes your application when a queue has work. Handle the ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["queue.drain"],
        },
        " event, process the supplied batch, and return. The same deployed function can serve HTTP and workflow invocations.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "return-when-work-is-done",
      },
      children: ["Return when work is done"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Compute is billed in GB-seconds until the handler returns. Close database connections and do not leave a Redis subscribe, blocking read, timer, or worker loop alive. SproutOS invokes the function again when more work arrives.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Use a workflow step for work that must continue later. Split work that cannot finish within one invocation, enqueue the remainder, and return.",
      ],
    },
  ],
  billing: [
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "usage-and-credit",
      },
      children: ["Usage and credit"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Usage is recorded in an append-only ledger and grouped by service. Line items retain sub-cent precision; spendable credit is displayed in cents. SproutOS is prepaid: new work is refused once spendable credit is exhausted, delayed usage is capped at the available credit when posted, and provider-backed work cannot settle past the credit available after its reservation is released.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "queue-residency",
      },
      children: ["Queue residency"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Queue residency is queued payload bytes multiplied by how long they remain queued. It is storage over time, not a count of jobs and not ordinary cache usage.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "platform-fees",
      },
      children: ["Platform fees"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Dimensions without an item-specific override use the standard 12% platform fee. Postgres compute has a 2% fee. Postgres storage, sandbox resources and egress, platform-funded AI, and operational agent duration use 0%; user-funded AI is recorded as externally charged rather than billed again. Payment processing is passed through separately.",
      ],
    },
  ],
  connecting: [
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "one-time-credentials",
      },
      children: ["One-time credentials"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Provisioning or rotating a service returns its connection URI once. Put it in the project's encrypted environment variables. SproutOS stores a verifier, not a recoverable copy, so the URI cannot be revealed later.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "service-variables",
      },
      children: ["Service variables"],
    },
    {
      $$mdtype: "Tag",
      name: "ul",
      attributes: {},
      children: [
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: [
            "Postgres uses ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["DATABASE_URL"],
            },
            ".",
          ],
        },
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: [
            "Valkey uses ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["VALKEY_URL"],
            },
            " or ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["REDIS_URL"],
            },
            "; BullMQ also uses the injected ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["BULLMQ_PREFIX"],
            },
            ".",
          ],
        },
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: [
            "OpenSearch uses ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["ELASTICSEARCH_URL"],
            },
            " and automatically scopes index names.",
          ],
        },
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: [
            "Object storage uses the injected ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["S3_*"],
            },
            " values and path-style addressing.",
          ],
        },
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "All endpoints pass through tenant-enforcing SproutOS proxies. Close connections before a function returns.",
      ],
    },
  ],
  "github-action": [
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "github-actions",
      },
      children: ["GitHub Actions"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Build the target, then call the Marketplace action. The reviewed action at commit",
        " ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180"],
        },
        " is a thin wrapper around the published ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["sprout"],
        },
        " CLI",
        " ",
        "v0.1.0. The local CLI is v0.1.2 because it corrects the production control-plane defaults and",
        " ",
        "publishes direct static deploys through the same asset path as the action; both use the same",
        " ",
        "packaging and deployment protocol.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "CodeBlock",
      attributes: {
        language: "yaml",
      },
      children: [
        "name: Deploy to SproutOS\non:\n  push:\n    branches: [main]\n\npermissions:\n  contents: read\n  id-token: write\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm ci\n      - run: npm run build\n      - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180\n        with:\n          preset: next\n          directory: apps/website/.next/standalone\n          project: my-web-project\n          api-url: https://api.sproutos.me\n",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["id-token: write"],
        },
        " lets GitHub identify the repository to SproutOS without a stored deployment",
        " ",
        "secret. Do not add a long-lived SproutOS token to GitHub for this workflow. The platform verifies",
        " ",
        "the repository and workflow identity before issuing a short-lived deployment credential.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "The action uploads build output; it does not decide how your application builds. Use ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["next"],
        },
        ",",
        " ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["hono"],
        },
        ", ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["web"],
        },
        ", ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["static"],
        },
        ", or ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["android"],
        },
        " as the preset and point ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["directory"],
        },
        " at the finished artifact. In a",
        " ",
        "monorepo, use one workflow step per deployable target and always name ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["project"],
        },
        ".",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Internally, the wrapper exchanges GitHub's OIDC assertion for a short-lived deployment token and",
        " ",
        "passes it to the pinned CLI through the environment, never a command-line argument. That token is",
        " ",
        "not a secret developers create or store.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "The action waits for a terminal deployment state. A failed migration, missing artifact, or rejected",
        " ",
        "repository identity fails the GitHub job instead of reporting a successful upload.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "run-the-same-deployment-locally",
      },
      children: ["Run the same deployment locally"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Install ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["sprout"],
        },
        " from the checksummed binaries in the",
        " ",
        {
          $$mdtype: "Tag",
          name: "DocLink",
          attributes: {
            href: "https://github.com/MySproutOS/SproutOS/releases/tag/cli-v0.1.2",
          },
          children: ["SproutOS CLI v0.1.2 release"],
        },
        ", then",
        " ",
        "sign in and deploy:",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "CodeBlock",
      attributes: {
        language: "shell",
      },
      children: [
        "sprout auth login\nsprout org use my-team\nsprout deploy my-web-project --preset next \\\n  --path apps/website/.next/standalone\n",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Browser login uses PKCE and stores the resulting credential in your operating system's credential",
        " ",
        "store. ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["SPROUTOS_TOKEN"],
        },
        " is the headless CI path; do not put it in a repository or pass it on a",
        " ",
        "command line that will be saved in shell history.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Every command also supports stable ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["--json"],
        },
        " output for scripts and coding agents. Destructive",
        " ",
        "commands require confirmation or ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["--yes"],
        },
        ".",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "The release contains macOS arm64 and x86-64, Linux arm64 and x86-64, and Windows x86-64 binaries,",
        " ",
        "plus ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["SHA256SUMS"],
        },
        " and ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["sprout-v0.1.2-manifest.json"],
        },
        ". Verify the selected archive against both files.",
        " ",
        "The action also verifies GitHub's artifact attestation and the release's exact source revision",
        " ",
        "before it executes the binary.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "give-a-local-coding-agent-the-sproutos-skill",
      },
      children: ["Give a local coding agent the SproutOS skill"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Download ",
        {
          $$mdtype: "Tag",
          name: "DocLink",
          attributes: {
            href: "/skills/sproutos/SKILL.md",
          },
          children: ["the public SproutOS skill"],
        },
        ". It teaches an agent the project,",
        " ",
        "service, environment, migration, template, and deployment boundaries without starting a paid",
        " ",
        "SproutOS sandbox.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "ul",
      attributes: {},
      children: [
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: [
            "Claude Code: save it as ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: [".claude/skills/sproutos/SKILL.md"],
            },
            " in the repository.",
          ],
        },
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: [
            "Codex: save it as ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["~/.codex/skills/sproutos/SKILL.md"],
            },
            " for your account.",
          ],
        },
        {
          $$mdtype: "Tag",
          name: "li",
          attributes: {},
          children: [
            "An ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["AGENTS.md"],
            },
            "-only harness: preserve the existing file and add a short instruction telling the",
            " ",
            "agent to read the downloaded ",
            {
              $$mdtype: "Tag",
              name: "code",
              attributes: {},
              children: ["SKILL.md"],
            },
            "; do not replace repository instructions.",
          ],
        },
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "A local agent uses your computer and the model account configured in your harness. SproutOS does",
        " ",
        "not charge sandbox time or model usage for that work. Databases, deployments, storage, and other",
        " ",
        "SproutOS resources created by the agent are still metered normally.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "The skill is instructions, not a credential. Authenticate the ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["sprout"],
        },
        " CLI yourself, or set",
        " ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["SPROUTOS_TOKEN"],
        },
        " only in a trusted headless environment.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "deployment-templates",
      },
      children: ["Deployment templates"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "App Store eligibility and deployment behavior come only from the signed",
        " ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["MySproutOS/Deployment-Templates"],
        },
        " catalogue. SproutOS verifies the catalogue provenance, exact",
        " ",
        "upstream commit, and immutable plugin digest before applying a recipe.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "The reviewed template source at commit ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["c86dfdb7f055cb6cdf499b23f84ab91d640ca7a1"],
        },
        " generates the",
        " ",
        "canonical OIDC workflows for Umami and Memos. Those workflows pin the deploy action to the full",
        " ",
        "commit above; they do not follow a mutable action tag.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Generated forks may contain ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: [".config/sproutos.toml"],
        },
        ". It is declarative, contains no secret values,",
        " ",
        "and helps humans and agents understand the chosen services and bindings. It is not the catalogue",
        " ",
        "authority and cannot choose or replace executable template code.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Never discover deployment behavior from an instruction file in an arbitrary upstream repository.",
        " ",
        "Template plugins run without network, GitHub, SproutOS, or customer credentials; the control-plane",
        " ",
        "worker owns provisioning, commits, pushes, and deployment.",
      ],
    },
  ],
  limits: [
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "runtime",
      },
      children: ["Runtime"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "An invocation runs for at most 15 minutes. Split longer jobs and enqueue the remainder. Memory is configurable from 128 MB to 10 GB and CPU grows with memory.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "payloads-and-builds",
      },
      children: ["Payloads and builds"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Request and response bodies are limited to 6 MB; use object storage for larger data. The deploy tooling refuses application bundles over 200 MB uncompressed, ahead of Lambda's 250 MB hard limit.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "concurrency",
      },
      children: ["Concurrency"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Invocations may run concurrently in isolated environments. Pools created at module scope may be reused by a warm instance; never store a user's session or request state there.",
      ],
    },
  ],
  navigation: [
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "organizations-and-groups",
      },
      children: ["Organizations and groups"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "An organization owns billing and access. A ",
        {
          $$mdtype: "Tag",
          name: "strong",
          attributes: {},
          children: ["group"],
        },
        " is one GitHub repository. Its child projects are the deployable targets inside that repository, such as a web app and an API.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Open ",
        {
          $$mdtype: "Tag",
          name: "strong",
          attributes: {},
          children: ["Projects"],
        },
        " to see groups and their children. Group settings hold repository-wide choices such as upstream updates and the primary deployed project.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "projects-and-domains",
      },
      children: ["Projects and domains"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "A project is one deployable directory and branch. Its overview shows the live SproutOS hostname; ",
        {
          $$mdtype: "Tag",
          name: "strong",
          attributes: {},
          children: ["Domains"],
        },
        " adds a custom hostname. ",
        {
          $$mdtype: "Tag",
          name: "strong",
          attributes: {},
          children: ["Environment"],
        },
        " stores encrypted variables and ",
        {
          $$mdtype: "Tag",
          name: "strong",
          attributes: {},
          children: ["Observability"],
        },
        " shows requests, logs, and failures.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "databases-and-other-services",
      },
      children: ["Databases and other services"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Use ",
        {
          $$mdtype: "Tag",
          name: "strong",
          attributes: {},
          children: ["Databases"],
        },
        " for Postgres and the project service screens for Valkey, search, and object storage. A connection credential is shown once when it is created or rotated. Store it in a project environment variable; it cannot be revealed later.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "workflows-and-agents",
      },
      children: ["Workflows and agents"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Workflows attached to a repository appear inside its group. The global ",
        {
          $$mdtype: "Tag",
          name: "strong",
          attributes: {},
          children: ["Workflows"],
        },
        " page is for standalone automation repositories. Agent conversations and previews stay with the project they modify.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "billing-and-deletion",
      },
      children: ["Billing and deletion"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Billing groups measured usage by service and keeps an append-only credit ledger. Deleting a project tears down its resources but retains billing and audit history. GitHub repositories are retained unless you explicitly select them for deletion.",
      ],
    },
  ],
  "oauth-applications": [
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "register-and-redirect",
      },
      children: ["Register and redirect"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Register an OAuth client in SproutOS and add exact HTTPS redirect URIs. Public clients must use Authorization Code with PKCE (",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["S256"],
        },
        ") and must never ship a client secret.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Send users to the authorization endpoint with ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["client_id"],
        },
        ", ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["redirect_uri"],
        },
        ", ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["response_type=code"],
        },
        ", ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["code_challenge"],
        },
        ", ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["code_challenge_method=S256"],
        },
        ", ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["state"],
        },
        ", and the scopes you need. Validate ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["state"],
        },
        " before exchanging the returned code.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "ask-only-for-needed-access",
      },
      children: ["Ask only for needed access"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Database creation uses ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["database:create"],
        },
        " and spends the user's SproutOS credit. When the authorization request includes ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["intent=create_personal_database"],
        },
        ", consent explains the expected billing. The user may omit that optional permission and still sign in to your application. Pressing Cancel stops authorization.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "A grant may include database creation even when the account has no credit. The creation request itself returns HTTP 402 until credit is available.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "tokens-and-credentials",
      },
      children: ["Tokens and credentials"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Exchange the code with its original ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["code_verifier"],
        },
        ". Send access tokens as ",
        {
          $$mdtype: "Tag",
          name: "code",
          attributes: {},
          children: ["Authorization: Bearer …"],
        },
        ". Refresh tokens are rotated; replace the stored refresh token after every successful refresh.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Database credentials belong to the OAuth grant that created them. Rotating an application credential does not rotate the user's credential or another application's credential. Connection URIs are returned once and cannot be revealed later.",
      ],
    },
    {
      $$mdtype: "Tag",
      name: "Heading",
      attributes: {
        level: 2,
        id: "revocation",
      },
      children: ["Revocation"],
    },
    {
      $$mdtype: "Tag",
      name: "p",
      attributes: {},
      children: [
        "Users can revoke your grant from settings. Revocation stops new API calls and revokes credentials owned by that grant. Resources the user chooses to keep remain theirs.",
      ],
    },
  ],
}
