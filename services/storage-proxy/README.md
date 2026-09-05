# storage-proxy

The tenant boundary for object storage.

A customer's Obsidian — or `rclone`, or any S3 client — points at this instead of at a bucket. It
signs SigV4 with a `SPROUT…` access key exactly as it would against AWS, and cannot tell the
difference. That is the point: the plugin needed no changes, and neither does anything else that
speaks S3.

## What it does per request

1. **Identify.** One indexed lookup of the access key id in `service_credential`, joined through to
   `backend_service` and `organization`. No live row means no tenant, whatever the signature says.
2. **Authenticate.** The tenant's secret is _derived_ from the platform root key, the canonical
   request is rebuilt from what actually arrived, and the signature is compared in constant time.
3. **Authorize.** The bucket in the path must be the one this service's id produces. One string
   comparison against a value the customer cannot influence.
4. **Forward.** Re-signed with the platform's own credential, to the real store.

The order matters: checking the bucket before the signature would tell an unauthenticated caller
whether a bucket exists.

## Why it exists

Because the boundary should be somewhere it can be read, tested and changed.

The design this replaces gave each customer a real AWS access key scoped by an inline IAM policy to
one bucket. That works, and it puts the answer to _"can this customer see that vault"_ in a JSON
document on someone else's system, drifting from what the platform believes. It is the same argument
that retired the per-tenant CouchDB: a proxy is how every other backend service here is reached, and
object storage is not special.

Two things followed from it that were worse than the design itself:

- **A ceiling nobody would have found until it hit.** An AWS account allows 5,000 IAM users, so it
  supported 5,000 object-storage services and then stopped.
- **The most important property was the one thing never tested.** IAM policy _evaluation_ is a
  LocalStack Pro feature, so the two assertions that would have proved one customer cannot read
  another's vault were gated behind a variable nobody could set. Moving the boundary into a process
  in this repository is what made it checkable — `object-storage-proxy.test.ts` starts this binary
  and asks the question with a real AWS SDK doing the signing.

## Secrets are derived, not stored

Verifying a SigV4 signature needs the secret itself: the client presents an HMAC over a canonicalised
request, and the only way to check it is to recompute that HMAC. So this process must be able to
obtain every tenant's secret. That is inherent to the protocol and no storage choice avoids it.

What a storage choice decides is what a _database_ leak is worth. Sealing each secret with KMS would
put a reversible ciphertext in `service_credential` for every tenant. Deriving puts nothing there:

```
secret = base32(HMAC-SHA256(root_key, access_key_id))
```

`service_credential` keeps the access key id and a hash, exactly like every other credential kind,
and a dump of it stays unreplayable. `lib/rust/s3-sigv4/src/tenant.rs` carries the derivation and
`fixtures/tenant-secret.json` is the contract `lib/typescript/services` asserts against.

Because a derived secret cannot be deleted — it is a function of a key and an identifier that both
still exist — **the credential lookup is the revocation.** A rotated-away key still signs correctly
forever; it stops meaning anything the moment no live row answers.

## Suspension

`backend_service.status`, read on the way through. Not a permission removed at the cloud provider,
where the platform's belief and the provider's are two facts that can disagree and the customer
experiences the provider's. The same correction Postgres needed.

## Presigned and public requests

Query-presigned SigV4 requests use the same live credential lookup, bucket authorization, service
status, and credit check as header-authenticated requests. Their expiry is limited to SigV4's
seven-day maximum, while credential rotation or service suspension revokes them immediately.
Capability URLs receive wildcard CORS headers so an arbitrary browser origin can use them.

Physical buckets remain private. An anonymous `GET` or `HEAD` is served only when the service's
`public_read` default or the object's `sproutos:visibility` tag permits it. `public-read` and
`private` canned ACLs map to that reserved tag; `GetObjectAcl` and `PutObjectAcl` expose the mapping
to ordinary SDKs. Listings and every mutation remain authenticated. Public responses honor the
object metadata returned by S3, including `Cache-Control`. Customer tagging operations are refused
so they cannot inspect, replace, or accidentally remove the reserved access-control tag.

## Deliberately not supported

- **SigV4 streaming chunked uploads** (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`). Each AWS-framed chunk
  carries its own signature, and accepting that literal without validating every frame would be
  verifying nothing. Ordinary high-level SDK multipart uploads are supported: each `UploadPart`
  is a normal signed request.
- **Virtual-host addressing.** The bucket would live in the `Host` header — a wildcard DNS record and
  certificate per tenant, and a header the client controls deciding which tenant it is.

## Refusals say nothing

Every 403 returns the same code _and the same message_. An unknown key, a wrong signature and
someone else's bucket are one outcome to the caller; distinguishing them even in the text is an
oracle that confirms first that a key exists and then that a bucket does.

This was wrong when first written — the codes matched and the messages did not — and the unit test
comparing status codes passed on it. The integration suite now compares the response bodies of three
real refusals against each other.

## Configuration

| Variable                                  | Meaning                                                        |
| ----------------------------------------- | -------------------------------------------------------------- |
| `STORAGE_PROXY_LISTEN`                    | Address to bind. Default `0.0.0.0:9000`                        |
| `STORAGE_PROXY_UPSTREAM`                  | Where the buckets are. Required                                |
| `STORAGE_PROXY_REGION`                    | SigV4 region for the re-signed request                         |
| `SERVICE_OBJECT_STORAGE_ROOT_KEY`         | The key every tenant secret derives from. Required, no default |
| `STORAGE_PROXY_DATABASE_URL`              | Falls back to `DATABASE_URL`                                   |
| `STORAGE_PROXY_MAX_BODY_BYTES`            | Per-request disk-spool ceiling. Default 64 MiB                 |
| `STORAGE_PROXY_MAX_INFLIGHT_BODIES`       | Simultaneous request spools. Default 4                         |
| `STORAGE_PROXY_BODY_READ_TIMEOUT_SECONDS` | Maximum time to receive a request body. Default 300 seconds    |

The platform credential comes from the AWS SDK default credential chain. In production, use the
EC2 instance profile, ECS task role, or another refreshable role provider; the proxy refreshes temporary credentials
before they expire. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional
`AWS_SESSION_TOKEN` remain supported by that chain for local development and tests, but are not
production configuration requirements.

Uploads are written into an unlinked, bounded temporary file while their payload digest is checked.
Only a verified body is streamed onward to S3. Object responses stream from S3 to the caller with
backpressure and are never accumulated in memory; only list responses are buffered because their
internal tenant prefix must be removed from the XML. A high-level SDK should use multipart upload
for files whose individual request parts exceed the configured spool ceiling.

This is mutable application storage, not static deployment storage. A customer's SDK may put,
read, list, and delete these objects. Static SPA releases are immutable, content-addressed build
artifacts expanded by the platform worker and served through CloudFront; they do not expose this
endpoint or a customer storage credential.

The database role needs `select` on `service_credential`, `backend_service` and `organization`, and
`update` on `service_credential.last_used_at`. Nothing else.
