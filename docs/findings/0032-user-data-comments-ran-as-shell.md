# User-data comments ran as shell

**Found by:** reading the fresh production instance journal while diagnosing the first Daytona
turn. Cloud-init reported `neon: command not found` and `NEON_API_KEY: command not found`.

## What looked true

The offending text was a comment in the generated `/etc/sproutos/env` file. Comments in an env file
do not execute, and every required Daytona and Neon value was present when the service started.

## What was actually true

The env file is emitted by an unquoted shell heredoc. Before writing it, the shell expands command
substitutions everywhere in the body, including backticks inside comments. The comments were
therefore executed during boot and only became comments after their output was written. Separately,
the website worker schedules OpenSearch identity reconciliation but its explicit Parameter Store
allowlist did not include `SEARCH_PROXY_SECURITY_ROOT_KEY`, so that job failed every hour.

## What stops it recurring

Backticks in the interpolated heredoc are escaped, preserving the rendered comments without
command substitution. The website secret list now includes the search derivation root. A shell test
extracts the heredoc, rejects any unescaped backtick, and asserts that the worker's reconciliation
key is delivered.

## Historical context

The exact production evidence extends `private_notes/groups.md`,
`private_notes/sandbox-handoff.md`,
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`, and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.
