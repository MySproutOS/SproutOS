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
