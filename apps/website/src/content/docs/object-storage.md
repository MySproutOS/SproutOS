---
slug: object-storage
title: Use object storage
summary: Connect ordinary S3 SDKs to mutable application storage through the SproutOS storage proxy.
audience: developer
category: Building on SproutOS
order: 2
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
s3.put_object(Bucket=bucket, Key="photos/cat.jpg", Body=image_bytes)
photo = s3.get_object(Bucket=bucket, Key="photos/cat.jpg")["Body"].read()
```

Do not set an AWS session token. Always pass the displayed endpoint and use path-style addressing; the bucket must remain in the URL path rather than the hostname.

## TypeScript with the AWS SDK

```typescript
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"

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
await s3.send(new PutObjectCommand({ Bucket, Key: "exports/report.json", Body: report }))
const stored = await s3.send(new GetObjectCommand({ Bucket, Key: "exports/report.json" }))
```

## Supported operations and limits

Object reads, writes, heads, deletes, listings, and ordinary SDK multipart uploads are supported. Multipart upload is the right choice when one upload request would exceed the service's per-request body limit.

Presigned URLs, virtual-host bucket addressing, SigV4 streaming-chunked uploads, server-side `CopyObject`, and conditional or range reads are not supported. Download the source and upload a new object instead of using `CopyObject`; download a whole object rather than depending on a byte range. A presigned URL would let a request outlive the live credential check, virtual-host addressing would move the tenant decision into customer-controlled DNS, and streaming-chunked SigV4 requires verification of every signed frame.

The proxy spools an upload to bounded disk while verifying its payload signature, then streams it to S3. Downloads stream with backpressure rather than being loaded into application memory.

## Metering and credit cutoff

Object storage meters write and list requests, read requests, bytes delivered outside AWS, and stored byte-time. Deletes are not charged. SproutOS adds no platform markup to these dimensions.

The billing system protects enough spendable credit for 48 hours of the latest measured stored bytes. When the remaining credit reaches that reserve, new storage requests are refused while the already-funded retention window keeps the data. Add credit before retrying a refused request.
