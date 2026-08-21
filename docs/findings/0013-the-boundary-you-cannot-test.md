# 0013 — The boundary you cannot test

Object storage was the last backend service to get a proxy, and the reason it went last is the
finding.

## What it looked like while it was wrong

A customer provisioning object storage received a real AWS access key, belonging to a real IAM user
created for them, carrying an inline policy scoped to their bucket. Everything worked. The plugin
connected, the vault synced, and the driver had a test suite with a test in it called *"gives each
vault a policy naming only its own bucket"*, which passed.

It passed by reading the policy document back out of IAM and checking the ARNs in it. That test is
honest about itself — it says in a comment that it asserts the policy rather than attempting the
read, because LocalStack's free tier accepts IAM calls and evaluates none of them. Below it sat two
more tests, the ones that would actually have proved isolation, gated behind
`SERVICE_OBJECT_STORAGE_ENFORCES_IAM=true`.

Nobody could set that variable. Policy evaluation is a LocalStack Pro feature and the platform runs
on the free one. So the most important property of the design — one customer cannot read another's
vault — was the single thing never executed, in a suite that was otherwise green.

## The question worth asking

`docs/findings/` keeps arriving at the same place: the question is not whether a check passes but
what would have to be true for it to fail. Here the answer was *nothing*. There was no state of the
code that turned those tests red, because they did not run.

And the escape hatch made it worse than a missing test would have been. A missing test is an absence
somebody notices. A skipped test is a line of code that reads like coverage, sits next to real
assertions, and is counted in "2 skipped" at the bottom of a run nobody reads twice.

## What actually changed

The fix was not a better test. It was moving the boundary somewhere a test could reach it.

`services/storage-proxy` verifies a tenant's SigV4 signature, checks the bucket in the path belongs
to the service that key resolves to, and re-signs with the platform's credential. The customer never
holds a cloud credential. The isolation check is now: start the binary, point two real AWS SDK
clients at it, and ask one to list the other's bucket. It runs on every `pnpm test`.

That is the general shape, and it is worth stating plainly because it will come up again:

> **A boundary enforced by a system you cannot run is a boundary you cannot test.** When the check
> is unreachable, the thing to change is usually not the check.

The same argument had already retired the per-tenant CouchDB a day earlier, for a reason that
sounded different at the time — "a leaked database URL is somebody else's server" — and was the same
reason underneath.

## Two things that fell out for free

**A ceiling nobody would have hit in testing.** An AWS account allows 5,000 IAM users. The old
design supported 5,000 object-storage services and then stopped, with an error from IAM that would
have arrived on a Tuesday in production.

**Suspension became a fact instead of two.** Revoking a customer's access at the cloud provider
means the platform's belief and the provider's belief are two records that can disagree, and the one
the customer experiences is the provider's. The proxy reads `backend_service.status` on the way
through, so there is one. This is the third time that correction has been made — Postgres needed it,
then CouchDB, now this — which suggests it is not a mistake so much as a default that has to be
argued out of.

## And one the tests caught on the way

Every refusal answered `403 AccessDenied`, which was the design, and three different messages, which
was not: *"unknown access key"*, *"the signature does not match"*, *"that bucket does not belong to
this credential"*. That is an oracle. It confirms first that a key exists, and then that a bucket
does.

There was a unit test asserting the refusals were indistinguishable. It compared status codes and
error codes, and passed. The integration test — which compares the bytes three real clients
receive — did not.

Both tests were written in the same hour, by the same author, with the same intent. The difference
is that one asserted on a value the code computes and the other asserted on what a client can see.
When the property is *"an attacker learns nothing"*, only the second kind of test is about the
property.
