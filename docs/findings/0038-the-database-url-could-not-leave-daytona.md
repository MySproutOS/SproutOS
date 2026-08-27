# The database URL could not leave Daytona

## What was wrong

The sandbox received a valid branch-scoped `DATABASE_URL`, but Daytona's proxy-only network policy
blocked direct TCP to the public pg-proxy listener on port 5432. `HTTP_PROXY` and `HTTPS_PROXY`
helped Git, package managers, and browsers; ordinary Postgres clients do not speak HTTP proxy
protocol, so every database operation hung and then failed.

This was observed in the signed-in production Agent UI on 2026-08-27. The agent confirmed the
variable existed without printing it, then could reach neither the endpoint directly nor through
the forward proxy because CONNECT admitted only port 443.

## Why the earlier checks passed

The database work proved that Neon created the branch, the control plane stored its credential, and
the value reached Daytona. The egress work separately proved public HTTPS through a real Daytona
workspace. No check composed those two paths using a real Postgres client under Daytona's outbound
proxy policy.

That gap is part of the sandbox history recorded in `private_notes/sandbox-handoff.md`, the original
grouping requirements in `private_notes/groups.md`, and the legacy plans
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.

## What stops it recurring

- The authenticated Rust forward proxy admits CONNECT only to public HTTPS and Postgres ports;
  private, loopback, link-local, and metadata addresses remain forbidden after DNS resolution.
- A platform-owned launcher under `.git/sproutos/network` opens a loopback TCP bridge through that
  authenticated CONNECT and rewrites only the child process's `DATABASE_URL` host and port.
- The customer's database credential never enters the bridge's arguments, files, or logs.
- The launcher is outside the worktree, so it cannot become customer work.
- Rust tests prove port 5432 is admitted while unrelated port 80 CONNECT remains denied; agent tests
  prove every harness runs through the launcher and the launcher is installed outside the worktree.
- The production acceptance test is a real `SELECT 1` and schema listing from a Daytona turn, not
  merely the presence of the variable.
