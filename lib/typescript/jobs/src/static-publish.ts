import {
  CloudFrontKeyValueStoreClient,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore"
// The package registers the pure-JavaScript SigV4a signer used by the global KVS client.
// oxlint-disable-next-line import/no-unassigned-import
import "@aws-sdk/signature-v4a"
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from "@aws-sdk/client-route-53"
import {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { createHash } from "node:crypto"
import { posix } from "node:path"
import { lookup as contentTypeFor } from "mime-types"
import yauzl, { type Entry } from "yauzl"

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
const MAX_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 5_000
const CLOUDFRONT_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2"

export type StaticPublisherClients = {
  s3: S3Client
  route53: Route53Client
  keyValueStore: CloudFrontKeyValueStoreClient
}

export type StaticPlatform = StaticPublisherClients & {
  bucket: string
  tenantZoneId: string
  distributionDomain: string
  keyValueStoreArn: string
}

export function staticPlatformFromEnv(): StaticPlatform {
  const bucket = process.env.TENANT_STATIC_BUCKET
  const tenantZoneId = process.env.TENANT_ZONE_ID
  const distributionDomain = process.env.TENANT_STATIC_DISTRIBUTION_DOMAIN
  const keyValueStoreArn = process.env.TENANT_STATIC_KEY_VALUE_STORE_ARN
  if (
    bucket === undefined ||
    tenantZoneId === undefined ||
    distributionDomain === undefined ||
    keyValueStoreArn === undefined
  ) {
    throw new Error(
      "Static serving requires TENANT_STATIC_BUCKET, TENANT_ZONE_ID, " +
        "TENANT_STATIC_DISTRIBUTION_DOMAIN, and TENANT_STATIC_KEY_VALUE_STORE_ARN",
    )
  }
  const aws = {
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: process.env.AWS_ENDPOINT_URL }),
  }
  return {
    bucket,
    tenantZoneId,
    distributionDomain,
    keyValueStoreArn,
    s3: new S3Client({ ...aws, forcePathStyle: process.env.AWS_ENDPOINT_URL !== undefined }),
    route53: new Route53Client(aws),
    keyValueStore: new CloudFrontKeyValueStoreClient({ region: "us-east-1" }),
  }
}

export type StaticPublishInput = {
  bucket: string
  artifactKey: string
  digest: string
  projectId: string
  hostname: string
  tenantZoneId: string
  distributionDomain: string
  keyValueStoreArn: string
  heartbeat?: () => Promise<boolean>
  signal?: AbortSignal
}

type Asset = { path: string; body: Buffer }

function errorFrom(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === "string") return new Error(value)
  return new Error("Unknown static archive error")
}

function bodyBuffer(chunks: Buffer[], bytes: number): Buffer {
  if (bytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`Static archive exceeds the ${MAX_ARCHIVE_BYTES}-byte platform limit`)
  }
  return Buffer.concat(chunks, bytes)
}

async function readArchive(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) throw new Error("Static archive has no body")
  if (body instanceof Uint8Array) return bodyBuffer([Buffer.from(body)], body.byteLength)

  const stream = body as AsyncIterable<Uint8Array>
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.byteLength
    chunks.push(Buffer.from(chunk))
    if (bytes > MAX_ARCHIVE_BYTES) return bodyBuffer(chunks, bytes)
  }
  return bodyBuffer(chunks, bytes)
}

function safeEntryPath(entry: Entry): string {
  const name = entry.fileName
  if (name.includes("\\") || name.startsWith("/") || name.includes("\0")) {
    throw new Error(`Static archive contains an unsafe path: ${JSON.stringify(name)}`)
  }
  const normalized = posix.normalize(name)
  if (normalized === ".." || normalized.startsWith("../") || normalized !== name) {
    throw new Error(`Static archive contains an unsafe path: ${JSON.stringify(name)}`)
  }

  const mode = (entry.externalFileAttributes >>> 16) & 0o170000
  if (mode === 0o120000) throw new Error(`Static archive contains a symbolic link: ${name}`)
  return normalized
}

function readEntry(zip: yauzl.ZipFile, entry: Entry): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    return Promise.reject(new Error(`Static archive entry exceeds the per-file platform limit`))
  }
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error)
        return
      }
      if (stream === undefined) {
        reject(new Error(`No stream for ${entry.fileName}`))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > entry.uncompressedSize) {
          stream.destroy(new Error(`Static archive entry expanded beyond its declared size`))
          return
        }
        chunks.push(chunk)
      })
      stream.once("error", reject)
      stream.once("end", () => {
        resolve(Buffer.concat(chunks, bytes))
      })
    })
  })
}

function visitStaticArchive(
  archive: Buffer,
  visit: (asset: Asset) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      archive,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (openError, zip) => {
        if (openError !== null || zip === undefined) {
          reject(errorFrom(openError))
          return
        }
        let entries = 0
        let expandedBytes = 0
        let hasRootIndex = false
        let settled = false

        const fail = (error: unknown) => {
          if (settled) return
          settled = true
          zip.close()
          reject(errorFrom(error))
        }

        zip.once("error", fail)
        zip.once("end", () => {
          if (settled) return
          settled = true
          if (!hasRootIndex) {
            reject(new Error("A static deployment must contain index.html at the archive root"))
            return
          }
          resolve()
        })
        zip.on("entry", (entry: Entry) => {
          void (async () => {
            entries += 1
            if (entries > MAX_ENTRIES) throw new Error("Static archive contains too many entries")
            const path = safeEntryPath(entry)
            if (path.endsWith("/")) {
              zip.readEntry()
              return
            }
            expandedBytes += entry.uncompressedSize
            if (expandedBytes > MAX_EXPANDED_BYTES) {
              throw new Error("Static archive expands beyond the platform limit")
            }
            if (path === "index.html") hasRootIndex = true
            await visit({ path, body: await readEntry(zip, entry) })
            zip.readEntry()
          })().catch(fail)
        })
        zip.readEntry()
      },
    )
  })
}

export async function extractStaticArchive(archive: Buffer): Promise<Asset[]> {
  const assets: Asset[] = []
  await visitStaticArchive(archive, (asset) => {
    assets.push(asset)
    return Promise.resolve()
  })
  return assets
}

function cacheControl(path: string): string {
  return path === "index.html" ? "no-cache" : "public, max-age=31536000, immutable"
}

function isPreconditionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode
  return error.name === "PreconditionFailedException" || status === 412
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode
  return error.name === "ResourceNotFoundException" || status === 404
}

async function activatePrefix(
  client: CloudFrontKeyValueStoreClient,
  arn: string,
  hostname: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // Sequential by definition: a failed conditional write needs the ETag from the next read.
    // eslint-disable-next-line no-await-in-loop
    const described = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: arn }), {
      abortSignal: signal,
    })
    if (described.ETag === undefined) throw new Error("CloudFront key-value store returned no ETag")
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.send(
        new PutKeyCommand({
          KvsARN: arn,
          IfMatch: described.ETag,
          Key: hostname,
          Value: prefix,
        }),
        { abortSignal: signal },
      )
      return
    } catch (error) {
      if (!isPreconditionFailure(error) || attempt === 5) throw error
    }
  }
}

async function deactivatePrefix(
  client: CloudFrontKeyValueStoreClient,
  arn: string,
  hostname: string,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // Sequential by definition: a failed conditional write needs the ETag from the next read.
    // eslint-disable-next-line no-await-in-loop
    const described = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: arn }), {
      abortSignal: signal,
    })
    if (described.ETag === undefined) throw new Error("CloudFront key-value store returned no ETag")
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.send(
        new DeleteKeyCommand({ KvsARN: arn, IfMatch: described.ETag, Key: hostname }),
        { abortSignal: signal },
      )
      return
    } catch (error) {
      if (isNotFound(error)) return
      if (!isPreconditionFailure(error) || attempt === 5) throw error
    }
  }
}

async function publishDns(
  client: Route53Client,
  zoneId: string,
  hostname: string,
  distributionDomain: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Comment: "SproutOS static deployment",
        Changes: ["A", "AAAA"].map((type) => ({
          Action: "UPSERT" as const,
          ResourceRecordSet: {
            Name: hostname,
            Type: type as "A" | "AAAA",
            AliasTarget: {
              DNSName: distributionDomain,
              HostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
              EvaluateTargetHealth: false,
            },
          },
        })),
      },
    }),
    { abortSignal: signal },
  )
}

async function withdrawDns(
  client: Route53Client,
  zoneId: string,
  hostname: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const type of ["A", "AAAA"] as const) {
    // Look before deleting so a retried teardown treats an already-absent record as success.
    // eslint-disable-next-line no-await-in-loop
    const listed = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        StartRecordName: hostname,
        StartRecordType: type,
        MaxItems: 1,
      }),
      { abortSignal: signal },
    )
    const record = listed.ResourceRecordSets?.[0]
    if (record === undefined) continue
    if (
      record.Name === undefined ||
      record.Type !== type ||
      record.Name.replace(/\.$/, "") !== hostname.replace(/\.$/, "")
    ) {
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    await client.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ChangeBatch: { Changes: [{ Action: "DELETE", ResourceRecordSet: record }] },
      }),
      { abortSignal: signal },
    )
  }
}

export async function pointStaticSite(
  clients: StaticPublisherClients,
  input: {
    hostname: string
    prefix: string
    tenantZoneId: string
    distributionDomain: string
    keyValueStoreArn: string
    signal?: AbortSignal
  },
): Promise<void> {
  await activatePrefix(
    clients.keyValueStore,
    input.keyValueStoreArn,
    input.hostname,
    input.prefix,
    input.signal,
  )
  await publishDns(
    clients.route53,
    input.tenantZoneId,
    input.hostname,
    input.distributionDomain,
    input.signal,
  )
}

export async function deactivateStaticHost(
  clients: StaticPublisherClients,
  input: {
    hostname: string
    tenantZoneId: string
    keyValueStoreArn: string
    signal?: AbortSignal
  },
): Promise<void> {
  await deactivatePrefix(
    clients.keyValueStore,
    input.keyValueStoreArn,
    input.hostname,
    input.signal,
  )
  await withdrawDns(clients.route53, input.tenantZoneId, input.hostname, input.signal)
}

async function deletePrefix(client: S3Client, bucket: string, prefix: string): Promise<void> {
  let continuationToken: string | undefined
  do {
    // A deletion page must finish before the token for the next page exists.
    // eslint-disable-next-line no-await-in-loop
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    const objects = (listed.Contents ?? []).flatMap(({ Key }) =>
      Key === undefined ? [] : [{ Key }],
    )
    if (objects.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const deleted = await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
      )
      if ((deleted.Errors?.length ?? 0) > 0) {
        const failures = deleted
          .Errors!.map(({ Key, Code }) => `${Key ?? "unknown key"}: ${Code ?? "unknown error"}`)
          .join(", ")
        throw new Error(`S3 failed to delete objects under ${prefix}: ${failures}`)
      }
    }
    continuationToken = listed.IsTruncated === true ? listed.NextContinuationToken : undefined
    if (listed.IsTruncated === true && continuationToken === undefined) {
      throw new Error(`S3 truncated the listing for ${prefix} without a continuation token`)
    }
  } while (continuationToken !== undefined)
}

/**
 * Publish immutable bytes first, then atomically move the hostname's edge pointer, then DNS.
 *
 * The digest is part of every object key and the CloudFront KVS value. A failed upload therefore
 * cannot corrupt the live release, and rollback is the same one-key pointer move as a Lambda alias.
 */
export async function publishStaticSite(
  clients: StaticPublisherClients,
  input: StaticPublishInput,
): Promise<void> {
  const ownLease = async () => {
    input.signal?.throwIfAborted()
    if (input.heartbeat !== undefined && !(await input.heartbeat())) {
      throw new Error("Lost ownership of the static publication job")
    }
  }
  await ownLease()
  const object = await clients.s3.send(
    new GetObjectCommand({ Bucket: input.bucket, Key: input.artifactKey }),
    { abortSignal: input.signal },
  )
  const archive = await readArchive(object.Body)
  const actualDigest = createHash("sha256").update(archive).digest("hex")
  if (actualDigest !== input.digest) {
    throw new Error(`Static archive digest mismatch: expected ${input.digest}, got ${actualDigest}`)
  }

  const prefix = `${input.projectId}/${input.digest}`
  await visitStaticArchive(archive, async (asset) => {
    // yauzl advances only after this PUT: at most the compressed archive and one bounded entry are
    // resident, rather than retaining the entire expanded site in the worker's shared ECS task.
    await ownLease()
    await clients.s3.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: `sites/${prefix}/${asset.path}`,
        Body: asset.body,
        ContentType: contentTypeFor(asset.path) || "application/octet-stream",
        CacheControl: cacheControl(asset.path),
      }),
      { abortSignal: input.signal },
    )
  })

  await ownLease()
  await pointStaticSite(clients, {
    hostname: input.hostname,
    prefix,
    tenantZoneId: input.tenantZoneId,
    distributionDomain: input.distributionDomain,
    keyValueStoreArn: input.keyValueStoreArn,
    signal: input.signal,
  })
  await ownLease()
}

export type StaticRemoveInput = {
  bucket: string
  projectId: string
  hostnames: string[]
  tenantZoneId: string
  keyValueStoreArn: string
}

export async function removeStaticDeployment(
  clients: StaticPublisherClients,
  input: StaticRemoveInput & { digest: string; artifactKey: string },
): Promise<void> {
  for (const hostname of new Set(input.hostnames)) {
    await deactivateStaticHost(clients, {
      hostname,
      tenantZoneId: input.tenantZoneId,
      keyValueStoreArn: input.keyValueStoreArn,
    })
  }
  await deletePrefix(clients.s3, input.bucket, `sites/${input.projectId}/${input.digest}/`)
  await clients.s3.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.artifactKey }))
}

/** Remove immutable bytes for a retired preview without touching its shared PR hostname. */
export async function removeStaticDeploymentBytes(
  client: S3Client,
  input: { bucket: string; projectId: string; digest: string; artifactKey: string },
): Promise<void> {
  await deletePrefix(client, input.bucket, `sites/${input.projectId}/${input.digest}/`)
  await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.artifactKey }))
}

/** Stop traffic first, remove exact DNS second, and delete the project's retained bytes last. */
export async function removeStaticSite(
  clients: StaticPublisherClients,
  input: StaticRemoveInput,
): Promise<void> {
  for (const hostname of new Set(input.hostnames)) {
    // Teardown is intentionally ordered and bounded by the number of deployment hostnames.
    // eslint-disable-next-line no-await-in-loop
    await deactivateStaticHost(clients, {
      hostname,
      tenantZoneId: input.tenantZoneId,
      keyValueStoreArn: input.keyValueStoreArn,
    })
  }
  await deletePrefix(clients.s3, input.bucket, `sites/${input.projectId}/`)
  await deletePrefix(clients.s3, input.bucket, `static/${input.projectId}/`)
}
