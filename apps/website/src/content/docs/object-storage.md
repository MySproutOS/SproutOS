---
slug: object-storage
title: Use object storage
summary: Connect ordinary S3 SDKs to mutable application storage through the SproutOS storage proxy.
audience: developer
category: Backend services
order: 14
---

## Mutable storage and static deployments

Object storage is mutable application data: uploads, photos, attachments, exports, and other files your application reads and changes while it runs. An ordinary S3 SDK talks to the SproutOS storage endpoint, which authenticates the project, confines every request to its bucket, and forwards it to S3.

A static deployment is different. SproutOS expands an immutable build artifact and serves it through CloudFront. Customers do not receive credentials to edit that release in place; publish another deployment to change it.

## Get the connection values

Open **Databases**, find the object-storage service, and select **View credentials**. The panel provides:

- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET_NAME`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE=true`

The project receives the same values as encrypted environment variables when the service is attached. Object storage is the exception to the usual one-time credential rule: **View credentials** can reconstruct its derived secret later. Keep it private. Rotating or deleting the credential revokes the old access at the SproutOS proxy; it is not an AWS credential and cannot be used against AWS directly.

## Python with boto3

```python
import os

import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["S3_ENDPOINT"],
    region_name=os.environ["S3_REGION"],
    aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
    config=Config(s3={"addressing_style": "path"}),
)

bucket = os.environ["S3_BUCKET_NAME"]
s3.put_object(
    Bucket=bucket,
    Key="photos/cat.jpg",
    Body=image_bytes,
    ContentType="image/jpeg",
    CacheControl="public, max-age=3600",
)
photo = s3.get_object(Bucket=bucket, Key="photos/cat.jpg")["Body"].read()

# Give a browser one hour to download this private object directly.
download_url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": bucket, "Key": "photos/cat.jpg"},
    ExpiresIn=3600,
)
```

Do not set an AWS session token. Always pass the displayed endpoint and use path-style addressing; the bucket must remain in the URL path rather than the hostname.

## TypeScript with the AWS SDK

```typescript
import {
  GetObjectCommand,
  PutObjectAclCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
})

const Bucket = process.env.S3_BUCKET_NAME!
await s3.send(
  new PutObjectCommand({
    Bucket,
    Key: "exports/report.json",
    Body: report,
    ContentType: "application/json",
    CacheControl: "public, max-age=3600",
  }),
)
const stored = await s3.send(new GetObjectCommand({ Bucket, Key: "exports/report.json" }))

// Let a browser upload directly without receiving the storage credential.
const uploadUrl = await getSignedUrl(
  s3,
  new PutObjectCommand({ Bucket, Key: "uploads/photo.jpg", ContentType: "image/jpeg" }),
  { expiresIn: 15 * 60 },
)
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "image/jpeg" },
  body: imageFile,
})

// Change one object's anonymous-read override later.
await s3.send(new PutObjectAclCommand({ Bucket, Key: "exports/report.json", ACL: "public-read" }))
```

## Presigned URLs

Presigned URLs work for the supported read, write, head, delete, list, ACL, and multipart operations. They are suitable for direct browser uploads and downloads because the browser receives a time-limited URL, not the storage secret. Use the exact endpoint, region, path-style setting, method, headers, and query parameters that were signed.

An expiry may be from 1 second through the SigV4 maximum of 7 days. The proxy still checks the credential, service status, bucket boundary, and available credit when the request arrives. Rotating the credential, deleting it, or suspending the service therefore revokes an otherwise unexpired URL.

Browser preflights and presigned responses allow cross-origin access. If a header such as `Content-Type` was part of the signature, send the same value from the browser.

## Public objects

Object storage is private by default. In **Databases**, open the object-storage service's actions and enable **Public reads** to make plain object URLs readable unless an object has a private override. The same setting is available from `PATCH /v1/{orgSlug}/services/{serviceId}/object-storage-access` with `{ "publicRead": true }`.

Set the S3 canned ACL `public-read` or `private` on an upload, or use `PutObjectAcl`, to override that default for one object. `GetObjectAcl` reports the effective setting. Other canned ACLs and custom grant documents are not supported. Changing the service default affects objects without an override; it does not erase per-object overrides.

A public URL has this form:

```text
${S3_ENDPOINT}/${S3_BUCKET_NAME}/path/to/object
```

Only anonymous `GET` and `HEAD` requests for object keys are public. Listings, writes, deletes, and ACL changes still require SigV4. The backing bucket remains private: the public decision is made by the SproutOS proxy, so a public object does not expose the physical bucket or another tenant's prefix.

The proxy preserves `Content-Type`, `Cache-Control`, `Content-Disposition`, and `Content-Encoding` metadata on uploads and returns the backing store's response headers. Set `Cache-Control` deliberately: a browser or intermediary can keep a cached public response after access is made private until its cache lifetime expires. Use a private object plus a short-lived presigned URL when immediate revocation matters.

## Supported operations and limits

Object reads, writes, heads, deletes, listings, canned object ACL reads and changes, and ordinary SDK multipart uploads are supported. Multipart upload is the right choice when one upload request would exceed the service's 64 MiB per-request body limit; keep each part at or below that limit.

Virtual-host bucket addressing, SigV4 streaming-chunked uploads, server-side `CopyObject`, object tagging, custom ACL grants, and conditional or range reads are not supported. Object tags are reserved for SproutOS access controls. Download the source and upload a new object instead of using `CopyObject`; download a whole object rather than depending on a byte range.

The proxy spools an upload to bounded disk while verifying its payload signature, then streams it to S3. A presigned browser upload uses SigV4's `UNSIGNED-PAYLOAD`, but its method, path, query, expiry, and signed headers are still verified before the body is forwarded. Downloads stream with backpressure rather than being loaded into application memory.

## Metering and credit cutoff

Object storage meters write and list requests, read requests, bytes delivered outside AWS, and stored byte-time. Deletes are not charged. SproutOS adds no platform markup to these dimensions.

The billing system protects enough spendable credit for 48 hours of the latest measured stored bytes. When the remaining credit reaches that reserve, new storage requests are refused while the already-funded retention window keeps the data. Add credit before retrying a refused request.
