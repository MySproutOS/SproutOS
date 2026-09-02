import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda"
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { deflateRawSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
  functionName,
  LIVE_ALIAS,
  LOG_INGEST_PATH,
  logEndpointFor,
  pointAlias,
  publishFunction,
  telemetryEnv,
} from "./publish"

/**
 * Against LocalStack's Lambda, which really does create the function, publish versions and run the
 * code. The property under test is that a second deployment produces a second version and moves the
 * alias — and a fake client would only confirm we send the commands we think we send, not that
 * Lambda accepts the order we send them in.
 */
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"
const BUCKET = "sproutos-test-lambda"
/** LocalStack accepts any well-formed role ARN; it does not evaluate the policy. */
const ROLE = "arn:aws:iam::000000000000:role/lambda-exec"

const local = {
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
}

const reachable = await (async () => {
  try {
    const response = await fetch(`${ENDPOINT}/_localstack/health`)
    if (!response.ok) return false
    const health = (await response.json()) as { services?: Record<string, string> }
    const lambda = health.services?.lambda
    return lambda === "available" || lambda === "running"
  } catch {
    return false
  }
})()

const lambda = new LambdaClient(local)
const s3 = new S3Client({ ...local, forcePathStyle: true })

/**
 * A zip file, built by hand.
 *
 * Node has no zip writer and pulling a dependency in for four tests is worse than 30 lines of
 * struct-packing. Stored uncompressed would be simpler still, but Lambda rejects a zip whose only
 * entry is stored on some runtimes, so this deflates.
 */
function zip(files: { name: string; content: string }[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8")
    const content = Buffer.from(file.content, "utf8")
    const deflated = deflateRawSync(content)
    const crc = crc32(content)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x0403_4b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt32LE(0, 10)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(deflated.length, 18)
    localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x0201_4b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt32LE(0, 12)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(deflated.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    // `<< 16` on a value this size overflows into a negative int32 in JS; the shift has to be
    // coerced back to unsigned before it can be written as one.
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    chunks.push(localHeader, name, deflated)
    central.push(centralHeader, name)
    offset += localHeader.length + name.length + deflated.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...chunks, centralBuffer, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffff_ffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

/** A handler that returns the string it was built with, so a version is identifiable at runtime. */
function handlerFor(marker: string): Buffer {
  return zip([
    {
      name: "index.mjs",
      content: `export const handler = async () => ({ statusCode: 200, body: ${JSON.stringify(marker)} })\n`,
    },
  ])
}

/** The same observable handler on another runtime, so rollback proves configuration as well as code. */
function pythonHandlerFor(marker: string): Buffer {
  return zip([
    {
      name: "index.py",
      content:
        "def handler(event, context):\n" +
        `    return {"statusCode": 200, "body": ${JSON.stringify(marker)}}\n`,
    },
  ])
}

async function upload(key: string, body: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }))
}

const projectId = "01a03600-0000-7000-8000-00000000d1ce"

afterEach(() => vi.unstubAllEnvs())

describe("the telemetry endpoint", () => {
  it("uses the deployment's generated tenant hostname, not a global API host", () => {
    vi.stubEnv("LOG_TOKEN_SECRET", "test-log-token-secret")
    vi.stubEnv("SPROUTOS_LOG_ENDPOINT", "https://api.sproutos.me/_sproutos/logs")
    const endpoint = logEndpointFor("myapp-a1b2c3.sproutos.run")
    const environment = telemetryEnv({
      projectId,
      organizationId: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
      logEndpoint: endpoint,
      bucket: BUCKET,
      key: "unused.zip",
      handler: "index.handler",
      runtime: "nodejs22.x",
      memoryMb: 128,
      timeoutS: 10,
      roleArn: ROLE,
    })

    expect(environment.SPROUTOS_LOG_ENDPOINT).toBe(
      "https://myapp-a1b2c3.sproutos.run/_sproutos/logs",
    )
    expect(environment.SPROUTOS_LOG_ENDPOINT).not.toContain("api.sproutos.me")
    expect(environment.SPROUTOS_LOG_TOKEN).toBeDefined()
  })

  it("uses exactly the ingest path the Rust router serves", () => {
    const router = readFileSync(
      new URL("../../../../services/router/src/logs.rs", import.meta.url),
      "utf8",
    )
    const routerPath = /pub const INGEST_PATH: &str = "([^"]+)";/.exec(router)?.[1]

    expect(LOG_INGEST_PATH).toBe(routerPath)
  })
})

describe("web adapter runtime environment", () => {
  it("does not replace a provided runtime's own bootstrap with the managed-runtime wrapper", () => {
    vi.stubEnv("LOG_TOKEN_SECRET", "test-log-token-secret")
    const environment = telemetryEnv({
      projectId,
      organizationId: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
      logEndpoint: "https://example.sproutos.run/_sproutos/logs",
      bucket: BUCKET,
      key: "unused.zip",
      handler: "bootstrap",
      runtime: "provided.al2023",
      memoryMb: 128,
      timeoutS: 10,
      roleArn: ROLE,
      webAdapterLayerArn: "arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerArm64:29",
    })

    expect(environment.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined()
    expect(environment.AWS_LWA_PORT).toBe("8080")
    expect(environment.PORT).toBe("8080")
  })
})

if (reachable) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
  } catch {
    // Already there from an earlier run. LocalStack's Hobby tier does not persist, but a second
    // `pnpm test` inside one container session hits this.
  }
}

async function invokeLive(): Promise<string> {
  const response = await lambda.send(
    new InvokeCommand({ FunctionName: `${functionName(projectId)}:${LIVE_ALIAS}`, Payload: "{}" }),
  )
  const payload = Buffer.from(response.Payload ?? new Uint8Array()).toString("utf8")
  return (JSON.parse(payload) as { body: string }).body
}

async function liveConfiguration(): Promise<{
  runtime: string | undefined
  handler: string | undefined
}> {
  const alias = await lambda.send(
    new GetAliasCommand({ FunctionName: functionName(projectId), Name: LIVE_ALIAS }),
  )
  const response = await lambda.send(
    new GetFunctionConfigurationCommand({
      FunctionName: functionName(projectId),
      // LocalStack does not resolve an alias on this read even though AWS does. Resolve the alias
      // explicitly, then inspect the exact immutable version it names; that is also the property
      // the test means to assert.
      Qualifier: alias.FunctionVersion,
    }),
  )
  return { runtime: response.Runtime, handler: response.Handler }
}

afterAll(() => {
  lambda.destroy()
  s3.destroy()
})

/*
  Carried between the tests rather than assumed to be "1" and "2".

  Versions are per-function and monotonic, and LocalStack keeps them for the life of the container —
  so a second `pnpm test` without a restart starts at 3, and a suite that hardcodes "1" asserts
  against an artifact an earlier run uploaded. It passes on a fresh container and lies afterwards.
*/
let firstVersion = ""
let secondVersion = ""

describe.runIf(reachable)("publishing a build to Lambda", () => {
  it("creates the function, publishes a version, and points live at it", async () => {
    await upload("v1.zip", handlerFor("first"))

    const result = await publishFunction(lambda, {
      projectId,
      organizationId: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
      logEndpoint: logEndpointFor("myapp-a1b2c3.sproutos.run"),
      bucket: BUCKET,
      key: "v1.zip",
      handler: "index.handler",
      runtime: "nodejs22.x" as const,
      memoryMb: 128,
      timeoutS: 10,
      roleArn: ROLE,
    })

    expect(result.functionName).toBe(functionName(projectId))
    // Never `$LATEST`: the alias has to point at an immutable version or a rollback has nothing to
    // roll back to.
    expect(result.version).not.toBe("$LATEST")
    expect(await invokeLive()).toBe("first")
    expect(await liveConfiguration()).toEqual({ runtime: "nodejs22.x", handler: "index.handler" })
    firstVersion = result.version
  }, 120_000)

  it("moves the alias to a deployment on another runtime, leaving the first version invokable", async () => {
    const alias = await lambda.send(
      new GetAliasCommand({ FunctionName: functionName(projectId), Name: LIVE_ALIAS }),
    )
    expect(alias.FunctionVersion).toBe(firstVersion)

    await upload("v2.zip", pythonHandlerFor("second"))
    const result = await publishFunction(lambda, {
      projectId,
      organizationId: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
      logEndpoint: logEndpointFor("myapp-a1b2c3.sproutos.run"),
      bucket: BUCKET,
      key: "v2.zip",
      handler: "index.handler",
      runtime: "python3.13" as const,
      memoryMb: 128,
      timeoutS: 10,
      roleArn: ROLE,
    })

    expect(result.version).not.toBe(firstVersion)
    expect(await invokeLive()).toBe("second")
    expect(await liveConfiguration()).toEqual({ runtime: "python3.13", handler: "index.handler" })
    secondVersion = result.version
  }, 120_000)

  it("rolls back code and runtime with one alias move and no rebuild", async () => {
    // The whole reason releases are versions behind an alias. Nothing is uploaded here and no
    // configuration changes — the previous version was never deleted, so pointing at it is enough.
    const name = functionName(projectId)
    await pointAlias(lambda, name, firstVersion)

    expect(await invokeLive()).toBe("first")
    expect(await liveConfiguration()).toEqual({ runtime: "nodejs22.x", handler: "index.handler" })

    await pointAlias(lambda, name, secondVersion)
    expect(await invokeLive()).toBe("second")
    expect(await liveConfiguration()).toEqual({ runtime: "python3.13", handler: "index.handler" })
  }, 120_000)
})
