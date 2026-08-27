import { resolve } from "node:path"

import { Daytona } from "@daytona/sdk"
import { obsoleteManagedSnapshots } from "./snapshot-lifecycle"

try {
  process.loadEnvFile(resolve(import.meta.dirname, "../../../..", ".env"))
} catch {
  // CI and production pass configuration directly. A local run may use the gitignored `.env`.
}

const apiKey = process.env.DAYTONA_API_KEY
const organizationId = process.env.DAYTONA_ORGANIZATION_ID
const configuredSnapshot = process.env.SANDBOX_DAYTONA_SNAPSHOT
const deleteConfirmed = process.argv.includes("--delete")
if (!apiKey) throw new Error("DAYTONA_API_KEY is not set")
if (!organizationId) throw new Error("DAYTONA_ORGANIZATION_ID is not set")
if (!configuredSnapshot) {
  throw new Error(
    "SANDBOX_DAYTONA_SNAPSHOT is not set; refusing to guess which paid base snapshot is live",
  )
}

const client = new Daytona({ apiKey, organizationId })

try {
  const listed = await client.snapshot.list({ limit: 100 })
  const liveSandboxSnapshots = new Set<string>()
  for await (const sandbox of client.list()) {
    if (sandbox.snapshot) liveSandboxSnapshots.add(sandbox.snapshot)
  }
  let obsolete = obsoleteManagedSnapshots(listed.items, configuredSnapshot, liveSandboxSnapshots)
  if (obsolete.length > 0) {
    try {
      for (const pool of await client.warmPool.list()) liveSandboxSnapshots.add(pool.snapshot)
      obsolete = obsoleteManagedSnapshots(listed.items, configuredSnapshot, liveSandboxSnapshots)
    } catch (cause) {
      if (deleteConfirmed) {
        throw new Error(
          "refusing snapshot deletion because Daytona did not expose warm-pool references",
          { cause },
        )
      }
      process.stderr.write(
        "warning: Daytona did not expose warm-pool references; dry run cannot prove they are absent\n",
      )
    }
  }
  for (const snapshot of obsolete) {
    if (deleteConfirmed) {
      await client.snapshot.delete(snapshot)
      process.stdout.write(`deleted obsolete Daytona snapshot ${snapshot.name}\n`)
    } else {
      process.stdout.write(`would delete obsolete Daytona snapshot ${snapshot.name}\n`)
    }
  }
  if (obsolete.length === 0) process.stdout.write("no obsolete SproutOS snapshots\n")
  if (obsolete.length > 0 && !deleteConfirmed) {
    process.stdout.write("dry run only; pass --delete to delete the snapshots listed above\n")
  }
} finally {
  await client[Symbol.asyncDispose]()
}
