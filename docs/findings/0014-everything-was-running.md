# 14. Everything was running

**Date:** 2026-08-25
**Found by:** sending one HTTP request to a hostname that had never been requested before

## What it looked like

The estate applied cleanly. `tofu plan` reported no changes. Every resource AWS could be asked
about said it was fine:

- The NAT instance: `running`.
- The router instances: `running`, and the Auto Scaling group called them `Healthy`.
- The database: `available`.
- The load balancer: `active`, with a validated certificate.

Nothing anywhere said the platform could not serve a request, because from each component's own
point of view it could.

## What was actually true

Five things, discovered in the order the request hit them, each hidden behind the one before it.

**The private subnets had no egress at all.** The NAT instance's network interface — the one
holding the Elastic IP, the one every private route table points at — was in state `available`.
Never attached. The default route in all three private route tables read `blackhole`.

The reason is a loop that reads as obviously wrong once written down and did not while being
written: the instance launched into a public subnet with `map_public_ip_on_launch = false`, so it
had no address, and its user data asked it to call `ec2:AttachNetworkInterface` to pick up the
interface. That call goes to the EC2 API over the internet — the internet this instance exists to
provide. It could not make the call. It stayed `running` and healthy forever.

**The instance role could read the release but not decrypt it.** The artifacts bucket is SSE-KMS,
and `s3:GetObject` without `kms:Decrypt` fails as `AccessDenied` **on GetObject** — the message
names the KMS key, but only to someone reading it on the instance being destroyed.

**The router refused its own configuration.** The platform Valkey is ElastiCache with
`TransitEncryptionMode = required`, so its URL is `rediss://`. The redis crate was compiled without
a TLS feature and rejected the URL at parse time, before opening a socket.

**With TLS enabled it aborted instead.** rustls 0.23 takes its cipher suites from a process-wide
`CryptoProvider` and only infers one when exactly one is compiled in. Two were: the AWS SDK brings
`aws-lc-rs`, redis brings `ring`. It panicked on the first TLS connection.

**And the load balancer would not have sent it a request anyway.** The ALB had been narrowed to two
availability zones to stop paying for a third public IPv4. The Auto Scaling groups still spanned
three private subnets. An instance in the third reported `unused` — "Target is in an Availability
Zone that is not enabled for the load balancer".

## Why nothing caught it

Every check that existed passed, and each was answering a narrower question than the one that
mattered:

| The check         | What it actually asked                                  |
| ----------------- | ------------------------------------------------------- |
| `tofu plan`       | do the resources match the configuration                |
| ASG health        | is the instance running                                 |
| `cargo test`      | does the code behave against a local Valkey with no TLS |
| `cutover.test.sh` | does the script make the right API calls                |

None of them asked _can a request reach a customer's code_, and that is the only question whose
answer was no. The failures were all in the seams — between an instance and its egress, between a
role and a key, between a crate's features and a managed service's requirements, between a load
balancer's zones and an autoscaler's. Seams are where no component's own health check looks.

There is a second pattern worth naming. Two of these were **`ignore_changes` hiding our own edit**:
the listener kept a single-target forward and the database came up on Postgres 17 while the
configuration said 18, both with `plan` reporting no changes. `ignore_changes` is written to absorb
drift from outside; it absorbs drift from inside identically, and nothing distinguishes them.

## What now stops it coming back

- The NAT interface is attached **at launch** as the instance's primary interface. There is no API
  call to make, so there is no call that can fail. `nat.tf` says why.
- The ALB's subnets and the Auto Scaling groups' subnets are both sliced from
  `local.serving_zone_count` in `network.tf`. They cannot diverge without editing one number.
- `database.tf` no longer ignores `engine_version`; `auto_minor_version_upgrade = false` already
  meant there was no drift to ignore.
- `compute.tf`'s remaining `ignore_changes` — which is load-bearing, the cutover owns those weights
  — now states in the file that a change to the _shape_ of the block is invisible to `plan` and
  needs `-replace`.
- The router's `Cargo.toml` says in a comment why `tokio-rustls-comp` is not optional, and `main`
  installs a `CryptoProvider` explicitly with the reasoning beside it.

## The check that would have caught all five

One request, to one hostname, from outside. It took about four minutes to run and found in sequence
what four kinds of green checkmark had missed entirely. It is now the last step of a deploy rather
than something done once by hand.
