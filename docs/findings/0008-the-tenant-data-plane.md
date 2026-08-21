# 0008 — The tenant data plane

Found by provisioning a Postgres service through the API and trying to connect with what it
returned.

`pg-proxy` had never had a connection. It builds, it has 19 passing tests, its README describes the
security boundary precisely — and nothing had ever spoken to it. Four defects, all in the join
between the control plane and the proxy, none of them in either piece on its own.

---

## 1. The connection URI pointed past the boundary

`sproutPostgresConfigFromEnv` defaulted the customer-facing host to the admin URL's hostname when
`SERVICE_POSTGRES_PUBLIC_HOST` was unset.

The type had `publicHost` separate from `adminUrl`, with a comment saying it "may differ behind a
proxy". The fallback quietly undid that, and a forgotten environment variable produced not an error
but a **working connection string to the cluster every tenant's data is on**.

First real provisioning returned `postgresql://…@postgres.platform-db.svc.cluster.local:5432/…`.

It refuses now. That costs a local developer one variable and is the only default that cannot
silently be wrong.

## 2. The two languages named the database differently

TypeScript built `sprout_db_` + 32 hex characters of the UUID. Rust built `sprout_db_` + the
26-character Crockford short id.

Both had tests. Both passed. **Each asserted its own answer.**

The control plane creates the database; `lib/rust/tenant-auth` derives the name the proxy connects
to. And the proxy only ever sees the short id, because that is what a connection username carries —
so it could never have found the hex form.

`AGENTS.md` says three cross-language contracts each have one set of fixture vectors both sides
assert against. Two do. This was the one with none, which is exactly why it was the one that
drifted. There is a `fixtures/naming-vectors.json` now, generated from the implementations rather
than typed, read by both.

## 3. The driver issued backend credentials

`valkey.ts` and `search.ts` write a `service_credential` row — the table the proxies authenticate
against. `postgres.ts`, the driver actually in use, wrote `database_role` and nothing else. Three
roles existed, `service_credential` was empty, and every connection through the proxy failed
`password authentication failed for user`.

What it handed out was the Postgres role name and the role's own password: a credential for the
backend cluster, which works only by connecting directly. Together with #1, the whole Postgres path
had been built for direct connection and the proxy was never joined to it. The two drivers written
later got it right; the first was never revisited.

Two credentials now. The role password is how the proxy reaches the backend on a tenant's behalf and
stays sealed under KMS. The tenant secret is what the customer sends, is stored as a one-way hash,
and is the only thing the proxy verifies.

A consequence worth stating: `connectionUri` no longer returns a URI. It throws
`SecretNotRecoverableError`, like the other two drivers. It _used_ to work — and only because the
role password is sealed rather than hashed, which is precisely the property that made it the wrong
credential to hand a customer.

## 4. I wrote the check and then did not run it

`bin/check-images.sh` exists because a manifest naming a tag that is not in the registry applies
cleanly and fails as `ImagePullBackOff` on one workload. I wrote it, committed it, and then applied
a release without running it — and put `pg-proxy` into `ImagePullBackOff` inside the hour.

A check that is optional is a check that is sometimes skipped, including by the person who wrote it
forty minutes earlier.

---

## What the boundary actually does

Verified on the live cluster, from a pod in a tenant namespace:

```
select current_user, current_database()
 sprout_r_01m0hfmeqde64802m041hgn44w | sprout_db_01m0hfmeqde64802m041hgn44w
```

The tenant authenticated with a credential that only works through the proxy, and landed in their
own database as their own role — the proxy dropped its administrative privilege with `SET ROLE`
before splicing the session.

Then the test that matters. Tenant A's credential, tenant B's database name in the connection
string:

```
select current_database()
 sprout_db_01m0hfmeqde64802m041hgn44w      ← A's own, not B's
```

Not an error — a redirect. The proxy derives the database from the **authenticated identity** and
ignores what the client asked for, so there is no code path in which a client-supplied database name
influences routing. That is a stronger property than refusing the request, and it is worth knowing
it holds by construction rather than by a check somebody could remove.
