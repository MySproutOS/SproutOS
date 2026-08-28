# sprout CLI

`sprout` is the canonical command-line client for SproutOS. This crate contains command parsing,
human and machine output, confirmation, browser login, and operating-system credential storage.
Reusable API, deployment, packaging, catalogue, OCI, provenance, isolation, and template behavior
lives in `sprout-core`.

## Authentication

`sprout auth login` opens the SproutOS authorization page and binds an ephemeral listener to the
literal IPv4 loopback address (`127.0.0.1`). It uses an S256 PKCE challenge and a random state. The
single-use authorization code is exchanged for an organization-bound, scoped API key; only that
key enters Keychain, Credential Manager, or Secret Service.

For CI and headless machines, set `SPROUTOS_TOKEN`. It takes precedence over the credential store,
is never copied into it, and `sprout auth logout` never edits the environment. There is no
plaintext-file fallback.

The GitHub Action uses `SPROUTOS_DEPLOY_TOKEN` for its short-lived, repository-bound deployment
token. That variable is recognized only by `sprout deploy`; it is never treated as a general API
key. Local deployment uses the ordinary organization API key to obtain a short-lived deploy token
and therefore requires `--org` (or `sprout org use`) plus an explicit project id or unique slug.

## Output contract

Every command supports human output and `--json`. Machine output is exactly one JSON document on
stdout:

```json
{ "schema_version": 1, "ok": true, "command": "project.list", "data": {} }
```

Failures use the same version and a stable error object. Progress and prompts never enter JSON
stdout. Streaming logs will use one JSON object per line only after an explicit output-schema
version adds that mode.

Destructive commands require an interactive confirmation or `--yes`. `--json` never prompts and
therefore requires `--yes` for destructive operations.

## Commands

```text
sprout auth login|logout|status
sprout org list|use
sprout project list|get|create|update|delete
sprout env list|set|unset
sprout service list|create|get|delete
sprout deploy
sprout deployment list|get|wait
sprout logs
sprout android setup|status|verify
sprout api <method> <path>
sprout template resolve|apply|verify
```

`sprout api` accepts only a relative path beginning with `/`; absolute and scheme-relative URLs are
rejected before the stored bearer credential is read. This prevents an arbitrary host from being
used as a credential-exfiltration target.

`sprout deploy` delegates deterministic ZIP/APK creation, hashing, upload negotiation, release
creation, and polling to `sprout-core`. Site and migration sources become deterministic ZIPs
without mutating the source tree. Android accepts one raw unsigned APK (or a directory containing
exactly one such APK for Marketplace Action compatibility) and uploads its original bytes as
`application/vnd.android.package-archive`.

The legacy deploy environment `development` remains accepted as an alias for `preview`; both use
the backend's collision-safe pull-request preview identity rules.

## Releases and production promotion

The version in the workspace manifest and a `cli-v<version>` tag must agree. That tag builds five
native archives, smokes the extracted binaries, publishes `SHA256SUMS` plus manifest v1, and gives
every file GitHub build provenance. Repository release immutability must be enabled **before** the
tag is pushed; GitHub applies that setting only to future releases.

Publication is not promotion. `bin/promote-cli-release.sh` downloads the public release again and
requires GitHub to report it immutable, verifies its exact five-platform set, checksums, manifest,
tag-bound provenance and source commit, then records the evidence at
`/<name>/releases/cli/<version>`. Only after all of that passes does it update
`/<name>/application/SPROUT_CLI_RELEASE_VERSION` and replace the ECS task that renders `/download`.
The pointer only moves forward by semantic version; an emergency rollback must be a separately
reviewed operation rather than a disguised release promotion.

The immutable `cli-v0.1.0` release predates automatic promotion. After the production IAM/task
wiring is applied and the `/download` CLI consumer from PR #161 is merged and deployed, run
**Promote an existing CLI release** with `0.1.0` and the exact task-definition ARN registered by
that reviewed OpenTofu apply. The protected workflow records the pointer, then uses the existing
deployment role
to combine that contract with the image already serving; the promotion role itself cannot register
or select code. Do not put a placeholder version in Parameter Store: ECS treats a missing referenced
parameter as a task-start failure, while the website intentionally treats an absent variable as “no
release yet.” Later `cli-v*` tag workflows enqueue the same production-environment-gated promotion
automatically.
