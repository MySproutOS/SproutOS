# search-proxy

One OpenSearch cluster, many tenants, split by index name. A tenant points an Elasticsearch or
OpenSearch client at this as though it were their own cluster.

> TASK 33: we can also utilize Elasticsearch as an offering, and make it tenant split such that an
> Elasticsearch database shares resources with others. We manage the database ourselves in EC2
> instances.

## Namespacing now; server-enforced isolation still required

OpenSearch's Apache-2.0 Security plugin supports per-role index patterns. The proxy closes the known
path, query-string and body escapes, but request inspection cannot prove that every current and
future search-body construct is unable to name an index. Complete isolation therefore requires a
per-tenant OpenSearch role underneath this proxy; that role is separate work and is not claimed by
the request hardening here.

The proxy still has three necessary jobs: `naming.rs` decides what a legal index name is and how it
is prefixed, `routes.rs` decides which requests are allowed through at all, and `body.rs` rewrites
the documented index names that appear inside bodies rather than paths. It is also the place every
request crosses for metering.

## OpenSearch, not Elasticsearch

Elastic's licence has not been open source since 7.11, and "we manage the database ourselves in EC2
instances" is precisely the deployment that licence is written to prevent. OpenSearch is the
Apache-2.0 fork of the same codebase and speaks the same API, so a customer's Elasticsearch client
works unchanged.

## The namespace

```
t01j4pkz2hbfh6sw7sa7d65tvkz_products
^^^^^^^^^^^^^^^^^^^^^^^^^^^^ the tenant
```

A prefix rather than the hash tag the Valkey proxy uses, because index names are far more
constrained: lowercase only, no `\ / * ? " < > | ` space, comma or `#`, and they may not begin with
`-`, `_` or `+`. The leading `t` is there because a short id begins with a digit and a fixed letter
makes the prefix recognisable in an operator's `_cat/indices`.

The separator is `_`, not `-`. A customer's index name may legitimately contain `-`, and splitting
on a character they also use makes `strip` ambiguous. `_` is legal inside a name and illegal as its
first character — exactly the property that makes it a safe separator.

## An allowlist, and unknown means refuse

OpenSearch's API is large and most of it is cluster-wide:

| Endpoint                | What it would give a tenant                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `_cat/indices`          | Every other tenant's index names                                        |
| `_cluster/settings`     | Reconfigures the cluster for everyone on it                             |
| `_snapshot`             | Restores over it                                                        |
| `_reindex`              | **A source index in its body** — a direct read of another tenant's data |
| `_aliases`, `_template` | Names indices outside the request path                                  |
| `_nodes`, `_tasks`      | The shared cluster's shape and everyone's running queries               |

All refused. Forwarding anything not explicitly known to be dangerous is a bet that the next
OpenSearch release adds no new way to read across indices, and that bet only has to lose once.

`_all` is the one `_`-leading segment that is **not** an endpoint — it is OpenSearch's spelling of
"every index", so it belongs on the index path where it becomes `<prefix>*`. The first version of
this file refused it, and a test caught that.

## Bodies, not just paths

`_bulk` and `_msearch` carry an index per line. Namespacing the path and leaving the body alone
would let a `_bulk` write into anyone's index, so every line that parses as a JSON object has its
`_index` (and `_msearch`'s `index`, which may be an array) rewritten.

Every object, rather than tracking which lines are action lines and which are documents. Parity
tracking gets out of step the moment a body is malformed, and a wrongly-parsed action line is a
cross-tenant write. The trade is that a _document_ containing its own `_index` field would be
rewritten; there is a test that names this explicitly, and it is the direction the trade should
fall.

`_mget` is ordinary JSON rather than NDJSON. Its root object and `docs` descriptors are validated
against the documented shape, and every `docs[]._index` is namespaced. A bare `/_mget` requires an
index on every descriptor; the `ids` shorthand is accepted only when the index is already in the
path.

Query parameters are also allowlisted. In particular, `index`, `source` and
`source_content_type` are refused rather than allowed to override a path or smuggle a body past the
rewriter. Duplicate parameter names are refused after decoding, so two spellings cannot rely on
different first-value/last-value behavior in the proxy and OpenSearch.

## Responses

Every search hit carries `"_index": "t01j…_products"`. A client that reads it and sends it back —
which is what any "reindex this document" flow does — would get it prefixed twice, so the prefix is
stripped on the way out, from error responses too: an OpenSearch error names the index it objected
to, and that name is the namespaced one.

This is a textual replacement where the prefix begins a JSON string, not a parse of the whole
response. A response can be megabytes of hits, and reparsing it to change one field per hit is work
proportional to the data rather than to the change. The one thing it could get wrong is a tenant who
stores their own prefix at the start of a string field — their own resource id, in their own
document, harmless.

## Basic auth

`Authorization: Basic <username>:<secret>`, where the username is the tenant username from
`lib/rust/tenant-auth`. Every Elasticsearch and OpenSearch client supports it and most default to
it; a bearer token would mean configuring a custom header in a client that may not have one.

Verification goes through `lib/rust/service-credentials`, shared with the Valkey proxy. Two
implementations of "is this secret right" is one more than can be kept correct — a divergence there
is not a bug in one proxy, it is a tenant reading another tenant's data through whichever one
drifted.

## Configuration

| Variable                         | Default                      | What it is                            |
| -------------------------------- | ---------------------------- | ------------------------------------- |
| `SEARCH_PROXY_LISTEN`            | `0.0.0.0:9200`               | Where tenants connect                 |
| `SEARCH_PROXY_UPSTREAM`          | `http://127.0.0.1:9200`      | The shared cluster                    |
| `SEARCH_PROXY_DATABASE_URL`      | falls back to `DATABASE_URL` | Control plane, for credential lookups |
| `SEARCH_PROXY_DB_POOL`           | `8`                          | Control-plane connections             |
| `SEARCH_PROXY_SECURITY_ROOT_KEY` | required                     | HMAC root for internal tenant users   |
| `SEARCH_METERING_SPOOL_DIR`      | `./search-metering`          | Durable query/storage usage records   |

Unlike the Valkey proxy, a lookup happens **per request** rather than per connection, because HTTP
connections are pooled and reused across tenants by intermediaries. That is why the pool is larger
and why the credential hash is SHA-256 rather than Argon2 — see `lib/rust/tenant-auth`.

## Testing

```bash
docker compose up -d
pnpm --filter=dbmigrator run migrate:latest
DATABASE_URL=... cargo test -p search-proxy
```

Unit tests cover the naming rules, the endpoint table and the body rewriting. `tests/proxy.rs` is
the one that matters: it provisions two real tenants, has both write to an index of the **same
name**, and asserts neither can see the other's documents — checked from _outside_ the proxy, by
asking OpenSearch which indices exist. An inside-the-proxy check would pass even if a request were
forwarded unnamespaced, because the tenant that wrote it would read its own document back.

Index names in those tests are unique per run. The cluster is shared and long-lived, so a fixed name
means a stray index from an earlier run fails today's test for yesterday's reason.

The integration tests skip when the services are absent and **fail in CI**, because a skipped
isolation test looks exactly like a passing one.

## Deleting a tenant

Not here. `destroy` revokes the credential, which makes the indices unreachable; `@lib/reaper`
deletes them out of band, against the cluster rather than through this proxy. That matters more here
than for the queue proxy, because an abandoned index holds shards whether anyone can reach it or
not, and shards are the resource a shared cluster runs out of first.

`prefix_for` in `naming.rs` is duplicated as `tenantIndexPrefix` in
`lib/typescript/services/src/tenant-auth.ts`, with the same fixture asserted on both sides — a
reaper that computed the namespace differently from this proxy would delete either nothing or
another customer's data.

## Not built yet

- **Query cost caps.** A tenant can still send a query that is expensive for everyone on the shard —
  deep pagination, a huge `terms` aggregation, a wildcard leading a term. The shape of the fix is a
  body inspection with limits; the shape of getting it wrong is refusing legitimate queries, so it
  wants real traffic to calibrate against.
- **Metering details.** Successful `_search` and `_count` requests count one `es_search_unit`;
  successful `_msearch` counts its executed header/body pairs. The observation is committed to the
  fsynced spool after OpenSearch accepts it and before the response body is returned. Once per UTC
  hour the proxy enumerates only managed Security-plugin users and samples primary-store bytes via
  each tenant user's scoped `_stats`, emitting `es_storage_gib_hour`. Delivery retries through the
  signed ingest path and is fail-open when its bounded spool is unavailable.
- **Scroll and PIT lifecycle.** A point-in-time id is a cluster-wide handle; `_pit` is allowed for
  creation but the ids are not scoped, so one tenant holding another's id is not yet prevented.
