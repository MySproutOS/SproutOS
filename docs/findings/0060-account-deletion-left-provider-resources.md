# 0060: Account deletion could outlive its cleanup

## What was wrong

The account and organization routes marked their database rows deleted and only then enqueued the
project jobs in separate transactions. A process exit between those operations left resources
running with no durable work describing how to remove them.

The proposed repair also copied the retired ACM/ALB custom-domain deletion path after certificates
had moved to the Rust edge, and copied Daytona sandbox deletion without dropping the sandbox's Neon
development branch. Group projects were marked `deleting` even though no teardown job was created
for groups. Finally, an account with provider cleanup in flight retained its other sessions and API
keys until the job finished.

Those failures all looked like a successful `200`: the control-plane rows disappeared from normal
queries while a certificate, development branch, service, sandbox, or credential could survive.

## What changed

- Soft deletion, progress-row creation, background-job enqueueing, and immediate account disablement
  now commit together.
- Custom domains use the ACME/S3 reconciliation lease. Their route is withdrawn before the exact S3
  certificate version is deleted and the Rust edge is invalidated. A busy issuer fails the project
  teardown instead of being mistaken for completion.
- Project teardown delegates sandboxes to the canonical destroy handler, which also removes their
  Neon development branches.
- Provider-backed object storage is dispatched through its real service driver.
- Group containers move directly to `deleted`, while source-repository records remain as tombstones
  and no GitHub repository deletion API is called. GitHub installation rows are disabled so the
  platform stops minting new tokens.
- The account identity is anonymised only after every project cleanup succeeds, but all login,
  session, API-key, OAuth, membership, and invitation paths are revoked at request time.

## What stops it recurring

The database-backed account test creates a repository group and child project, proves the teardown
job was committed, forces a provider failure, and verifies that the user is disabled but not yet
anonymised. After cleanup succeeds it verifies the GitHub repository identity is unchanged and the
installation is disabled.

The project teardown test covers dynamic and static deployments, an ACME certificate object,
provider service, sandbox, environment secret, and retained billing history. It first holds the
custom-domain lease and proves neither the certificate nor Lambda is removed; after releasing the
lease, the retry removes every provider fixture and reaches `deleted`.
