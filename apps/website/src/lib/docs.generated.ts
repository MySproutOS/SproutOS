// Generated from src/content/docs/*.md by scripts/generate-docs.ts.
// Metadata and search text only — safe to import from a client component.
export const GENERATED_DOCS = [
  {
    slug: "agent-model-providers",
    title: "Configure an AI model provider",
    summary:
      "Add an organization model credential, understand which coding harness runs, and rotate or revoke it safely.",
    audience: "user",
    category: "Hosted Agent",
    order: 30,
    headings: [
      {
        id: "choose-a-credential-kind",
        level: 2,
        title: "Choose a credential kind",
      },
      {
        id: "name-and-protect-credentials",
        level: 2,
        title: "Name and protect credentials",
      },
      {
        id: "advanced-configuration",
        level: 2,
        title: "Advanced configuration",
      },
    ],
    text: "The hosted Agent needs either your organization's model access or SproutOS-funded model credit. Open Settings → Agent to manage credentials. Choose a credential kind SproutOS accepts: a Claude subscription token; an Anthropic API key; an OpenAI API key; an OpenRouter API key. Claude subscription and Anthropic credentials run through Claude Code. OpenAI and OpenRouter credentials run through Codex. The secret is sealed before storage, is isolated to the organization, and is never shown again. The dashboard keeps only the label, kind, status, and last four characters needed to identify it. Adding the first credential selects it when the organization has no Agent configuration. Adding more credentials does not silently move existing work to a new provider. Name and protect credentials Use labels that identify owner and purpose, such as Engineering OpenAI rather than Key 1 . Create a dedicated provider credential with an appropriate spend limit. Do not paste the secret into a project environment variable or repository—the Agent proxy supplies model access without revealing the raw provider key to the sandbox. The dashboard can rename a label or revoke a credential. It cannot reveal or replace the stored secret. To rotate, add the replacement, select it for Agent use, verify a turn, and then revoke the old credential. Revoking the selected credential stops new Agent work. SproutOS does not silently fall back to a platform-funded model and begin charging the organization merely because a credential was revoked. Advanced configuration The authenticated organization Agent configuration API can select agentCredentialId , opt into useSproutosCredits , set a model, set a maximum budget in micro-US dollars, and choose the harness permission mode. These controls are not all exposed in the current dashboard. Use sprout api get to inspect the live configuration before changing it, and change only fields you understand. Provider billing and SproutOS resource billing are distinct. A bring-your-own provider bills model tokens to that provider; sandbox duration, databases, storage, and deployments remain SproutOS resources. See /docs/billing Understand billing .",
  },
  {
    slug: "agent-sandboxes",
    title: "Work with Agent sandboxes",
    summary:
      "Understand isolated workspaces, preview ports, disposable database branches, pushed changes, and cleanup.",
    audience: "user",
    category: "Hosted Agent",
    order: 31,
    headings: [
      {
        id: "what-the-agent-can-do",
        level: 2,
        title: "What the Agent can do",
      },
      {
        id: "preview-a-development-server",
        level: 2,
        title: "Preview a development server",
      },
      {
        id: "request-a-disposable-database-branch",
        level: 2,
        title: "Request a disposable database branch",
      },
      {
        id: "understand-what-persists",
        level: 2,
        title: "Understand what persists",
      },
    ],
    text: "Each hosted Agent session works in an isolated sandbox with the project repository checked out. The sandbox is for editing and testing code; it is not the production deployment and it does not inherit production runtime secrets. What the Agent can do The Agent can edit files, install packages, run tests, start a development server, and use public HTTP or HTTPS through the SproutOS egress proxy. It receives short-lived, scoped platform actions for operations such as choosing a group's primary project or requesting a database branch. It does not receive raw model-provider credentials or infrastructure credentials. Conversation history and streamed tool results stay with the project, so reopening the session does not require reconstructing what changed from a final message alone. Preview a development server Start the application on 0.0.0.0 , not 127.0.0.1 , and use a supported port such as 3000, 5173, or 8080. Open Preview , select the port, and use the embedded preview or signed external link. A preview proves the process in the sandbox is reachable. It does not prove a production build, deployment, domain, environment, or migration. After checking the UI, still build and deploy the intended artifact and verify its production hostname. Request a disposable database branch Sandboxes begin without DATABASE_URL . When database-backed code must run, the Agent can request a named Postgres branch copied from the project's primary branch. The returned connection reaches only that temporary copy and is carried through the sandbox network proxy. Use it to run migrations and tests without changing production data. A branch lasts at most 24 hours and each sandbox may own up to four active branches. Delete it after the test; ending the sandbox removes any remaining branches. Understand what persists The Agent stages, commits, and pushes repository changes to a sproutos/agent-* branch, never the production branch. Those GitHub commits remain after the sandbox is destroyed and can be reviewed or merged through the repository's normal controls. Processes, temporary files outside the repository, previews, and disposable database branches do not outlive sandbox cleanup. Selecting Done destroys the sandbox and its temporary database branches; it does not delete the pushed GitHub branch. Sandboxes stop after inactivity, so persist useful work in the repository and do not treat a detached preview as a hosted service.",
  },
  {
    slug: "android-distribution",
    title: "Distribute an Android app",
    summary:
      "Build an unsigned APK, let SproutOS protect the signing key, publish releases, and verify installs and updates.",
    audience: "developer",
    category: "Deploying",
    order: 4,
    headings: [
      {
        id: "keep-the-application-identity-stable",
        level: 2,
        title: "Keep the application identity stable",
      },
      {
        id: "establish-protected-signing-custody",
        level: 2,
        title: "Establish protected signing custody",
      },
      {
        id: "publish-from-github-actions",
        level: 2,
        title: "Publish from GitHub Actions",
      },
      {
        id: "understand-personal-and-public-availability",
        level: 2,
        title: "Understand personal and public availability",
      },
      {
        id: "control-automatic-updates",
        level: 2,
        title: "Control automatic updates",
      },
      {
        id: "test-installation-and-updating",
        level: 2,
        title: "Test installation and updating",
      },
      {
        id: "prepare-useful-listing-content",
        level: 2,
        title: "Prepare useful listing content",
      },
    ],
    text: "SproutOS distributes Android apps directly from the website. It does not publish Google Play tracks. A project uploads one raw unsigned APK; the on-premises signer produces the installable APK without exposing the app signing private key to a developer machine, GitHub Actions, or the control plane. Keep the application identity stable Choose the Android application id before the first production release and do not change it. Every update must use the same application id and signing identity, and its Android versionCode must be greater than the installed release. The SproutOS Android client uses com.sproutos.store . A different id is a different app to Android, so it cannot update an existing installation in place. Build a release APK that is deliberately unsigned. Do not upload an Android App Bundle ( .aab ), a ZIP containing an APK, or an APK already signed by a developer key. The CLI validates this boundary before uploading. Establish protected signing custody An authorized project owner runs the Android setup command once: sprout android setup my-android-app sprout android status my-android-app Setup creates or imports the project's signing identity through the protected signer. Treat this as a custody operation: back up any permitted recovery material according to your organization policy, restrict who can rotate it, and never commit keystores, passwords, or exported private keys. Setup and signing do not register the application with Google. A SproutOS operator adds the exact application id and public certificate fingerprint to the existing Play Console organization using its manual Add key flow. The signer has no Google credential and never exposes the private key. sprout android status shows the public fingerprint and registration state. A signed release stays hidden until Google's independent Android Developer ID Status API reports REGISTERED for that exact application id and fingerprint. A new package normally needs only that fingerprint. If Play asks for an ownership APK containing assets/adi-registration.properties for an existing package or additional key, stop and contact SproutOS operations for a future custody-safe workflow. Never export or regenerate the protected key, substitute a debug key, or build the proof APK outside the signer custody boundary. Before the first public release, record and independently compare the certificate fingerprint: sprout android verify my-android-app --commit <40-character-source-commit> The verified source commit, application id, signing-certificate digest, version code, and artifact digest form the release identity. A mismatch must fail closed; do not work around it by uninstalling the existing app or accepting a new key. Publish from GitHub Actions Build the unsigned APK, then pass the containing directory to the pinned Marketplace action: name: Publish Android app on: push: tags: [\"android-v*\"] permissions: contents: read id-token: write jobs: publish: runs-on: ubuntu-latest steps: - uses: actions/checkout@v5 - uses: actions/setup-java@v4 with: distribution: temurin java-version: \"21\" - uses: gradle/actions/setup-gradle@v4 - run: ./gradlew assembleRelease - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 with: preset: android directory: app/build/outputs/apk/release project: my-android-app api-url: https://api.sproutos.me The directory must contain exactly one APK. The action authenticates with GitHub OIDC and passes a short-lived, repository-bound token to the CLI; do not add a long-lived SproutOS secret. The same artifact can be deployed locally with: sprout deploy my-android-app --preset android \\ --path app/build/outputs/apk/release/app-release-unsigned.apk \\ --version-code 42 Understand personal and public availability A ready, verified, signed app appears in the Personal tab for members of its SproutOS organization. “Personal” describes who can discover and request the download through SproutOS; it does not claim that the deployed app or website runtime is private. Public store publication is a separate reviewed action. A store moderator selects one exact Android app identity as the listing's canonical release. Forks keep their source listing as provenance, but that link never makes a customer's personalized fork public. Archiving, rejecting, or changing the listing away from Android clears the canonical release and stops new anonymous download URLs from being issued. Download URLs are short-lived bearer URLs. Authorization is checked when SproutOS issues one; a URL that was already issued remains usable until its one-hour expiry. For an urgent artifact revocation, contact SproutOS operations instead of relying only on unpublishing the listing. Control automatic updates The Android client has separate switches for updating SproutOS itself and updating apps already installed through SproutOS. Both are enabled initially and can be turned off independently. The client checks approximately once an hour through Android WorkManager, only on an unmetered network and while the battery and storage are not low. Android may defer that work further. Automatic work is update-only. It never installs a new catalogue app, downgrades an installed app, or replaces an app whose package name or signing certificate differs from the verified release. The client still downloads the exact higher version and verifies its published byte size, SHA-256, package name, version, and signing certificate before asking Android to install it. On supported Android versions, the client asks PackageInstaller to update without another prompt only for SproutOS itself or an app for which SproutOS is the recorded installer or update owner. Android makes the final decision: device policy, OS version, target SDK, permissions, or installer ownership can still require confirmation. When that happens, SproutOS posts an actionable notification and keeps a message for the next app launch. Do not describe this as guaranteed silent or unattended updating on every device. Test installation and updating Test the public user journey on a supported Android device or emulator before announcing a release: Open the SproutOS Android client and authenticate. Find the listing and check its title, summary, icon, screenshots, release version, download size, permissions, privacy/support links, and update notes. Install it from the website-backed catalogue and launch the installed application. Publish a higher versionCode , return to the listing, install the update, and confirm Android updates in place without changing the application id or losing app data. Compare the installed certificate digest and artifact digest with the release record, then verify failed or superseded releases cannot be downloaded as current. Exercise this flow with Mobile MCP in automated acceptance so tests interact with the same visible screens a user does. Shell-only APK installation can diagnose a build, but it does not prove authentication, catalogue discovery, listing content, download authorization, installer handoff, launch, or update behavior. If Android blocks the install, enable permission for the browser or SproutOS client to install unknown apps and retry. Do not disable Android package verification. If an update reports a signing conflict, stop: either the application id or protected signing identity changed. Prepare useful listing content A launch-ready listing needs more than an APK. Provide a concise name and summary, an accurate full description, a high-resolution icon, phone screenshots from the actual release, support and privacy URLs, release notes, and explicit content/permission disclosures. Describe what the app does and what data leaves the device; do not make claims the release cannot demonstrate. Keep the listing tied to the same immutable source commit and artifact digest shown by release verification. Test every link and screenshot at phone width, and repeat the full install/update journey after changing signing, download authorization, catalogue metadata, or Android client code.",
  },
  {
    slug: "backend-services",
    title: "Backend services",
    summary:
      "Create Postgres, Valkey, OpenSearch, or object storage as a standalone resource or attach it to a project.",
    audience: "user",
    category: "Backend services",
    order: 10,
    headings: [
      {
        id: "attached-and-standalone-services",
        level: 2,
        title: "Attached and standalone services",
      },
      {
        id: "pick-the-service-by-workload",
        level: 2,
        title: "Pick the service by workload",
      },
      {
        id: "capture-and-rotate-credentials-safely",
        level: 2,
        title: "Capture and rotate credentials safely",
      },
      {
        id: "know-the-sandbox-boundary",
        level: 2,
        title: "Know the sandbox boundary",
      },
    ],
    text: "SproutOS provides four managed backend service kinds: Postgres, Valkey, OpenSearch, and S3-compatible object storage. Open Databases to create and manage all four; the navigation name covers more than relational databases. Attached and standalone services When creating a service, choose a project or leave Project set to Standalone . Attached means SproutOS associates the service with one deployable project and writes the connection settings into that project's encrypted environment. Standalone means the service belongs to the organization without an automatic project association. It remains a SproutOS-managed service. Copy its connection value into each authorized project yourself. Choose standalone when several projects need the same data store, when a database is operated independently from an application release, or when OAuth users receive their own service. Choose attached for the common one-application, one-service case. Pick the service by workload /docs/postgres Postgres stores relational application data and supports disposable branches for safe schema work. /docs/valkey Valkey provides cache and queue primitives; BullMQ projects also receive a tenant prefix. /docs/opensearch OpenSearch provides tenant-scoped search indexes. /docs/object-storage Object storage stores mutable files through an S3-compatible API. It is private by default, supports presigned browser transfers and optional anonymous object reads, and uses multipart uploads when an individual request would exceed 64 MiB. Services are independent resources. Deploying application code does not recreate them, and rolling back a deployment does not roll back their data. Capture and rotate credentials safely Postgres, Valkey, and OpenSearch connection URIs are displayed only when created or rotated. SproutOS stores a verifier, not a recoverable plaintext copy. Save the value directly into an encrypted environment target and do not put it in source control, logs, screenshots, or shell history. If the value is lost, rotate it. Rotation revokes the previous credential, so update every consumer together. Object storage is the exception: its derived credential can be viewed again, although rotation still invalidates the old one. Know the sandbox boundary Hosted Agent sandboxes intentionally do not receive production runtime secrets. When an agent needs a database, it requests a disposable Postgres branch with a scoped action token. This prevents a code-editing session from silently gaining access to production data. See /docs/agent-sandboxes Agent sandboxes .",
  },
  {
    slug: "background-workers",
    title: "Background workers and open connections",
    summary: "Return after each batch so idle connections do not keep consuming compute.",
    audience: "developer",
    category: "Workflows",
    order: 21,
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
    order: 50,
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
    text: "Usage and credit Usage is recorded in an append-only ledger and grouped by service. Line items retain sub-cent precision; spendable credit is displayed in cents. SproutOS is prepaid: new work is refused once spendable credit is exhausted, delayed usage is capped at the available credit when posted, and provider-backed work cannot settle past the credit available after its reservation is released. Queue residency Queue residency is queued payload bytes multiplied by how long they remain queued. It is storage over time, not a count of jobs and not ordinary cache usage. Object storage Mutable object storage records write and list requests, read requests, bytes delivered outside AWS, and stored byte-time. Deletes are free. These dimensions have no SproutOS markup. Spendable credit includes a protected reserve for 48 hours of the latest measured retained data. When credit reaches that floor, active use is suspended while the funded retention window preserves the data. New deployments, workflow runs, Agent work, and service requests are refused. Adding credit clears the cutoff and restores active use. Platform fees Dimensions without an item-specific override use the standard 12% platform fee. Postgres compute has a 2% fee. Postgres storage, sandbox resources and egress, platform-funded AI, and operational agent duration use 0%; user-funded AI is recorded as externally charged rather than billed again. Payment processing is passed through separately.",
  },
  {
    slug: "cli",
    title: "Use the SproutOS CLI",
    summary:
      "Install v0.2.1, sign in, choose an organization and region, create projects, configure services, and deploy.",
    audience: "user",
    category: "Getting started",
    order: 2,
    headings: [
      {
        id: "install-and-verify-the-cli",
        level: 2,
        title: "Install and verify the CLI",
      },
      {
        id: "sign-in-and-choose-an-organization",
        level: 2,
        title: "Sign in and choose an organization",
      },
      {
        id: "create-a-project-in-an-available-region",
        level: 2,
        title: "Create a project in an available region",
      },
      {
        id: "install-from-the-app-store",
        level: 2,
        title: "Install from the App Store",
      },
      {
        id: "configure-services-and-environment-variables",
        level: 2,
        title: "Configure services and environment variables",
      },
      {
        id: "build-and-deploy",
        level: 2,
        title: "Build and deploy",
      },
      {
        id: "manage-upstream-updates-and-project-groups",
        level: 2,
        title: "Manage upstream updates and project groups",
      },
      {
        id: "script-safely-with-json-output",
        level: 2,
        title: "Script safely with JSON output",
      },
    ],
    text: 'The sprout CLI is the command-line client for SproutOS. Version 0.2.1 is the current release. It uses the same project and deployment contract as the dashboard and the GitHub Action. Install and verify the CLI Download the archive for macOS, Linux, or Windows from the https://github.com/MySproutOS/SproutOS/releases/tag/cli-v0.2.1 SproutOS CLI v0.2.1 release . The release includes SHA256SUMS and sprout-v0.2.1-manifest.json ; verify the archive against both files before running it. Then check the installed version: sprout --version # sprout 0.2.1 Sign in and choose an organization Sign in through your browser, inspect the authenticated identity, and select the organization that later commands should use: sprout auth login sprout auth status sprout org list sprout org use my-team Browser login uses PKCE. The resulting scoped credential is stored in your operating system credential store, not a plaintext configuration file. org use verifies that you can access the organization before saving its slug as the default. To use a different organization for one command, pass the global --org my-other-team option or set SPROUTOS_ORG . For a trusted headless environment, set SPROUTOS_TOKEN ; never put that value in a repository or command-line argument. The environment token takes precedence over the saved credential and sprout auth logout does not remove it. Create a project in an available region Every new project requires --region . Ask the active control plane for the regions currently accepting projects, then pass one of its exact codes: sprout region list sprout runtime list sprout project create --name my-site --region us-east-1 --blank \\ --preset next --runtime nodejs24.x sprout project get my-site Do not copy a region from an old example without checking region list : availability is a control-plane decision. A blank project uses the server\'s repository visibility default unless you pass --private or --public . You can instead connect a repository already known to SproutOS: sprout project create --name my-site --region us-east-1 \\ --repository-id 01900000-0000-7000-8000-000000000000 Use --github-repo-id for a repository visible to the installed GitHub App. For a repository GitHub cannot identify as a fork, add --upstream owner/repository . Root-directory and Dockerfile overrides are optional; leaving them out preserves the source or signed App Store listing defaults. Install from the App Store Copy a listing id from the SproutOS App Store and create its project: sprout project create --name analytics --region us-east-1 \\ --store 01900000-0000-7000-8000-000000000000 \\ --owner my-github-account --repository-name analytics The platform resolves an exact signed catalogue commit and immutable plugin digest. It creates the destination repository and services; it does not execute instructions discovered in the upstream repository. Some listings declare setup inputs. Create a JSON array matching the fields shown by the listing, then pass its file: [ { "key": "databasePassword", "value": "replace-me", "secret": true }, { "key": "port", "value": 3000, "secret": false } ] sprout project create --name analytics --region us-east-1 \\ --store 01900000-0000-7000-8000-000000000000 \\ --template-input-file ./template-inputs.json Use --template-input-file - to read the array from stdin. This keeps secret values out of shell history and the process list. Inputs cannot override the signed template\'s declared structure. Configure services and environment variables List organization services, create a project-scoped service, and save a secret without putting its value in shell history: sprout service list sprout service create --name app-database --kind postgres --project my-site sprout env set my-site DATABASE_URL --stdin sprout env list my-site Service kinds are postgres , valkey , elasticsearch , and object_storage . Environment targets are production , preview , development , and all (the default). Add --public only for values that may be exposed to client-side application code. Build and deploy Build your application first, then point sprout deploy at the finished artifact: sprout deploy my-site --preset next --runtime nodejs24.x --path .next/standalone sprout deployment list my-site sprout logs my-site The CLI packages output deterministically, negotiates the upload, creates a release, and waits for a terminal deployment result. Presets are static , web , next , hono , function , and android . A direct function also requires --handler . Preview deployments use --environment preview ; production is the default. Use deployment get or deployment wait with a deployment id when you need to inspect or wait for an existing release. Production database migrations remain a customer-owned GitHub Actions step; see /docs/database-migrations Run database migrations . Android releases have additional custody and verification steps; see /docs/android-distribution Distribute Android apps . Project runtime settings supply the normal default; deploy flags override one release without changing it. See /docs/runtimes Runtimes and framework presets . Manage upstream updates and project groups App Store and upstream-backed projects can ask SproutOS to open reviewed update pull requests: sprout project update analytics --auto-update \\ --auto-update-cadence one_month --auto-update-mode suggest Use --auto-update-mode auto_merge only when reviewed pull requests should merge automatically after all platform and repository checks pass. A logical group can be created with --group ; add a child using --parent-project <group-id> and select its customer-facing project with --primary-child <child-id> on the group. Script safely with JSON output Pass the global --json option to receive one versioned JSON document on standard output: sprout --json project list sprout --json api get /v1/regions The api command accepts only a relative path beginning with / ; it rejects absolute and scheme-relative URLs before reading the bearer credential. logs --follow --json is the one streaming exception: it emits one complete JSON envelope per line. Commands that revoke or remove state require an interactive confirmation: auth logout , project delete , env unset , service delete , and template apply . Use --yes to approve one explicitly. JSON mode never prompts, so a destructive JSON command must include both global options: sprout --json --yes project delete my-site Run sprout --help or sprout <command> --help for the complete current flag set. The command groups in v0.2.1 are auth , org , region , project , env , service , deploy , deployment , logs , android , api , and template .',
  },
  {
    slug: "coding-agent-skill",
    title: "Install the coding-agent skill",
    summary:
      "Give Codex, Claude Code, or another repository agent the SproutOS CLI and platform operating contract.",
    audience: "developer",
    category: "Getting started",
    order: 2,
    headings: [
      {
        id: "download-the-canonical-file",
        level: 2,
        title: "Download the canonical file",
      },
      {
        id: "install-and-authenticate-the-cli",
        level: 2,
        title: "Install and authenticate the CLI",
      },
      {
        id: "verify-the-agent-can-use-it",
        level: 2,
        title: "Verify the agent can use it",
      },
      {
        id: "understand-local-and-hosted-agents",
        level: 2,
        title: "Understand local and hosted agents",
      },
    ],
    text: "The public SproutOS skill teaches a coding agent how projects, groups, backend services, environment variables, migrations, templates, and deployments work. It helps the agent use the sprout CLI without copying the entire platform contract into every prompt. The skill is instructions, not a credential. Install it in the repository, then authenticate the CLI yourself. Download the canonical file mkdir -p .agents/skills/sproutos curl --fail --location \\ https://sproutos.me/skills/sproutos/SKILL.md \\ --output .agents/skills/sproutos/SKILL.md Recommended locations are: Codex, repository-scoped: .agents/skills/sproutos/SKILL.md ; Codex, user-scoped: ~/.agents/skills/sproutos/SKILL.md ; Claude Code, repository-scoped: .claude/skills/sproutos/SKILL.md ; Claude Code, user-scoped: ~/.claude/skills/sproutos/SKILL.md . Repository scope is the best default for a team because the instructions travel with the code and can be reviewed. User scope is useful when you work across many unrelated repositories. If your agent only follows AGENTS.md , keep the existing file and add an instruction to read this skill; do not replace repository-specific instructions. Install and authenticate the CLI Install the checksummed CLI release, then sign in outside the agent prompt: sprout auth login sprout auth status sprout org use my-team Browser login stores the scoped credential in the operating system credential store. In a trusted headless environment, supply SPROUTOS_TOKEN as a secret environment value. Never paste a token into SKILL.md , AGENTS.md , a prompt, or a command-line argument that shell history records. Verify the agent can use it Ask the agent to explain the current repository's project layout and propose the exact build and deploy commands without executing them. A correct answer should identify each deployable target, choose a preset and output directory, keep migrations before application deploys, and distinguish attached services from standalone ones. Then allow a read-only CLI check: sprout --json project list sprout --json service list Review any state-changing command before it runs. Destructive CLI commands require confirmation or --yes ; JSON mode never prompts. Understand local and hosted agents A local agent uses your computer and your agent provider account. SproutOS does not charge hosted sandbox duration or hosted model usage for that local work, although SproutOS services and deployments it creates are billed normally. The hosted Agent receives the same platform guidance automatically plus sandbox-only instructions, short-lived scoped actions, preview routing, and disposable database-branch access. Do not copy those ephemeral tokens or sandbox commands into the public skill.",
  },
  {
    slug: "connecting",
    title: "Connect to services",
    summary: "Use tenant-scoped credentials for Postgres, Valkey, search, and object storage.",
    audience: "developer",
    category: "Deploying",
    order: 13,
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
    text: "Tenant-scoped credentials Provisioning or rotating Postgres, Valkey, or OpenSearch returns its connection URI once. Put it in the project's encrypted environment variables. SproutOS stores a verifier, not a recoverable copy, so those URIs cannot be revealed later. Object storage is the exception. Its secret is derived rather than stored, so an authorized organization member can use View credentials again. An application can mint presigned URLs for supported S3 operations without handing that secret to a browser. Presigned URLs may last at most seven days, and rotation still revokes both ordinary credential use and unexpired URLs immediately at the storage proxy. See /docs/object-storage Use object storage for SDK configuration, public-read controls, limits, and unsupported operations. Service variables Postgres uses DATABASE_URL . Valkey uses VALKEY_URL or REDIS_URL ; BullMQ also uses the injected BULLMQ_PREFIX . OpenSearch uses ELASTICSEARCH_URL and automatically scopes index names. Object storage uses S3_ENDPOINT , S3_REGION , S3_BUCKET_NAME , S3_ACCESS_KEY_ID , S3_SECRET_ACCESS_KEY , and path-style addressing. All endpoints pass through tenant-enforcing SproutOS proxies. Close connections before a function returns. For creation, attachment, standalone ownership, and rotation, start with /docs/backend-services Backend services .",
  },
  {
    slug: "database-migrations",
    title: "Run database migrations",
    summary:
      "Run production migrations from GitHub Actions before deploying every project that depends on them.",
    audience: "developer",
    category: "Deploying",
    order: 14,
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
    text: "The workflow owns production migrations Your GitHub Actions workflow decides when production database migrations run. SproutOS does not scan a repository, discover a migration command, or start a migration because application code was deployed. The recommended setup is a dedicated SproutOS migrator project . Its GitHub Actions job uploads the built migrator, waits for SproutOS to finish running it, and only then allows the application projects that use that database to deploy. Give one project responsibility for each database. Do not attach the same migration to several application projects and let them race. Recommended: deploy a migrator project first Build the migrator separately from the request-serving application and pass it to the deploy action with migration-directory . The action waits for a terminal result, so GitHub's needs dependency is the gate between the schema and the applications: name: Migrate and deploy to SproutOS on: push: branches: [main] permissions: contents: read id-token: write jobs: migrate: runs-on: ubuntu-latest steps: - uses: actions/checkout@v5 - uses: actions/setup-node@v4 with: node-version: 24 - run: npm ci - run: npm run build:migrator - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 with: preset: hono runtime: nodejs24.x handler: run.sh directory: apps/migrator/dist project: my-app-migrator migration-directory: apps/migrator/dist migration-handler: migrate.handler api-url: https://api.sproutos.me deploy-web: needs: migrate runs-on: ubuntu-latest steps: - uses: actions/checkout@v5 - uses: actions/setup-node@v4 with: node-version: 24 - run: npm ci - run: npm run build - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 with: preset: next runtime: nodejs24.x handler: run.sh directory: apps/website/.next/standalone project: my-app-web api-url: https://api.sproutos.me Replace the commands, preset, directories, and handler with the repository's real build. The migrator project is a deployable project, but it should not be the group's customer-facing primary project. Add needs: migrate to every job that deploys code against the migrated database. When several applications share one database, they may deploy in parallel after that one migration succeeds. When applications use different databases, give each database its own migrator job and depend only on the relevant one. SproutOS runs the uploaded migrator with that project's production environment, including its DATABASE_URL , before publishing the migrator project's new version. A failed migration fails the GitHub job and leaves dependent jobs unstarted. SproutOS does not retry a migration automatically: after a failure, inspect whether it partially applied before starting another run. Alternative: run the command directly in CI You may run the repository's migration command directly on the GitHub runner instead. In that model, GitHub needs a production database credential stored as an Actions secret; the OIDC token used by the SproutOS deploy action is not a database credential. jobs: migrate: runs-on: ubuntu-latest env: DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }} steps: - uses: actions/checkout@v5 - uses: actions/setup-node@v4 with: node-version: 24 - run: npm ci - run: npm run migrate deploy-web: needs: migrate # Build and deploy the application here. Use this pattern when the migration cannot run in the SproutOS migrator runtime or your existing CI already owns database access. Never commit the connection URI or print it in workflow output. Make schema changes safe for several projects The old application versions keep serving until their deployment jobs finish. Write migrations so both old and new code can use the intermediate schema: add before removing, deploy readers before dropping old columns, and move destructive cleanup into a later migration. Do not run migrations during application startup. Several function instances may start at once, which turns one schema change into concurrent migration attempts. If a project has no database or no migrations, say so in the workflow or repository instructions rather than leaving ownership ambiguous. Sandboxes do not migrate production A SproutOS coding-agent sandbox starts without DATABASE_URL . The agent can request a named, disposable 24-hour branch of the project's database through its scoped sandbox action. Run migrations against that isolated branch to verify the schema, seed data, and application together. A successful sandbox migration does not replace the GitHub Actions migration job and does not prove that production was migrated.",
  },
  {
    slug: "deployments",
    title: "Deploy an application",
    summary:
      "Choose a build preset, publish a finished artifact, distinguish preview from production, and verify the release.",
    audience: "developer",
    category: "Deploying",
    order: 10,
    headings: [
      {
        id: "choose-the-preset",
        level: 2,
        title: "Choose the preset",
      },
      {
        id: "deploy-from-a-terminal",
        level: 2,
        title: "Deploy from a terminal",
      },
      {
        id: "separate-preview-and-production",
        level: 2,
        title: "Separate preview and production",
      },
      {
        id: "put-migrations-before-deployments",
        level: 2,
        title: "Put migrations before deployments",
      },
      {
        id: "verify-in-layers",
        level: 2,
        title: "Verify in layers",
      },
    ],
    text: "A SproutOS deployment publishes one finished build to one project. The project identifies the repository target; the preset identifies how the output is served. SproutOS does not guess how to build your source, and a deployment of one group child does not deploy its siblings. Choose the preset static publishes files at the edge. Use it for a SPA or generated site with no server handler. next packages a Next.js standalone server output. hono packages a Hono application using the supported entrypoint contract. web publishes a provided server runtime or adapter output. function publishes a ZIP containing a direct Node, Python, Java, .NET, Ruby, or custom-runtime handler. android uploads one raw unsigned APK for the protected signing and distribution flow. Point --path or the Action's directory at the built output, not the source directory unless the preset explicitly expects it. Static assets are immutable deployment content; mutable uploads and user files belong in /docs/object-storage object storage . The project owns the normal preset/runtime/handler default. Explicit deploy options override it for one release, and the resolved values are recorded with that deployment. See /docs/runtimes Runtimes and framework presets . Deploy from a terminal sprout auth login sprout org use my-team sprout deploy my-site --preset next --runtime nodejs24.x --path .next/standalone sprout deployment list my-site sprout logs my-site The CLI packages deterministically, negotiates an upload, creates a release, and waits for a terminal result. A queued deployment is not a successful deployment; wait until it is ready and then exercise the application URL. Separate preview and production Production is the default. Use --environment preview for preview output. Preview releases are isolated from the production pointer and should use preview-targeted environment values. The deployment API also associates previews with a pull request so each one has an unambiguous hostname. Do not promote confidence from one environment to another. A sandbox preview proves a development process, a preview deployment proves a built preview release, and a production request proves the live release. Record which one you tested. Put migrations before deployments Deploying code never discovers or runs a database migration. Run production migrations in GitHub Actions and make every dependent deployment job declare needs: migrate . If the migration fails, the new code must not receive traffic. See /docs/database-migrations Run database migrations . Verify in layers After a ready result: inspect the deployment's source commit, preset, kind, and hostname; open the hostname and exercise a real authenticated or data-backed path; check Logs for the same request and confirm the expected project handled it; verify each attached service with a harmless read and write; add or check the custom domain only after the generated hostname works. Build failures and runtime failures are reported separately. A build failure means the artifact or image could not be prepared. A runtime failure means the build completed but the application did not start or serve correctly. Runtime selection does not rebuild the artifact. Native dependencies must target Linux arm64, and the CI toolchain should match the selected SproutOS runtime.",
  },
  {
    slug: "domains-and-rollbacks",
    title: "Domains and rollbacks",
    summary:
      "Verify a generated hostname, activate a custom domain, and move production traffic to a known ready release.",
    audience: "developer",
    category: "Deploying",
    order: 15,
    headings: [
      {
        id: "verify-before-adding-a-domain",
        level: 2,
        title: "Verify before adding a domain",
      },
      {
        id: "roll-back-traffic-not-data",
        level: 2,
        title: "Roll back traffic, not data",
      },
    ],
    text: "Every website or API project receives a generated SproutOS hostname. Workflow runtime projects do not, because queue and schedule triggers invoke them rather than browser traffic. Verify before adding a domain Deploy the project and test the generated hostname first. This separates application and runtime problems from DNS and certificate problems. Confirm the response in Logs , including the expected project and source release, before changing DNS. Add a custom hostname from the project's domain settings and create the exact DNS record SproutOS shows. The domain becomes active only after ownership, routing, and certificate checks succeed. Avoid putting a proxy or redirect in front of the validation record until activation completes. For a repository group, the primary child's active custom domain becomes the group's customer-facing domain. Changing the primary child changes the destination; it does not transfer that child's services or environment. Roll back traffic, not data A rollback points the project's live route at an earlier ready production deployment. It does not rebuild or upload the artifact. Preview, failed, queued, and never-served releases are not valid rollback targets. Static and serverless serving modes cannot be interchanged by rollback. Deploy a deliberate conversion instead of trying to point a static project at a server runtime or the reverse. Rollback changes application traffic only. It does not reverse database migrations, restore Postgres rows, undo queue jobs, or restore object-storage files. Before a schema-changing release, use backward-compatible migrations so both the old and new application versions can operate during the rollback window. After rollback, exercise the generated and custom hostnames and inspect a matching request in logs. If the data contract is no longer compatible with the older code, roll forward with a corrective release rather than repeatedly moving traffic.",
  },
  {
    slug: "environment-variables",
    title: "Configure environment variables",
    summary:
      "Store secrets and public values in production, preview, development, or all targets without leaking them into source.",
    audience: "developer",
    category: "Deploying",
    order: 12,
    headings: [
      {
        id: "choose-the-target",
        level: 2,
        title: "Choose the target",
      },
      {
        id: "keep-server-secrets-private",
        level: 2,
        title: "Keep server secrets private",
      },
      {
        id: "know-what-service-attachment-writes",
        level: 2,
        title: "Know what service attachment writes",
      },
      {
        id: "rotate-without-an-outage",
        level: 2,
        title: "Rotate without an outage",
      },
    ],
    text: "Open a project and choose Environment to manage runtime configuration. Values belong to the project, not its repository group, and are injected only into matching deployment environments. Choose the target production is used by live production deployments. preview is used by preview deployments. development is for development-specific consumers. all applies the value to every target unless a more specific value overrides it. Use different credentials and external service endpoints for preview and production when the provider supports it. A preview that writes production data is not isolated merely because it has a different hostname. Keep server secrets private Environment values are private by default. Mark a value public only when it is safe to embed in client-side code and send to every browser. Database URLs, signing material, provider API keys, session secrets, and SproutOS tokens are never public values. For the CLI, read secrets from standard input so they do not appear in shell history or a process list: printf '%s' \"$APP_DATABASE_URL\" | sprout env set my-site DATABASE_URL \\ --target production --stdin sprout env list my-site Do not put the value itself in documentation, screenshots, build logs, or .env files committed to Git. Know what service attachment writes Attaching a backend service writes its connection settings into the project environment: Postgres: DATABASE_URL ; Valkey: VALKEY_URL , REDIS_URL , and BULLMQ_PREFIX where applicable; OpenSearch: ELASTICSEARCH_URL ; object storage: S3_ENDPOINT , S3_REGION , S3_BUCKET_NAME , S3_ACCESS_KEY_ID , S3_SECRET_ACCESS_KEY , and S3_FORCE_PATH_STYLE . Standalone services are not injected automatically. Save their returned connection value in every authorized consumer yourself. Rotate without an outage Where a provider supports overlap, add a new application value, deploy consumers, verify them, and then revoke the old credential. SproutOS service rotation invalidates the previous tenant credential, so coordinate all consumers of a standalone service before selecting rotate. Hosted Agent sandboxes do not inherit these production runtime secrets. Use scoped, disposable resources for sandbox tests; see /docs/agent-sandboxes Agent sandboxes .",
  },
  {
    slug: "github-action",
    title: "Deploy from GitHub or your local agent",
    summary:
      "Use the same sprout deployment contract from GitHub Actions, a terminal, or a coding-agent harness.",
    audience: "developer",
    category: "Deploying",
    order: 11,
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
        id: "give-a-coding-agent-the-same-contract",
        level: 2,
        title: "Give a coding agent the same contract",
      },
      {
        id: "deployment-templates",
        level: 2,
        title: "Deployment templates",
      },
    ],
    text: "GitHub Actions Build the target, then call the Marketplace action. The reviewed action at commit 0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 is a thin wrapper around the published sprout CLI v0.1.0. The current local CLI is v0.2.1; it adds the complete region-aware project, signed-template, Android release, and resumable log-stream commands while preserving the action's packaging and deployment protocol. name: Deploy to SproutOS on: push: branches: [main] permissions: contents: read id-token: write jobs: deploy: runs-on: ubuntu-latest steps: - uses: actions/checkout@v5 - uses: actions/setup-node@v4 with: node-version: 24 - run: npm ci - run: npm run build - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180 with: preset: next runtime: nodejs24.x handler: run.sh directory: apps/website/.next/standalone project: my-web-project api-url: https://api.sproutos.me id-token: write lets GitHub identify the repository to SproutOS without a stored deployment secret. Do not add a long-lived SproutOS token to GitHub for this workflow. The platform verifies the repository and workflow identity before issuing a short-lived deployment credential. The action uploads build output; it does not decide how your application builds. Use next , hono , web , function , static , or android as the preset and point directory at the finished artifact. In a monorepo, use one workflow step per deployable target and always name project . Internally, the wrapper exchanges GitHub's OIDC assertion for a short-lived deployment token and passes it to the pinned CLI through the environment, never a command-line argument. That token is not a secret developers create or store. The action waits for a terminal deployment state. A missing artifact or rejected repository identity fails the GitHub job instead of reporting a successful upload. Production migrations remain part of the customer's GitHub Actions workflow. Use a dedicated migrator project and make application deploy jobs wait for it, or run the migration command directly in CI. See /docs/database-migrations Run database migrations for both patterns and their failure boundaries. Run the same deployment locally Install sprout from the checksummed binaries in the https://github.com/MySproutOS/SproutOS/releases/tag/cli-v0.2.1 SproutOS CLI v0.2.1 release , then sign in and deploy: sprout auth login sprout org use my-team sprout deploy my-web-project --preset next \\ --runtime nodejs24.x --handler run.sh \\ --path apps/website/.next/standalone Browser login uses PKCE and stores the resulting credential in your operating system's credential store. SPROUTOS_TOKEN is the headless CI path; do not put it in a repository or pass it on a command line that will be saved in shell history. Every command also supports stable --json output for scripts and coding agents. Destructive commands require confirmation or --yes . The release contains macOS arm64 and x86-64, Linux arm64 and x86-64, and Windows x86-64 binaries, plus SHA256SUMS and sprout-v0.2.1-manifest.json . Verify the selected archive against both files. The action also verifies GitHub's artifact attestation and the release's exact source revision before it executes the binary. Give a coding agent the same contract Install /docs/coding-agent-skill the SproutOS coding-agent skill in .agents/skills for Codex or .claude/skills for Claude Code. It teaches the agent the project, service, environment, migration, template, and deployment boundaries without creating a paid hosted sandbox. A local agent still uses the same sprout deploy my-web-project command and resources it creates on SproutOS remain metered normally. The build toolchain and deployed runtime are separate settings. Set both explicitly in repeatable workflows. Runtime selection does not rebuild native dependencies; the uploaded package must already target Linux arm64. See /docs/runtimes Runtimes and framework presets . Deployment templates App Store eligibility and deployment behavior come only from the signed MySproutOS/Deployment-Templates catalogue. SproutOS verifies the catalogue provenance, exact upstream commit, and immutable plugin digest before applying a recipe. The reviewed template source at commit c86dfdb7f055cb6cdf499b23f84ab91d640ca7a1 generates the canonical OIDC workflows for Umami and Memos. Those workflows pin the deploy action to the full commit above; they do not follow a mutable action tag. Generated forks may contain .config/sproutos.toml . It is declarative, contains no secret values, and helps humans and agents understand the chosen services and bindings. It is not the catalogue authority and cannot choose or replace executable template code. Never discover deployment behavior from an instruction file in an arbitrary upstream repository. Template plugins run without network, GitHub, SproutOS, or customer credentials; the control-plane worker owns provisioning, commits, pushes, and deployment.",
  },
  {
    slug: "limits",
    title: "Limits",
    summary: "Function duration, request size, memory, and concurrency.",
    audience: "user",
    category: "Billing & limits",
    order: 51,
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
    text: "Runtime An invocation runs for at most 15 minutes. Split longer jobs and enqueue the remainder. Memory is configurable from 128 MB to 10 GB and CPU grows with memory. Payloads and builds Application request and response bodies routed through a deployed function are limited to 6 MB. Object-storage traffic uses the separate S3-compatible storage endpoint and has a 64 MiB limit per request; use an SDK multipart upload for larger objects and keep each part at or below that limit. Presigned URLs can send browser uploads and downloads directly to that endpoint without passing the bytes through your application. The deploy tooling refuses application bundles over 200 MB uncompressed, ahead of Lambda's 250 MB hard limit. Concurrency Invocations may run concurrently in isolated environments. Pools created at module scope may be reused by a warm instance; never store a user's session or request state there.",
  },
  {
    slug: "navigation",
    title: "Navigate SproutOS",
    summary: "Where repositories, deployable projects, workflows, services, and usage live.",
    audience: "user",
    category: "Getting started",
    order: 2,
    headings: [
      {
        id: "projects",
        level: 2,
        title: "Projects",
      },
      {
        id: "workflows",
        level: 2,
        title: "Workflows",
      },
      {
        id: "databases",
        level: 2,
        title: "Databases",
      },
      {
        id: "store",
        level: 2,
        title: "Store",
      },
      {
        id: "settings",
        level: 2,
        title: "Settings",
      },
      {
        id: "billing-and-deletion",
        level: 2,
        title: "Billing and deletion",
      },
    ],
    text: "Use the organization switcher first: every project, backend service, workflow, model credential, and billing record belongs to the selected organization. Projects Projects lists standalone deployable projects and repository groups. Open a project for its overview, deployments, environment, logs, Agent, preview, and settings. Open a group to see the children that deploy from different roots or branches of the same repository. See /docs/projects-and-groups Projects and groups before mapping a monorepo. Workflows Workflows has two sections. Workflow repositories are code projects created by New workflow . Definitions are versioned graphs attached to deployed projects and opened in the visual editor. The create button does not create a visual definition. See /docs/workflows Workflows . Databases Databases manages Postgres, Valkey, OpenSearch, and object storage. Each service can be attached to one project or left standalone at the organization level. This page also creates Postgres branches and rotates service credentials. See /docs/backend-services Backend services . Store Store lists reviewed apps that SproutOS can turn into your own repository-backed project. The installed project remains connected to its upstream provenance, and maintenance can propose updates through pull requests. See /docs/store-and-updates Install apps and receive upstream updates . Settings Organization settings contain membership, GitHub integration, hosted Agent credentials, and other organization-wide controls. Project settings contain the production branch, root directory, domains, and destructive project actions. Model credentials are organization-scoped; environment variables and backend service attachments are project-scoped. Billing and deletion Billing groups measured usage by service and keeps an append-only credit ledger. Deleting a project tears down its SproutOS resources but retains the billing and audit history needed to explain past activity. SproutOS never deletes its GitHub repository.",
  },
  {
    slug: "oauth-applications",
    title: "Build a SproutOS OAuth application",
    summary: "Authorization Code with PKCE, optional database access, tokens, and revocation.",
    audience: "developer",
    category: "Application integrations",
    order: 40,
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
    category: "Backend services",
    order: 14,
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
        id: "presigned-urls",
        level: 2,
        title: "Presigned URLs",
      },
      {
        id: "public-objects",
        level: 2,
        title: "Public objects",
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
    text: 'Mutable storage and static deployments Object storage is mutable application data: uploads, photos, attachments, exports, and other files your application reads and changes while it runs. An ordinary S3 SDK talks to the SproutOS storage endpoint, which authenticates the project, confines every request to its bucket, and forwards it to S3. A static deployment is different. SproutOS expands an immutable build artifact and serves it through CloudFront. Customers do not receive credentials to edit that release in place; publish another deployment to change it. Get the connection values Open Databases , find the object-storage service, and select View credentials . The panel provides: S3_ENDPOINT S3_REGION S3_BUCKET_NAME S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE=true The project receives the same values as encrypted environment variables when the service is attached. Object storage is the exception to the usual one-time credential rule: View credentials can reconstruct its derived secret later. Keep it private. Rotating or deleting the credential revokes the old access at the SproutOS proxy; it is not an AWS credential and cannot be used against AWS directly. Python with boto3 import os import boto3 from botocore.config import Config s3 = boto3.client( "s3", endpoint_url=os.environ["S3_ENDPOINT"], region_name=os.environ["S3_REGION"], aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"], config=Config(s3={"addressing_style": "path"}), ) bucket = os.environ["S3_BUCKET_NAME"] s3.put_object( Bucket=bucket, Key="photos/cat.jpg", Body=image_bytes, ContentType="image/jpeg", CacheControl="public, max-age=3600", ) photo = s3.get_object(Bucket=bucket, Key="photos/cat.jpg")["Body"].read() # Give a browser one hour to download this private object directly. download_url = s3.generate_presigned_url( "get_object", Params={"Bucket": bucket, "Key": "photos/cat.jpg"}, ExpiresIn=3600, ) Do not set an AWS session token. Always pass the displayed endpoint and use path-style addressing; the bucket must remain in the URL path rather than the hostname. TypeScript with the AWS SDK import { GetObjectCommand, PutObjectAclCommand, PutObjectCommand, S3Client, } from "@aws-sdk/client-s3" import { getSignedUrl } from "@aws-sdk/s3-request-presigner" const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!, }, forcePathStyle: true, }) const Bucket = process.env.S3_BUCKET_NAME! await s3.send( new PutObjectCommand({ Bucket, Key: "exports/report.json", Body: report, ContentType: "application/json", CacheControl: "public, max-age=3600", }), ) const stored = await s3.send(new GetObjectCommand({ Bucket, Key: "exports/report.json" })) // Let a browser upload directly without receiving the storage credential. const uploadUrl = await getSignedUrl( s3, new PutObjectCommand({ Bucket, Key: "uploads/photo.jpg", ContentType: "image/jpeg" }), { expiresIn: 15 * 60 }, ) await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: imageFile, }) // Change one object\'s anonymous-read override later. await s3.send(new PutObjectAclCommand({ Bucket, Key: "exports/report.json", ACL: "public-read" })) Presigned URLs Presigned URLs work for the supported read, write, head, delete, list, ACL, and multipart operations. They are suitable for direct browser uploads and downloads because the browser receives a time-limited URL, not the storage secret. Use the exact endpoint, region, path-style setting, method, headers, and query parameters that were signed. An expiry may be from 1 second through the SigV4 maximum of 7 days. The proxy still checks the credential, service status, bucket boundary, and available credit when the request arrives. Rotating the credential, deleting it, or suspending the service therefore revokes an otherwise unexpired URL. Browser preflights and presigned responses allow cross-origin access. If a header such as Content-Type was part of the signature, send the same value from the browser. Public objects Object storage is private by default. In Databases , open the object-storage service\'s actions and enable Public reads to make plain object URLs readable unless an object has a private override. The same setting is available from PATCH /v1/{orgSlug}/services/{serviceId}/object-storage-access with { "publicRead": true } . Set the S3 canned ACL public-read or private on an upload, or use PutObjectAcl , to override that default for one object. GetObjectAcl reports the effective setting. Other canned ACLs and custom grant documents are not supported. Changing the service default affects objects without an override; it does not erase per-object overrides. A public URL has this form: ${S3_ENDPOINT}/${S3_BUCKET_NAME}/path/to/object Only anonymous GET and HEAD requests for object keys are public. Listings, writes, deletes, and ACL changes still require SigV4. The backing bucket remains private: the public decision is made by the SproutOS proxy, so a public object does not expose the physical bucket or another tenant\'s prefix. The proxy preserves Content-Type , Cache-Control , Content-Disposition , and Content-Encoding metadata on uploads and returns the backing store\'s response headers. Set Cache-Control deliberately: a browser or intermediary can keep a cached public response after access is made private until its cache lifetime expires. Use a private object plus a short-lived presigned URL when immediate revocation matters. Supported operations and limits Object reads, writes, heads, deletes, listings, canned object ACL reads and changes, and ordinary SDK multipart uploads are supported. Multipart upload is the right choice when one upload request would exceed the service\'s 64 MiB per-request body limit; keep each part at or below that limit. Virtual-host bucket addressing, SigV4 streaming-chunked uploads, server-side CopyObject , object tagging, custom ACL grants, and conditional or range reads are not supported. Object tags are reserved for SproutOS access controls. Download the source and upload a new object instead of using CopyObject ; download a whole object rather than depending on a byte range. The proxy spools an upload to bounded disk while verifying its payload signature, then streams it to S3. A presigned browser upload uses SigV4\'s UNSIGNED-PAYLOAD , but its method, path, query, expiry, and signed headers are still verified before the body is forwarded. Downloads stream with backpressure rather than being loaded into application memory. Metering and credit cutoff Object storage meters write and list requests, read requests, bytes delivered outside AWS, and stored byte-time. Deletes are not charged. SproutOS adds no platform markup to these dimensions. The billing system protects enough spendable credit for 48 hours of the latest measured stored bytes. When the remaining credit reaches that reserve, new storage requests are refused while the already-funded retention window keeps the data. Add credit before retrying a refused request.',
  },
  {
    slug: "observability",
    title: "Observe and troubleshoot applications",
    summary:
      "Use deployment states, runtime logs, request identifiers, workflow runs, and usage records to verify real behavior.",
    audience: "developer",
    category: "Operations",
    order: 30,
    headings: [
      {
        id: "read-deployment-state-first",
        level: 2,
        title: "Read deployment state first",
      },
      {
        id: "search-runtime-logs",
        level: 2,
        title: "Search runtime logs",
      },
      {
        id: "inspect-workflow-runs",
        level: 2,
        title: "Inspect workflow runs",
      },
      {
        id: "compare-with-usage",
        level: 2,
        title: "Compare with usage",
      },
    ],
    text: "Observability starts with identifying which environment and release you are testing. A local process, Agent preview, preview deployment, and production deployment are four different runtime states. Record the project, deployment, hostname, and request time before investigating. Read deployment state first Open Deployments or run sprout deployment get <deployment-id> . A build failure means SproutOS could not prepare the artifact or image. A runtime failure means the build completed but the application could not start or serve. Inspect that reason before searching application logs. Search runtime logs Open the project's Logs page or use: sprout logs my-site --since 30m --limit 200 sprout logs my-site --follow Filter by level or text when you know the failure signature. Use structured fields for operation, resource id, status, and retry count so a person can distinguish two similar messages. Avoid logging credentials, authorization headers, connection URLs, session tokens, or full sensitive payloads. Request identifiers let you correlate a browser failure with the correct runtime line. Capture the identifier and timestamp at the boundary, then search the same project rather than scanning every service. Inspect workflow runs Visual workflow run detail records overall status, a human-readable error, step inputs and bounded outputs, timestamps, and measured cost. A skipped sandboxed action makes the run fail with a reason; it is never reported as success. Queue payload inspection and editing require additional permissions and every edit requires an audit reason. For repository workers, log one stable job id from receipt through completion and record retries without including secrets or entire customer documents. Compare with usage Billing usage is evidence that a measured resource was consumed, not proof that the user-visible operation succeeded. Compare compute, queue residency, database, storage, and Agent dimensions with runtime logs and the final state change. A green deployment plus no matching request usually means you tested a different hostname or environment.",
  },
  {
    slug: "opensearch",
    title: "Use OpenSearch",
    summary:
      "Attach tenant-scoped search and keep index names, credentials, and application data isolated.",
    audience: "user",
    category: "Backend services",
    order: 13,
    headings: [
      {
        id: "connect-with-the-injected-endpoint",
        level: 2,
        title: "Connect with the injected endpoint",
      },
      {
        id: "design-indexes-as-application-state",
        level: 2,
        title: "Design indexes as application state",
      },
    ],
    text: "OpenSearch provides full-text and structured search. Create the Elasticsearch service kind in the dashboard; the connection variable and common client vocabulary use Elasticsearch naming, while the managed engine is OpenSearch. Connect with the injected endpoint An attached service supplies ELASTICSEARCH_URL . The SproutOS search proxy authenticates the tenant and scopes index names before forwarding requests. Do not bypass that endpoint or store an upstream cluster credential in the application. The connection URI is shown when the service is created or rotated. If it is lost, rotate it and update every consumer. Do not log request authorization headers or include the URI in source. Design indexes as application state Search data is independent from a deployment. A code rollback does not restore an earlier index. Keep source records in Postgres or another durable system when you need to rebuild the index, make index mappings compatible across rolling releases, and use versioned index names plus an alias for large schema changes. Use object storage rather than search indexes for large file bodies, and index only the fields needed for retrieval.",
  },
  {
    slug: "organizations-and-access",
    title: "Organizations and access",
    summary:
      "Understand the ownership boundary for projects, services, billing, credentials, and team permissions.",
    audience: "user",
    category: "Getting started",
    order: 3,
    headings: [
      {
        id: "what-belongs-to-an-organization",
        level: 2,
        title: "What belongs to an organization",
      },
      {
        id: "give-people-the-least-access-they-need",
        level: 2,
        title: "Give people the least access they need",
      },
      {
        id: "github-is-a-separate-authorization-boundary",
        level: 2,
        title: "GitHub is a separate authorization boundary",
      },
      {
        id: "deletion-and-retained-records",
        level: 2,
        title: "Deletion and retained records",
      },
    ],
    text: "An organization is the top-level ownership boundary in SproutOS. Its members share access to the projects and services they are allowed to manage, while its billing ledger and model credentials remain isolated from every other organization. What belongs to an organization An organization owns: repository groups and deployable projects; standalone and project-attached backend services; visual workflow definitions and workflow repositories; hosted Agent credentials and configuration; domains, usage records, credit, and billing history. Switching organizations changes all of these views. If a project or database appears to be missing, check the organization switcher before recreating it. Give people the least access they need Permissions are enforced for the organization and, where applicable, for individual resources. Someone who can view a workflow does not necessarily have permission to edit its graph, start a run, or inspect a queued job payload. Owners should reserve credential, billing, destructive, and job-edit permissions for trusted operators. Model credentials are organization-scoped. They are not shared with another organization and are not copied into project environment variables. Backend service credentials are also tenant-scoped; do not reuse them across organizations or publish them in a repository. GitHub is a separate authorization boundary SproutOS can only see repositories granted to its GitHub App installation. A SproutOS organization membership does not grant GitHub access, and GitHub access alone does not grant SproutOS access. Keep both sets of permissions current when someone joins or leaves a team. Deployments from GitHub Actions use a short-lived repository-bound OIDC credential. They do not require a long-lived organization token stored in GitHub. Deletion and retained records Deleting a project tears down platform resources and prevents new use while preserving the billing and audit records that explain past activity. SproutOS never deletes the GitHub repository. If you also want the source repository deleted, perform that separately in GitHub after reviewing its branches, pull requests, and any other consumers. See /docs/billing Understand billing for the credit and retained-data boundary.",
  },
  {
    slug: "postgres",
    title: "Use Postgres",
    summary:
      "Attach a tenant-scoped Postgres database, manage connection credentials, and create disposable branches.",
    audience: "user",
    category: "Backend services",
    order: 11,
    headings: [
      {
        id: "connect-through-sproutos",
        level: 2,
        title: "Connect through SproutOS",
      },
      {
        id: "use-branches-for-development-and-agents",
        level: 2,
        title: "Use branches for development and agents",
      },
      {
        id: "manage-connections-in-serverless-code",
        level: 2,
        title: "Manage connections in serverless code",
      },
    ],
    text: "Create a Postgres service from Databases → New database . Attach it to a project to inject DATABASE_URL , or leave it standalone and store the returned URI in the authorized consumers yourself. Connect through SproutOS Applications connect with the standard Postgres URI in DATABASE_URL . The public endpoint is a SproutOS tenant proxy: it resolves the tenant database, checks suspension state, and drops its own elevated role before forwarding the session. Customers do not receive the underlying provider credential. The connection URI is shown once. If it is lost or exposed, rotate it from the service menu and replace the old value in every environment that uses it. Use branches for development and agents A database branch is a temporary, isolated copy derived from the service's primary branch. Use one for schema experiments, migration tests, previews, and hosted Agent work that must not touch production data. From the Postgres service, create a named branch, capture its one-time connection URI, and delete the branch when the work is complete. Rotation replaces only that branch's credential. Hosted Agent sandboxes can request their own 24-hour branch through a scoped action and clean it up when the session ends. A successful sandbox migration proves the migration against that branch. It does not migrate production. Production remains an explicit customer-owned CI step; see /docs/database-migrations Run database migrations . Manage connections in serverless code Reuse a small pool across warm invocations when your library supports it, but close or release work before the handler returns. Do not leave a blocking connection or worker loop alive solely to wait for future work. See /docs/background-workers Background workers .",
  },
  {
    slug: "projects-and-groups",
    title: "Projects and groups",
    summary:
      "Map one repository or monorepo to deployable projects, workflow workers, branches, and a primary domain.",
    audience: "user",
    category: "Getting started",
    order: 4,
    headings: [
      {
        id: "use-one-project-for-one-deployable-target",
        level: 2,
        title: "Use one project for one deployable target",
      },
      {
        id: "choose-the-primary-child",
        level: 2,
        title: "Choose the primary child",
      },
      {
        id: "treat-workflow-projects-as-runtime-children",
        level: 2,
        title: "Treat workflow projects as runtime children",
      },
      {
        id: "keep-source-and-runtime-responsibilities-separate",
        level: 2,
        title: "Keep source and runtime responsibilities separate",
      },
    ],
    text: "A project is one deployable target: a directory and branch that produces one website, API, or workflow runtime. A group represents the repository that contains several targets. The group organizes them but does not deploy code itself. Use one project for one deployable target Create a standalone project when the repository has a single application. For a monorepo, create a group and one child project per independently deployed target. A typical layout is: product (group; deploys nothing) ├── web apps/web production branch: main ├── api apps/api production branch: main └── worker apps/worker production branch: main Each child has its own root directory, deployment history, environment variables, logs, attached services, framework preset, runtime, and handler contract. A release of web does not implicitly release api or worker , and groups do not supply inherited runtime settings. Choose the primary child The group's primary child is the customer-facing entry point. Choose the website or other public front door, not a private API or workflow project. An active custom domain on that child is used; otherwise SproutOS uses its generated hostname. Changing the primary child changes where the group points. It does not merge projects or move their environment variables and services. Treat workflow projects as runtime children A repository-backed workflow is still a project. It may be standalone or a child of the repository group, but it has no website hostname or custom domain because queue and schedule triggers invoke it. Use /docs/repository-workflows Repository workflows for BullMQ and Celery workers. Visual workflow definitions are a different resource attached to a deployed project. They appear under Workflows → Definitions and use the visual editor. See /docs/workflows Workflows . Keep source and runtime responsibilities separate SproutOS deploys the configured branch and directory. It does not infer that every package in a monorepo is a deployable application. Make build and deployment paths explicit, and use one GitHub Actions deploy step per child. Deleting a group or child never deletes its GitHub repository. Remove source in GitHub separately only when you intend to destroy it for every consumer.",
  },
  {
    slug: "quickstart",
    title: "Start here",
    summary:
      "Create an organization, connect GitHub, deploy a project, attach a backend service, and verify the result.",
    audience: "user",
    category: "Getting started",
    order: 1,
    headings: [
      {
        id: "1-create-or-choose-an-organization",
        level: 2,
        title: "1. Create or choose an organization",
      },
      {
        id: "2-choose-how-to-start",
        level: 2,
        title: "2. Choose how to start",
      },
      {
        id: "3-model-the-repository-correctly",
        level: 2,
        title: "3. Model the repository correctly",
      },
      {
        id: "4-add-the-backend-services-the-app-needs",
        level: 2,
        title: "4. Add the backend services the app needs",
      },
      {
        id: "5-configure-the-coding-agent",
        level: 2,
        title: "5. Configure the coding agent",
      },
      {
        id: "6-deploy",
        level: 2,
        title: "6. Deploy",
      },
      {
        id: "7-verify-the-release",
        level: 2,
        title: "7. Verify the release",
      },
    ],
    text: "This guide takes you from an empty account to a deployed application. You can start from an App Store listing, an existing GitHub repository, or a blank repository. In every case, SproutOS keeps the source in GitHub and deploys a named project from that source. 1. Create or choose an organization Sign in, choose your organization from the switcher, and open Projects . Organizations are the billing and access boundary: projects, services, model credentials, and usage belong to one organization. See /docs/organizations-and-access Organizations and access before inviting a team or configuring automation credentials. 2. Choose how to start App Store: open Store , select a listing, review its required services and setup fields, then create your own repository-backed copy. Existing repository: install the SproutOS GitHub App for the repository and select it in New project . Blank project: let SproutOS create a repository, then use the hosted Agent or your local coding agent to build it. Workflow repository: choose New workflow for a BullMQ TypeScript, BullMQ Rust, or Celery Python worker. This is different from a visual workflow definition. Every new project needs a region. Region availability comes from the live control plane, so use the dashboard picker or run sprout region list instead of copying a region from an old example. 3. Model the repository correctly A simple repository usually needs one project. A monorepo with a website, API, and worker should use a group with one deployable child per target. Each child can have its own root directory, branch, environment variables, services, and deployments. The group itself deploys nothing. Choose the web application as the group's primary project so the group's main domain opens the right child. See /docs/projects-and-groups Projects and groups . 4. Add the backend services the app needs Open Databases , choose New database , select a service kind, and either attach it to the project or leave it Standalone . SproutOS currently provides Postgres, Valkey, OpenSearch, and object storage. Attaching a service writes its connection settings into the project's encrypted environment. Standalone means the service belongs to the organization but is not automatically wired to one project; it does not mean the database runs outside SproutOS. See /docs/backend-services Backend services . 5. Configure the coding agent For the hosted Agent, open Settings → Agent , add a Claude subscription token, Anthropic API key, OpenAI API key, or OpenRouter API key, then open the project and choose Agent . Secrets are sealed when saved and cannot be revealed later. For a local coding agent, install the /docs/coding-agent-skill SproutOS coding-agent skill and authenticate the CLI. The skill teaches the agent how projects, services, migrations, and deploys work; it is not a credential. 6. Deploy The fastest manual path is the CLI: sprout auth login sprout org use my-team sprout deploy my-site --preset next --runtime nodejs24.x --path .next/standalone For repeatable production releases, use the GitHub Action with GitHub OIDC. Build first, deploy the finished output, and keep production database migrations as a separate job that deployment jobs depend on. See /docs/deployments Deploy an application and /docs/github-action Deploy from GitHub . 7. Verify the release Open Deployments and wait for a terminal success state. Then open the generated hostname and check a real user path, not only a health endpoint. Use Logs and Observability to confirm the request reached the expected project. If the application uses a service, exercise one real read and write before adding a custom domain. You now have the basic operating loop: change source, migrate if necessary, deploy, observe, and roll back to a known release if verification fails.",
  },
  {
    slug: "repository-workflows",
    title: "Build repository workflows",
    summary:
      "Create a BullMQ TypeScript, BullMQ Rust, or Celery Python project for interval and webhook work.",
    audience: "developer",
    category: "Workflows",
    order: 20,
    headings: [
      {
        id: "create-the-scaffold",
        level: 2,
        title: "Create the scaffold",
      },
      {
        id: "attach-valkey",
        level: 2,
        title: "Attach Valkey",
      },
      {
        id: "make-work-finite",
        level: 2,
        title: "Make work finite",
      },
      {
        id: "deploy-and-prove-the-worker",
        level: 2,
        title: "Deploy and prove the worker",
      },
    ],
    text: "A repository workflow is a normal GitHub-backed SproutOS project whose runtime handles queued work. Use it for arbitrary code, third-party packages, long business logic, or an existing BullMQ or Celery application. Create the scaffold Open Workflows → New workflow . Choose whether the project is standalone or belongs to an existing repository group, then select: BullMQ · TypeScript for Node.js and the official bullmq package; BullMQ · Rust for Rust and the BullMQ-compatible crate; Celery · Python for Celery with Valkey as broker and result backend. Choose an interval schedule or webhook trigger. After the project is created, SproutOS opens its Agent page with a prompt to build the chosen worker, attach Valkey, use injected connection values, add structured failure logs, and provide a small status endpoint proving a real job completed. Attach Valkey Attach a Valkey service to the workflow project. Read VALKEY_URL or REDIS_URL and, for BullMQ, BULLMQ_PREFIX from the environment. Never construct a platform host, tenant key prefix, or credential in source. The workflow project does not receive a website domain. A health or status handler is diagnostic; the workload still starts from its interval, webhook, or queue event. Make work finite SproutOS invokes the application when work is available. Process the supplied batch and return. Release database clients and do not leave a blocking queue read, subscription, timer, or infinite worker loop alive. Compute remains billable until the invocation returns. Split work that cannot finish within one invocation, enqueue the continuation, and return. See /docs/background-workers Background workers and /docs/limits Limits . Deploy and prove the worker Build the repository for its runtime, deploy the finished artifact, enqueue a harmless test job, and verify all of the following: the trigger reached the expected project; a real job completed and produced the expected state change; failures appear in structured logs with enough context to retry safely; the handler returned and no idle invocation remained; queue and compute usage appeared in billing and observability. Production database migrations are still a separate CI dependency. An Agent sandbox test or successful workflow deployment does not migrate the production database.",
  },
  {
    slug: "runtimes",
    title: "Runtimes and framework presets",
    summary:
      "Choose a project runtime, understand deployment overrides, and prepare arm64-compatible artifacts.",
    audience: "developer",
    category: "Deploying",
    order: 9,
    headings: [
      {
        id: "choose-an-execution-contract",
        level: 2,
        title: "Choose an execution contract",
      },
      {
        id: "defaults-overrides-and-rollback",
        level: 2,
        title: "Defaults, overrides, and rollback",
      },
      {
        id: "build-for-the-runtime",
        level: 2,
        title: "Build for the runtime",
      },
    ],
    text: "Every Lambda-backed SproutOS project owns a framework preset and runtime default. Project creation shows the recommended combination—Node.js 24 for a new Next.js, Hono, or Node Function project, and provided.al2023 for a generic Web executable—and lets you change it before creating the project. Changes in Modify apply only to future deployments. Run sprout runtime list for the live catalogue. The dashboard groups versions by language and shows the underlying Amazon Linux generation when it affects compatibility or lifecycle. Choose an execution contract next and hono run Node.js HTTP servers through Lambda Web Adapter. web runs an executable run.sh HTTP server through Lambda Web Adapter on any compatible ZIP runtime. SproutOS supplies the custom-runtime bootstrap bridge. function invokes a Lambda handler directly. Set the handler exported by the finished package, such as index.handler ; Node.js 24 handlers must be async and cannot use callback-style handlers. static publishes immutable files at the edge and has no Lambda runtime. android uploads an APK for signing and distribution and has no Lambda runtime. Groups and repository workflow projects do not inherit a Lambda runtime. In a monorepo, configure the website, API, and each other deployable child independently. Defaults, overrides, and rollback The project setting is the normal default. sprout deploy --runtime ... --handler ... and the equivalent GitHub Action inputs override it for one release; they do not edit the project. There is no checked-in SproutOS runtime configuration file. Every deployment records its resolved preset, runtime, and handler. Changing project settings does not rewrite an existing deployment, and rollback restores the old deployment without rebuilding or substituting today’s runtime. Build for the runtime SproutOS uploads a finished artifact; runtime selection does not reinstall or rebuild dependencies. Set the CI build toolchain separately and use the same language version you selected for SproutOS. Customer Lambda functions run on Linux arm64 , so native packages and compiled binaries must target that architecture. AWS applies compatible patch updates inside a managed runtime identifier. Moving between major runtime identifiers remains your application upgrade. The catalogue shows deprecation and selection cutoff dates; a runtime can remain selectable with a warning during a transition, but disabled identifiers are rejected for new deployments. Previously published versions remain valid rollback targets.",
  },
  {
    slug: "store-and-updates",
    title: "Install apps and receive upstream updates",
    summary:
      "Create a repository-backed copy from a reviewed listing, complete setup inputs, and review maintenance pull requests.",
    audience: "user",
    category: "Apps and updates",
    order: 40,
    headings: [
      {
        id: "review-before-installing",
        level: 2,
        title: "Review before installing",
      },
      {
        id: "own-the-resulting-project",
        level: 2,
        title: "Own the resulting project",
      },
      {
        id: "receive-upstream-changes-safely",
        level: 2,
        title: "Receive upstream changes safely",
      },
    ],
    text: "The SproutOS App Store starts from reviewed open-source listings. Installing a web listing resolves an exact catalogue commit and plugin digest, creates your destination repository and declared services, and preserves the upstream project as provenance. Review before installing Check the listing's source, description, required services, setup fields, deployment target, and privacy expectations. Secret setup values are used for provisioning and must not be committed to the generated repository. SproutOS applies only the signed catalogue recipe. It does not execute instructions discovered in an arbitrary upstream repository. The generated .config/sproutos.toml , when present, is a declarative description for people and agents; it is not executable catalogue authority. Own the resulting project The installed application is your repository-backed project, not a shared mutable copy. You can customize it with the hosted Agent or a local coding agent, add services, and deploy it through the same production controls as any other project. Public App Store provenance does not make a personalized fork public. Store publication and review are separate from creating a private organizational project. Receive upstream changes safely Upstream maintenance opens a proposal branch and pull request so repository CI and branch protection can evaluate the change. Suggest leaves the reviewed pull request for a person to merge. Auto merge merges only after the configured checks and protections pass. A merge conflict is bounded conflict-resolution work; it is not permission to bypass the pull-request gate. Choose a cadence appropriate to the application's risk and review capacity. Turning on automatic maintenance does not automatically deploy every merged change unless your GitHub Actions workflow deploys that branch. Deleting the SproutOS project never deletes the GitHub repository, including an App Store fork. Manage the source repository separately in GitHub.",
  },
  {
    slug: "valkey",
    title: "Use Valkey and queues",
    summary:
      "Connect caches and BullMQ workers through the tenant proxy without leaving idle invocations running.",
    audience: "user",
    category: "Backend services",
    order: 12,
    headings: [
      {
        id: "use-the-injected-variables",
        level: 2,
        title: "Use the injected variables",
      },
      {
        id: "build-queue-workers-for-invocation-not-residency",
        level: 2,
        title: "Build queue workers for invocation, not residency",
      },
    ],
    text: "Valkey is the Redis-compatible cache and queue service. Create it under Databases , then attach it to a project or keep it standalone. Use the injected variables An attached service supplies VALKEY_URL and the compatible alias REDIS_URL . BullMQ deployments also use BULLMQ_PREFIX so queue keys remain inside the tenant namespace. Configure the client from these variables instead of hard-coding a host, password, database number, or key prefix. The endpoint is a SproutOS tenant proxy. Use the returned URI as a single credential and rotate it if it is lost or exposed; the old credential stops working after rotation. Build queue workers for invocation, not residency Repository workflows are invoked when work is available. Process the delivered batch, close or release open resources, and return. Do not keep a subscribe command, blocking read, timer, or infinite worker loop alive inside an invocation; idle runtime still consumes compute. For queue framework choices and triggers, see /docs/repository-workflows Repository workflows and /docs/background-workers Background workers .",
  },
  {
    slug: "workflow-editor",
    title: "Use the visual workflow editor",
    summary:
      "Create a definition through the API, connect one trigger to actions and controls, save versions, and inspect runs.",
    audience: "user",
    category: "Workflows",
    order: 21,
    headings: [
      {
        id: "build-the-graph",
        level: 2,
        title: "Build the graph",
      },
      {
        id: "configure-nodes",
        level: 2,
        title: "Configure nodes",
      },
      {
        id: "save-meaningful-versions",
        level: 2,
        title: "Save meaningful versions",
      },
      {
        id: "start-and-inspect-a-run",
        level: 2,
        title: "Start and inspect a run",
      },
    ],
    text: 'The visual editor edits a workflow definition attached to one project. Before opening it, create the definition through the API as described in /docs/workflows Choose a workflow model , then select it under Workflows → Definitions . Build the graph Choose a node type, select Add node , and drag from one node handle to another to create an edge. Select a node to rename it and edit the fields shown in the right panel. Delete removes the selected node and its edges. The editor offers these nodes: triggers: Manual, Schedule, Webhook, and Event; actions: HTTP request, Run code, Database, and Send email; controls: Branch and Delay. Every graph needs exactly one trigger. Nothing may connect into that trigger, every other node must be reachable from it, and the graph cannot contain a cycle. The server validates these rules on save and names the problem node when it rejects a graph. Configure nodes The right panel exposes the fields required by the selected node: a cron expression, webhook path, event name, HTTP method and URL, code entrypoint, database query, email recipient and subject, branch condition, or delay. Treat values as production configuration. Never paste an API key or database password into a graph; keep secrets in the owning project\'s encrypted environment and reference them from code. Sandboxed action nodes run inside the owning project\'s isolated runtime. Deploy the project before testing actions that need that runtime. A definition on a project that has never been provisioned cannot safely run those nodes and reports a failed run instead of pretending they succeeded. Save meaningful versions Select Save after the graph is connected and configured. A semantic change creates a new immutable version. Moving nodes around the canvas does not create a new version, because positions do not change execution behavior. Saving an unchanged graph returns the existing version. Start and inspect a run The API can start the current saved version with an optional JSON trigger payload: sprout api post \\ /v1/orgs/my-team/projects/01900000-0000-7000-8000-000000000000/workflows/01900000-0000-7000-8000-000000000001/runs \\ --data \'{"trigger":{"requestedBy":"onboarding"}}\' The run and step endpoints expose status, error details, input and bounded output, duration, queue residency, and measured cost. Job payload inspection and editing require separate permissions; an edit records the before value, after value, actor, and a required reason. Cron definitions schedule from the saved graph. Manual, webhook, and event triggers do not invent a schedule. If a save is rejected, fix the named graph problem before trying to run it.',
  },
  {
    slug: "workflows",
    title: "Choose a workflow model",
    summary:
      "Decide between a repository-backed BullMQ or Celery worker and a versioned visual workflow definition.",
    audience: "user",
    category: "Workflows",
    order: 20,
    headings: [
      {
        id: "repository-workflows",
        level: 2,
        title: "Repository workflows",
      },
      {
        id: "visual-workflow-definitions",
        level: 2,
        title: "Visual workflow definitions",
      },
      {
        id: "choose-deliberately",
        level: 2,
        title: "Choose deliberately",
      },
    ],
    text: 'The Workflows page shows two different kinds of automation. They share the organization view, but they are created, deployed, and operated differently. Repository workflows A repository workflow is a complete code project for jobs that need arbitrary libraries, custom business logic, or an existing queue framework. New workflow creates a repository-backed project, asks you to choose BullMQ TypeScript, BullMQ Rust, or Celery Python and an interval or webhook trigger, then opens the hosted Agent with a scaffold prompt. The agent writes ordinary source code. Attach Valkey, test the worker, and deploy it like any other project. It has no customer-facing hostname because queue or schedule events invoke it. See /docs/repository-workflows Repository workflows . Visual workflow definitions A definition is a versioned graph attached to an existing deployed project. It is best for a visible sequence of triggers, actions, branches, and delays. Definitions appear in the Definitions section and open in the visual editor. The current dashboard does not have a New definition button. Create the initial definition through the authenticated API, then open Workflows → Definitions to draw and save its graph. The New workflow button creates a repository workflow; it does not open the visual editor. sprout api post /v1/orgs/my-team/projects/01900000-0000-7000-8000-000000000000/workflows \\ --data \'{"name":"Nightly report","runtime":"node"}\' Use the real project UUID from the project API or dashboard URL. The response contains the new workflow UUID. Return to Workflows , open the definition, add exactly one trigger, connect every action, and save. Choose deliberately Use a repository workflow when code ownership, tests, framework features, or portability matter most. Use a visual definition when operators should understand and adjust the sequence without editing a codebase. A visual definition can still run HTTP, code, database, and email actions in the owning project\'s isolated runtime. Both kinds consume backend and compute resources. Both stop starting new work when the organization is suspended for insufficient credit.',
  },
] as const
