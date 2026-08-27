# 0021 — The interface was not the provider

The sandbox handoff said every live assertion had run against Docker, not Daytona. That caveat was
not paperwork. The first Daytona run found two create parameters the hosted API refuses and one
process-lifecycle behavior the local driver could not reproduce.

## What failed on the production driver

1. A snapshot and a resource override cannot be supplied together. The interface accepted CPU,
   memory, and disk beside a snapshot; Daytona returned 400. Snapshot resources are immutable. The
   platform now builds one 2 CPU / 4 GiB / 10 GiB snapshot, refuses a database row that claims a
   different billable size, and sends no invalid override.
2. Daytona accepts at most ten CIDRs. The generated public-IPv4 complement contained 73, so every
   create returned 400. A twenty-domain policy proved the provider integration but was not a valid
   product boundary: customer code must be able to install arbitrary dependencies and call
   arbitrary third-party APIs. Sandboxes therefore leave both Daytona allow-list fields unset.
   Daytona's own infrastructure boundary is still checked live by probing the metadata endpoint.
   General access also depends on the Daytona organization being Tier 3 or 4; lower-tier policy is
   provider-wide and cannot be overridden by a create parameter. The live test reaches a domain
   outside the former list so an account downgrade cannot silently narrow customer programs.
3. Deleting a Daytona process session kills descendants, including a `nohup` dev server. The old
   cleanup made previews disappear when an agent turn ended. Completed agent sessions now live
   until sandbox stop/destroy, where they are explicitly removed.
4. A stopped container releases CPU and memory but continues billing its reserved disk. The
   fifteen-minute reaper therefore changed the shape of the charge without ending it. Every create
   now asks Daytona to archive after one continuously stopped minute: the workspace remains
   resumable, while the archived provider state releases disk quota and is not billed. Project
   teardown still deletes the sandbox and its Neon branch outright.
5. Daytona can auto-stop independently of the control-plane row. A provider sandbox could be
   stopped while Postgres still said `running`, so metering and agent routing both trusted a state
   that was no longer true. A minute-keyed reconciliation job now refetches provider state, caps an
   ordinary sandbox's bill at the same idle deadline Daytona enforces, and repairs stopped,
   archived, missing, and failed provider objects. A preview heartbeat advances both clocks while
   a customer is actually watching the iframe.
6. A lost create response could leave a paid provider sandbox with no `external_id`; retrying then
   created another. Provider names are now deterministic and the sandbox UUID is queried as an
   exact Daytona label before create and after an ambiguous failure. Multiple matches are an error,
   never a guess.

The snapshot is different from a sandbox: it is the reusable, content-addressed base carrying the
agent toolchain. It must survive individual agent sessions. When a new base has been deployed and
`SANDBOX_DAYTONA_SNAPSHOT` identifies it, `pnpm --filter=@lib/sandbox snapshot:prune` reports older
`sproutos-agent-*` bases without changing them. The explicit
`pnpm --filter=@lib/sandbox snapshot:prune -- --delete` form deletes them and refuses to infer which
configured snapshot is still live. A base referenced by any live Daytona sandbox or warm pool is
excluded even when it is not the locally configured base; production configuration must be switched
before this operator command is confirmed.

The installed SDK documents warm-pool listing, but Daytona Cloud v0.207 returned
`404 Cannot GET /api/warm-pools` during the live audit. Dry-run cleanup reports that missing proof;
confirmed deletion refuses outright until the account API can enumerate warm-pool references.

The public `DELETE` operation now means permanently done: it queues the existing durable destroy
handler, which deletes the Daytona sandbox, drops its Neon dev branch, and only then removes the
control-plane row. Inactivity still stops and archives instead, preserving work without an archived
container charge. Repository clone credentials now travel as fields on Daytona's structured Git
API rather than appearing in a sandbox command, process list, or clone URL.

The same run also exposed a control-plane bug: POSTing an existing stopped sandbox enqueued
`sandbox.stop` again. There was no start job. Restart now has its own handler, resets the metering
watermark after the unbillable stopped interval, and preserves the provider workspace.

## What is verified now

Against Daytona Cloud and the pinned `docker/sandbox.Dockerfile` snapshot:

- public Git clone, identity setup, instruction installation, and credential removal;
- streamed harness events through the same process API an agent turn uses;
- stop/start with a file surviving in `/home/daytona/workspace`;
- commit plus real push/ref negotiation against a bare remote;
- a signed preview URL serving a process left behind by a completed turn;
- the metadata service is unreachable;
- the database reaper meters the tail, stops the provider sandbox, and observes Daytona state
  `stopped`.
- the one-minute archive policy was accepted by Daytona and moved a stopped sandbox into
  `archiving`; terminal `archived` was not reached within a three-minute observation bound, after
  which the probe's `finally` deleted the sandbox. This proves initiation and cleanup, not archive
  completion latency.

A real model response is deliberately not claimed here. That requires the production LLM listener,
its SSM configuration, and a provider credential to be deployed first.

## Provenance and supersession

- `private_notes/groups.md` remains the requirements source: hosted Daytona, direct port previews,
  proxy-owned model credentials, and provider-state verification.
- `private_notes/sandbox-handoff.md` remains the record of the Docker-only evidence. Its warning is
  preserved; this finding records the Daytona follow-up rather than rewriting that history.
- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` remains authoritative on
  browser/effect verification rather than accepting exit codes as proof.
- `/Users/andrew/.claude/plans/double-sorted-meteor.md` remains the isolation and metering plan; its
  permanent Postgres partition-maintenance step is superseded by the ClickHouse cutover, not by the
  temporary default partition added to keep development writes safe during that cutover.

## The check that matters

Daytona is now named in the client type and factory. There is no Docker driver, provider selector,
or `SANDBOX_DRIVER`, so a green local-container substitute can no longer be mistaken for Daytona
evidence. Dependency injection remains only to keep unit tests from renting paid sandboxes.

The live egress test also uses the sandbox row's real UUID as the Daytona label and proxy username.
An earlier test invented a non-UUID name and never created the corresponding control-plane row; the
forward proxy could only reject it, so that was not proof of arbitrary public internet access. The
current test creates both halves, asserts proxied public HTTPS succeeds, explicitly bypasses proxy
variables and requires that to fail, and requires a metadata request to fail.
It is gated by `SANDBOX_LIVE_EGRESS_CONTROL_PLANE=1`: setting that flag asserts that `DATABASE_URL`
is the same database the configured public proxy authorizes against. Without it the provider-only
checks still run, but the network test reports skipped instead of presenting a local row as
production authority.

Explicit Done is similarly an observed lifecycle, not a queued intention: the dashboard waits for
the sandbox GET to become 404 after DELETE. Daytona sandbox deletion already uses
`delete(timeout, true)`, and snapshot pruning now polls the provider after the SDK's fire-and-forget
snapshot delete before it reports success.
