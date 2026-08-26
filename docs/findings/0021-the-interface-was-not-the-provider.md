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
   create returned 400. Sandboxes now use the provider-enforced twenty-domain policy and the live
   test proves the metadata endpoint is unreachable.
3. Deleting a Daytona process session kills descendants, including a `nohup` dev server. The old
   cleanup made previews disappear when an agent turn ended. Completed agent sessions now live
   until sandbox stop/destroy, where they are explicitly removed.

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

The production driver is now the live test. There is no Docker `SandboxDriver` and no driver
selector, so a green local-container substitute can no longer be mistaken for Daytona evidence.
