# 0078 — The S3 query was encoded twice

## What was wrong

An ordinary boto3 client could `PutObject` and `GetObject` through `storage-proxy`, but
`ListObjectsV2(Prefix="python/")` returned `403 AccessDenied`. The proxy log called it a signature
mismatch, even though the same credential and SDK had just written and read an object.

The wire query contained `prefix=python%2F`. `canonical_query` treated the already encoded `%2F`
as three literal characters and encoded the percent sign again, producing `python%252F`. boto3 had
signed `python%2F`, so the proxy verified a different canonical request. The TypeScript AWS SDK's
equivalent integration test emitted a literal slash and therefore never exercised the defect.

## What stops it recurring

Query names and values are percent-decoded as bytes before SigV4's canonical URI encoding is
applied. A plus sign remains a literal plus rather than becoming a form-encoded space. Unit vectors
pin `%2F`, `%25`, and `+` behavior.

The object-storage integration suite also launches a real Python process with `uv` and boto3. It
provisions a normal SproutOS credential and performs PUT, GET, LIST, and DELETE through the running
Rust proxy. This keeps the compatibility claim attached to the client shape that exposed the bug,
instead of assuming one AWS SDK represents all of them.

## Rejected detour

A disposable real-AWS proof established that one shared Lambda execution role can isolate direct
S3 access by `${lambda:SourceFunctionArn}`, including aliases, multipart uploads, and SigV4
presigned reads. Two functions could not read, write, or list each other's prefixes.

That design was still rejected for customer object storage. Once AWS credentials are issued, the
platform no longer has a synchronous per-project cutoff or metering boundary. The product requires
service access to stop when spendable credit is exhausted while retaining the bytes for a funded
two-day recovery window. The existing Rust proxy already owns exactly that authorization boundary,
so making it protocol-compatible and bounded is smaller and safer than adding STS leases, access
points, and delayed CloudFront log enforcement.
