#!/usr/bin/env -S pnpm exec tsx

/**
 * Disposable-engine Valkey ACL cardinality harness.
 *
 * This creates up to 100,000 ACL users carrying the production command policy. It refuses to run
 * without both an explicit URL and an acknowledgement that the target may be disrupted.
 */
import { Redis } from "ioredis"
import {
  valkeyAclSetUserArgs,
  type ValkeyAclIdentity,
} from "../lib/typescript/services/src/valkey-acl-policy"

async function main(): Promise<void> {
  const url = value("--url")
  if (url === undefined || !process.argv.includes("--confirm-disposable")) {
    throw new Error(
      "usage: measure-valkey-acl-cardinality.ts --url redis://... --confirm-disposable [--tiers 1000,10000,100000]",
    )
  }
  const tiers = (value("--tiers") ?? "1000,10000,100000").split(",").map(Number)
  if (
    tiers.length === 0 ||
    tiers.some((tier) => !Number.isSafeInteger(tier) || tier < 1) ||
    tiers.some((tier, index) => index > 0 && tier <= tiers[index - 1])
  ) {
    throw new Error("--tiers must be an increasing comma-separated list of positive integers")
  }

  const root = "valkey-acl-cardinality-harness-root"
  const prefix = `sproutos_acl_benchmark_${process.pid}_`
  const admin = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 })
  const created: { username: string; password: string }[] = []
  const results: unknown[] = []

  try {
    await admin.connect()
    for (const tier of tiers) {
      const createStarted = performance.now()
      while (created.length < tier) {
        const pipeline = admin.pipeline()
        const end = Math.min(tier, created.length + 250)
        for (let index = created.length; index < end; index += 1) {
          const identity = benchmarkIdentity(index)
          const args = valkeyAclSetUserArgs(identity, root)
          const username = `${prefix}${index}`
          const password = args.find((arg) => arg.startsWith(">"))?.slice(1)
          if (password === undefined) throw new Error("generated ACL policy lacks a password")
          pipeline.call("ACL", "SETUSER", username, ...args.slice(1))
          created.push({ username, password })
        }
        // eslint-disable-next-line no-await-in-loop
        const replies = await pipeline.exec()
        if (replies?.some(([error]) => error !== null))
          throw new Error("ACL SETUSER pipeline failed")
      }
      const createMs = performance.now() - createStarted

      const listStarted = performance.now()
      // eslint-disable-next-line no-await-in-loop
      const list = (await admin.call("ACL", "LIST")) as string[]
      const aclListMs = performance.now() - listStarted
      // eslint-disable-next-line no-await-in-loop
      const info = await admin.info("memory")
      const auth = []
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const credential = created[created.length - 1]
        const client = new Redis(url, {
          username: credential.username,
          password: credential.password,
          lazyConnect: true,
          enableReadyCheck: false,
          maxRetriesPerRequest: 0,
        })
        const started = performance.now()
        // eslint-disable-next-line no-await-in-loop
        await client.connect()
        auth.push(performance.now() - started)
        client.disconnect()
      }
      auth.sort((left, right) => left - right)
      results.push({
        users: tier,
        createMs,
        aclListMs,
        aclListBytes: Buffer.byteLength(list.join("\n")),
        usedMemoryBytes: infoNumber(info, "used_memory"),
        usedMemoryRssBytes: infoNumber(info, "used_memory_rss"),
        authP50Ms: percentile(auth, 0.5),
        authP95Ms: percentile(auth, 0.95),
      })
      process.stderr.write(`measured ${tier} ACL users\n`)
    }
    process.stdout.write(
      `${JSON.stringify({ measuredAt: new Date().toISOString(), url, results }, null, 2)}\n`,
    )
  } finally {
    for (let start = 0; start < created.length; start += 250) {
      const pipeline = admin.pipeline()
      for (const { username } of created.slice(start, start + 250)) {
        pipeline.call("ACL", "DELUSER", username)
      }
      // eslint-disable-next-line no-await-in-loop
      await pipeline.exec()
    }
    admin.disconnect()
  }
}

void main()

function benchmarkIdentity(index: number): ValkeyAclIdentity {
  const resource = (BigInt(index) + 1n).toString(16).padStart(32, "0")
  return {
    id: uuid(resource),
    organizationId: "00000000-0000-0000-0000-000000000001",
  }
}

function uuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index < 0 ? undefined : process.argv[index + 1]
}

function infoNumber(info: string, key: string): number {
  const match = new RegExp(`^${key}:(\\d+)$`, "mu").exec(info)
  if (match === null) throw new Error(`INFO memory omitted ${key}`)
  return Number(match[1])
}

function percentile(values: number[], fraction: number): number {
  return values[Math.ceil(values.length * fraction) - 1]
}
