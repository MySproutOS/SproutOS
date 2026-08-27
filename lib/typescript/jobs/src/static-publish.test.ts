import {
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
  type CloudFrontKeyValueStoreClient,
} from "@aws-sdk/client-cloudfront-keyvaluestore"
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  type Route53Client,
} from "@aws-sdk/client-route-53"
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3"
import { createHash } from "node:crypto"
import { deflateRawSync } from "node:zlib"
import { describe, expect, it, vi } from "vitest"
import { extractStaticArchive, publishStaticSite, removeStaticSite } from "./static-publish"

function crc32(body: Buffer): number {
  let crc = 0xffff_ffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function zip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const [path, value] of Object.entries(files)) {
    const name = Buffer.from(path)
    const body = Buffer.from(value)
    const compressed = deflateRawSync(body)
    const crc = crc32(body)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x0403_4b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x0201_4b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + compressed.length
  }

  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, end])
}

describe("static archive extraction", () => {
  it("extracts a root document and assets", async () => {
    const assets = await extractStaticArchive(
      zip({ "index.html": "<h1>release</h1>", "assets/app.js": "console.log(1)" }),
    )
    expect(assets.map((asset) => asset.path)).toEqual(["index.html", "assets/app.js"])
  })

  it("requires a root index and rejects path traversal", async () => {
    await expect(extractStaticArchive(zip({ "assets/app.js": "x" }))).rejects.toThrow(/index.html/)
    await expect(
      extractStaticArchive(zip({ "index.html": "ok", "../secret": "no" })),
    ).rejects.toThrow(/unsafe path|invalid relative path/)
  })
})

describe("publishing a static site", () => {
  it("uploads immutable bytes before moving one edge pointer and DNS", async () => {
    const archive = zip({ "index.html": "<h1>release</h1>", "assets/app.js": "app()" })
    const calls: string[] = []
    const putObjects: PutObjectCommand[] = []
    const s3 = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command: unknown) => {
        if (command instanceof GetObjectCommand) {
          calls.push("get")
          return Promise.resolve({ Body: archive })
        }
        if (command instanceof PutObjectCommand) {
          calls.push(`put:${command.input.Key}`)
          putObjects.push(command)
          return Promise.resolve({})
        }
        return Promise.reject(new Error("unexpected S3 command"))
      }),
    } as unknown as S3Client
    const keyValueStore = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command: unknown) => {
        if (command instanceof DescribeKeyValueStoreCommand) {
          calls.push("describe-kvs")
          return Promise.resolve({ ETag: "v1" })
        }
        if (command instanceof PutKeyCommand) {
          calls.push(`activate:${command.input.Value}`)
          return Promise.resolve({})
        }
        return Promise.reject(new Error("unexpected KVS command"))
      }),
    } as unknown as CloudFrontKeyValueStoreClient
    const route53 = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command: unknown) => {
        expect(command).toBeInstanceOf(ChangeResourceRecordSetsCommand)
        calls.push("dns")
        return Promise.resolve({})
      }),
    } as unknown as Route53Client
    const digest = createHash("sha256").update(archive).digest("hex")

    await publishStaticSite(
      { s3, route53, keyValueStore },
      {
        bucket: "tenant-static",
        artifactKey: `static/project/${digest}.zip`,
        digest,
        projectId: "project",
        hostname: "app.example.test",
        tenantZoneId: "zone",
        distributionDomain: "distribution.cloudfront.net",
        keyValueStoreArn: "arn:kvs",
      },
    )

    expect(calls).toEqual([
      "get",
      `put:sites/project/${digest}/index.html`,
      `put:sites/project/${digest}/assets/app.js`,
      "describe-kvs",
      `activate:project/${digest}`,
      "dns",
    ])
    expect(putObjects[0]?.input.CacheControl).toBe("no-cache")
    expect(putObjects[0]?.input.ContentType).toBe("text/html")
    expect(putObjects[1]?.input.CacheControl).toContain("immutable")
    expect(putObjects[1]?.input.ContentType).toMatch(/javascript/)
  })

  it("does not upload or activate bytes whose digest is wrong", async () => {
    const archive = zip({ "index.html": "ok" })
    const s3 = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command: unknown) =>
        command instanceof GetObjectCommand
          ? Promise.resolve({ Body: archive })
          : Promise.reject(new Error("must not upload")),
      ),
    } as unknown as S3Client
    const keyValueStoreSend = vi.fn<(command: unknown) => Promise<unknown>>()
    const route53Send = vi.fn<(command: unknown) => Promise<unknown>>()
    const keyValueStore = { send: keyValueStoreSend } as unknown as CloudFrontKeyValueStoreClient
    const route53 = { send: route53Send } as unknown as Route53Client

    await expect(
      publishStaticSite(
        { s3, route53, keyValueStore },
        {
          bucket: "tenant-static",
          artifactKey: "static/project/wrong.zip",
          digest: "0".repeat(64),
          projectId: "project",
          hostname: "app.example.test",
          tenantZoneId: "zone",
          distributionDomain: "distribution.cloudfront.net",
          keyValueStoreArn: "arn:kvs",
        },
      ),
    ).rejects.toThrow(/digest mismatch/)
    expect(keyValueStoreSend).not.toHaveBeenCalled()
    expect(route53Send).not.toHaveBeenCalled()
  })

  it("bounds the compressed archive before retaining it in worker memory", async () => {
    const s3 = {
      send: vi.fn<() => Promise<unknown>>(() =>
        Promise.resolve({ Body: Buffer.alloc(16 * 1024 * 1024 + 1) }),
      ),
    } as unknown as S3Client
    await expect(
      publishStaticSite(
        {
          s3,
          route53: { send: vi.fn<() => Promise<unknown>>() } as unknown as Route53Client,
          keyValueStore: {
            send: vi.fn<() => Promise<unknown>>(),
          } as unknown as CloudFrontKeyValueStoreClient,
        },
        {
          bucket: "tenant-static",
          artifactKey: "static/project/archive.zip",
          digest: "0".repeat(64),
          projectId: "project",
          hostname: "app.example.test",
          tenantZoneId: "zone",
          distributionDomain: "distribution.cloudfront.net",
          keyValueStoreArn: "arn:kvs",
        },
      ),
    ).rejects.toThrow(/archive exceeds/)
  })

  it("stops before external writes after losing the queue lease", async () => {
    const sends = vi.fn<() => Promise<unknown>>()
    await expect(
      publishStaticSite(
        {
          s3: { send: sends } as unknown as S3Client,
          route53: { send: sends } as unknown as Route53Client,
          keyValueStore: { send: sends } as unknown as CloudFrontKeyValueStoreClient,
        },
        {
          bucket: "tenant-static",
          artifactKey: "static/project/archive.zip",
          digest: "0".repeat(64),
          projectId: "project",
          hostname: "app.example.test",
          tenantZoneId: "zone",
          distributionDomain: "distribution.cloudfront.net",
          keyValueStoreArn: "arn:kvs",
          heartbeat: () => Promise.resolve(false),
        },
      ),
    ).rejects.toThrow(/Lost ownership/)
    expect(sends).not.toHaveBeenCalled()
  })

  it("stops edge traffic before deleting DNS and retained project bytes", async () => {
    const calls: string[] = []
    const keyValueStore = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command) => {
        if (command instanceof DescribeKeyValueStoreCommand) return Promise.resolve({ ETag: "v2" })
        expect(command).toBeInstanceOf(DeleteKeyCommand)
        calls.push("edge")
        return Promise.resolve({})
      }),
    } as unknown as CloudFrontKeyValueStoreClient
    const route53 = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command) => {
        if (command instanceof ListResourceRecordSetsCommand) {
          const type = command.input.StartRecordType
          return Promise.resolve({
            ResourceRecordSets: [
              {
                Name: "app.example.test.",
                Type: type,
                AliasTarget: {
                  DNSName: "distribution.cloudfront.net",
                  HostedZoneId: "cloudfront-zone",
                  EvaluateTargetHealth: false,
                },
              },
            ],
          })
        }
        expect(command).toBeInstanceOf(ChangeResourceRecordSetsCommand)
        calls.push("dns")
        return Promise.resolve({})
      }),
    } as unknown as Route53Client
    let listing = 0
    const s3 = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command) => {
        if (command instanceof ListObjectsV2Command) {
          listing += 1
          calls.push(`list:${command.input.Prefix}`)
          return Promise.resolve({
            Contents: listing === 1 ? [{ Key: "sites/project/release/index.html" }] : [],
            IsTruncated: false,
          })
        }
        expect(command).toBeInstanceOf(DeleteObjectsCommand)
        calls.push("objects")
        return Promise.resolve({})
      }),
    } as unknown as S3Client

    await removeStaticSite(
      { s3, route53, keyValueStore },
      {
        bucket: "tenant-static",
        projectId: "project",
        hostnames: ["app.example.test"],
        tenantZoneId: "zone",
        keyValueStoreArn: "arn:kvs",
      },
    )

    expect(calls).toEqual([
      "edge",
      "dns",
      "dns",
      "list:sites/project/",
      "objects",
      "list:static/project/",
    ])
  })

  it("fails teardown when S3 reports a partial object deletion", async () => {
    const s3 = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [{ Key: "sites/project/index.html" }] })
        }
        return Promise.resolve({
          Errors: [{ Key: "sites/project/index.html", Code: "AccessDenied" }],
        })
      }),
    } as unknown as S3Client
    const keyValueStore = {
      send: vi.fn<(command: unknown) => Promise<unknown>>((command) =>
        command instanceof DescribeKeyValueStoreCommand
          ? Promise.resolve({ ETag: "v1" })
          : Promise.resolve({}),
      ),
    } as unknown as CloudFrontKeyValueStoreClient
    const route53 = {
      send: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ ResourceRecordSets: [] })),
    } as unknown as Route53Client

    await expect(
      removeStaticSite(
        { s3, route53, keyValueStore },
        {
          bucket: "tenant-static",
          projectId: "project",
          hostnames: ["app.example.test"],
          tenantZoneId: "zone",
          keyValueStoreArn: "arn:kvs",
        },
      ),
    ).rejects.toThrow(/AccessDenied/)
  })
})
