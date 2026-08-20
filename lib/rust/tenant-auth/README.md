# `sproutos-tenant-auth`

Turning a connection's username and password into a tenant identity. Used by `pg-proxy`,
`valkey-proxy` and `search-proxy`.

## The problem

The Postgres startup packet and the RESP `AUTH` command give a proxy exactly two strings: a
username and a secret. No headers, no bearer token, no SNI worth trusting. Whatever routing and
tenancy information the proxy needs has to be inside those two strings — and only one of them may
be read before authentication.

So the username carries the identity, and the password proves it.

## The username scheme

```text
<kind>_<resource-short-id>.<organization-short-id>

db_01j4pm0000e008000000000051.01j4pkz2hbfh6sw7sa7d65tvkz
kv_01j4pm0000e008000000000051.01j4pkz2hbfh6sw7sa7d65tvkz
ix_01j4pm0000e008000000000051.01j4pkz2hbfh6sw7sa7d65tvkz
```

| Part                      | Width | Meaning                                                            |
| ------------------------- | ----- | ------------------------------------------------------------------ |
| `<kind>`                  | 2     | `db` a Postgres database, `kv` a valkey queue, `ix` a search index |
| `_`                       | 1     | separates the kind from the resource it names                      |
| `<resource-short-id>`     | 26    | the resource UUID, base32                                          |
| `.`                       | 1     | separates the resource from its owner                              |
| `<organization-short-id>` | 26    | the organization UUID, base32                                      |

Total: **56 bytes**, fixed, for every tenant.

### Why 56 bytes

Postgres role names are `NAMEDATALEN - 1` = **63 bytes**; anything longer is truncated by the
server, and a truncated username is a username that identifies the wrong tenant. That is the
binding constraint, and it rules out the obvious encoding: two hyphenated UUIDs are 72 characters
before separators, and two unhyphenated hex UUIDs are 64 — already over budget with nothing left
for the kind.

A 128-bit id needs 26 base32 digits (130 bits of capacity, of which the leading digit uses 3). Two
of those plus three bytes of structure is 56, leaving seven bytes of headroom under the Postgres
limit. Nothing is hashed or truncated: the UUIDs are recovered exactly, so the proxy does no
database lookup to learn which tenant is connecting.

### Why these characters

The alphabet is Crockford base32 in lowercase — `0123456789abcdefghjkmnpqrstvwxyz`, which drops
`i`, `l`, `o` and `u`. So the full character set of a username is `[a-z0-9._]`, and that set was
chosen for what it _cannot_ do:

- **No NUL, CR, LF or space.** A Postgres startup packet is NUL-delimited and RESP is CRLF-framed.
  A username that can contain either is a protocol-injection bug waiting to be written.
- **No `:` and no `@`.** Both are userinfo delimiters in `postgres://` and `redis://` URLs. A
  username containing `:` splits into a wrong username and a wrong password somewhere in a client
  library, and the failure surfaces far from its cause.
- **No `/`, `"`, `'`, `\` or backtick.** Nothing that needs quoting in a `psql` invocation, a
  connection string, a YAML value or a log line.
- **`_` and `.` only, as structure.** `.` before the organization matches the convention Postgres
  poolers already use for tenant suffixes (`user.tenant`), so operators recognise it on sight, and
  `_` inside the local part is unremarkable in a Postgres role name. Neither separator can appear
  inside a short id, so parsing is unambiguous: exactly one `.`, exactly one `_`.

### Why only the canonical spelling parses

Crockford's decoder is normally forgiving: it folds `i` and `l` onto `1`, `o` onto `0`, and
uppercase onto lowercase. This crate refuses all of that, and also refuses a leading digit above
`7` (which would decode to more than 128 bits).

The reason is that a tenant must have exactly **one** username. Anything else means two spellings
that resolve to the same tenant but are different strings — and connection pools, rate limiters,
audit logs, `pg_stat_activity` and per-tenant metrics are all keyed on the string. One tenant with
two spellings is a rate limit that can be doubled and an audit trail that splits in half.

### What parsing does and does not mean

`TenantIdentity::parse_username` is _identification_. It answers "who does this connection claim to
be", it involves no secret, and its result must never authorize anything on its own. `verify_secret`
against the stored hash is what turns the claim into a fact. Keep them in that order and keep the
identity unusable until the secret checks out.

## SRN mapping

Every identity names exactly one [SRN](../srn/README.md), so an authenticated connection can be
handed straight to the policy layer:

| `ResourceKind` | Username prefix | SRN                                          |
| -------------- | --------------- | -------------------------------------------- |
| `Database`     | `db`            | `srn:sproutos:db:<org>:database/<resource>`  |
| `Queue`        | `kv`            | `srn:sproutos:store:<org>:queue/<resource>`  |
| `SearchIndex`  | `ix`            | `srn:sproutos:search:<org>:index/<resource>` |

The username prefix and the SRN service deliberately are not the same string: the prefix is
constrained by a 63-byte budget, the SRN service is the name the rest of the product uses.

## Secrets

Connection secrets are stored as Argon2id PHC strings:

```text
$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
```

- **Argon2id**, the memory-hard variant, at the OWASP baseline: 19 MiB, 2 passes, 1 lane.
- **`hash_secret`** draws a fresh 16-byte salt from the OS RNG per call, so two tenants with the
  same secret have different hashes.
- **`verify_secret`** hashes the candidate with the salt _and parameters recorded in the stored
  string_, then compares digests in constant time (`password_hash::Output` compares through
  `subtle`). Raising the cost later therefore does not invalidate existing credentials — but it
  also means the stored string dictates how much memory the check allocates, so only ever pass
  hashes that came from our own storage.
- `Ok(false)` is a wrong secret. `Err` is a _broken stored credential_, an operational fault to
  page on rather than a login to reject with "wrong password".

A verification costs ~19 MiB and tens of milliseconds, on purpose. That is a per-_connection_ cost,
never a per-query one: the proxies authenticate once at connect time and cache the resulting
`TenantIdentity` for the life of the connection. A proxy that calls `verify_secret` on a hot path
has turned its own tenant isolation into a denial-of-service vector.

## Usage

```rust
use sproutos_tenant_auth::{TenantIdentity, verify_secret};

# fn stored_hash_for(_: &TenantIdentity) -> String { String::new() }
# let (username, password) = ("db_01j4pm0000e008000000000051.01j4pkz2hbfh6sw7sa7d65tvkz", b"");
let identity = TenantIdentity::parse_username(username)?;
let stored = stored_hash_for(&identity);

if verify_secret(password, &stored)? {
    let _srn = identity.srn();
}
# Ok::<(), Box<dyn std::error::Error>>(())
```
