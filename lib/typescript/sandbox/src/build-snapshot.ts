import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { Daytona, Image } from "@daytona/sdk"
import { SNAPSHOT_RESOURCES } from "./daytona"

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repository = resolve(packageDir, "../../..")
const dockerfile = resolve(repository, "docker/sandbox.Dockerfile")

try {
  process.loadEnvFile(resolve(repository, ".env"))
} catch {
  // CI and production pass configuration directly. A local build may use the gitignored `.env`.
}

const apiKey = process.env.DAYTONA_API_KEY
const organizationId = process.env.DAYTONA_ORGANIZATION_ID
if (!apiKey) throw new Error("DAYTONA_API_KEY is not set")
if (!organizationId) throw new Error("DAYTONA_ORGANIZATION_ID is not set")

const source = await readFile(dockerfile)
const revision = createHash("sha256").update(source).digest("hex").slice(0, 12)
const name = `sproutos-agent-${revision}`
const client = new Daytona({ apiKey, organizationId })

try {
  const existing = await client.snapshot.list({ limit: 100 })
  const found = existing.items.find((snapshot) => snapshot.name === name)
  if (found !== undefined) {
    if (found.state === "active") {
      console.log(JSON.stringify({ id: found.id, name: found.name, state: found.state }))
    } else if (found.state === "inactive") {
      const active = await client.snapshot.activate(found)
      console.log(JSON.stringify({ id: active.id, name: active.name, state: active.state }))
    } else {
      throw new Error(
        `snapshot ${found.name} already exists in state ${found.state}; refusing to report it usable`,
      )
    }
  } else {
    const snapshot = await client.snapshot.create(
      {
        name,
        image: Image.fromDockerfile(dockerfile),
        resources: {
          cpu: SNAPSHOT_RESOURCES.cpu,
          memory: SNAPSHOT_RESOURCES.memoryGib,
          disk: SNAPSHOT_RESOURCES.diskGib,
        },
      },
      {
        onLogs: (chunk) => process.stderr.write(chunk),
        timeout: 900,
      },
    )

    if (snapshot.state === "error" || snapshot.state === "build_failed") {
      throw new Error(`snapshot ${snapshot.name} finished in state ${snapshot.state}`)
    }
    const active = snapshot.state === "active" ? snapshot : await client.snapshot.activate(snapshot)
    console.log(JSON.stringify({ id: active.id, name: active.name, state: active.state }))
  }
} finally {
  await client[Symbol.asyncDispose]()
}
