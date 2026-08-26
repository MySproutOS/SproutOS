# 16. One layer under the one we checked

**Date:** 2026-08-26
**Found by:** trying to close [[0015-the-databases-the-product-sells]] and getting one layer further down

## What it looked like

[[0015-the-databases-the-product-sells]] ended with a plan. Three datastores, three missing pieces,
and for each one a named thing to do. The Valkey paragraph was the careful one — it had already been
wrong once, was rewritten, and the rewrite said so:

> It took reading what the proxy actually opens — `TcpStream::connect`, no TLS — against what the
> instance actually demands to see that they do not fit. Both facts were a grep away the whole time.

That is the right lesson and it was drawn from the right evidence. It was also drawn one layer too
high. `valkey-proxy` opens two connections, not one: the upstream it forwards to, and the
control-plane database it authenticates against. The finding read the first and stopped.

## What was actually true

`CredentialStore::connect` — the code all three proxies share, the reason there is only one
implementation of "is this secret right" — opened its pool with `NoTls`.

The control-plane RDS runs on `default.postgres17`:

```
$ aws rds describe-db-parameters --db-parameter-group-name default.postgres17 \
    --query "Parameters[?ParameterName=='rds.force_ssl'].[ParameterValue]" --output text
1
```

An unencrypted connection is refused by the server before authentication. So the plan 0015 laid out
— give the router `DATABASE_URL` and the splits will start — would not have started a split. It
would have stopped the router, because `check()` is deliberately fatal at boot and the router is the
front door. The recommended fix for "the product sells no databases" was an outage.

## Why the careful paragraph still missed it

Because it was looking at the thing that had been wrong before.

The valkey rewrite was prompted by a mismatch between a proxy and its backend, so it went and
compared a proxy against its backend, found a second instance of the same mismatch, and wrote it up.
The check it performed was "does this proxy's transport match what it connects to" — and it ran that
check against exactly one of the two things the proxy connects to. Nothing in the finding says which
connection it examined, because at the time there was only one connection worth thinking about.

The shared crate made it worse rather than better. `service-credentials` exists so that three proxies
cannot disagree about a credential, and that is a real property it delivers. What it also does is
put the second connection somewhere other than where a reader of `valkey-proxy` is looking, so a
review of the proxy passes over it without noticing there was something to pass over.

## The other thing directly underneath

Publishing OpenSearch from the OVH box needed a route on 443. The route was written the way
ClickHouse's already was, plus a password, because unlike ClickHouse the cluster authenticates
nobody. Valkey is not HTTP, so it got a Traefik **TCP** router on the same entrypoint — Traefik
multiplexes both by SNI, so it shares 443 and needs no entrypoint added.

That took the whole host's certificate renewal down. A TCP router with TLS on an entrypoint stops
Traefik answering the `acme-tls/1` ALPN there, so Let's Encrypt's `tls-alpn-01` challenge fails for
**every** domain on 443:

```
Cannot negotiate ALPN protocol "acme-tls/1" for tls-alpn-01 challenge
```

Measured both ways: with the TCP router present, `opensearch.sproutos.me` failed five authorizations
and hit the rate limit; with it removed and nothing else changed, the certificate issued in ninety
seconds. The forum's own `s3.forum` and `static.forum` names were failing identically at the same
time, and had been for a day, which is how long it takes for this to look like somebody else's
problem.

An existing certificate keeps working. So the cost of this is invisible for sixty days and then
takes out the forum, ClickHouse and search at once, for a change nobody would connect to it.

## What now stops them

Nothing generic, and that is the honest answer. There is no check that would have caught either.

What is written down instead is the _pair_, in both places a reader will be:
`service-credentials` now says in its own module documentation that the control-plane connection is
the second connection and that RDS refuses it in the clear, and `ovh/docker-compose.yaml` says on
the Valkey service why the obvious route is not available and what it costs.

One thing did work, and it is worth naming because it is cheap. `bin/check-app-config.mjs` was run
after every change to what an instance reads, and it caught the RDS chain question before a deploy:
the certificate was verified from an instance against the bundle before anything was pushed, rather
than by watching a fill fail. It also turned out to be inventing nine of its own findings — the
first letter of every comment sentence inside `KEYS=(…)` parsed as a one-letter variable name — so
its report was mostly noise, which is the state in which a real entry stops being read.

## The question worth asking

0015 asked "has anything ever asked this deployment for a database?" — the right question, and it
found three real gaps. The question this one is: **for each thing you checked, what else is
underneath it that you did not check?** Every miss here was one layer under something that had just
been examined carefully. The proxy's upstream was checked and its database was not. The HTTP route
was copied correctly and the TCP one was assumed to be the same shape.

Related: [[0015-the-databases-the-product-sells]], [[0008-the-tenant-data-plane]],
[[0013-the-boundary-you-cannot-test]].
