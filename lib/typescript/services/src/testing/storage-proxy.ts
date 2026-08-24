import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import type { ObjectStorageConfig } from "../object-storage"

/**
 * Starts `services/storage-proxy` for a test file, on a port of its own.
 *
 * Shared by the two suites that need a running proxy, because they had drifted apart within an hour
 * of the second one being written — and because the interesting part is a mistake worth making only
 * once.
 *
 * **Every suite gets its own port.** Vitest runs test *files* in parallel, so two suites binding one
 * port means the second proxy exits on `address already in use` while the first still answers every
 * health check — and the second suite then asserts against a process it did not configure. That
 * presented as a log one test could not collect, which is not a clue anybody would follow.
 *
 * The customer-facing endpoint moves with the port: `publicEndpoint` is what goes into the
 * connection string a client actually dials, so a proxy on a different port needs a config that
 * says so.
 */
export const PROXY_BINARY = new URL("../../../../../target/debug/storage-proxy", import.meta.url)
  .pathname

export function proxyIsBuilt(): boolean {
  return existsSync(PROXY_BINARY)
}

export type RunningProxy = {
  process: ChildProcess
  /** The config to hand the driver, with `publicEndpoint` pointing at this proxy. */
  config: ObjectStorageConfig
  /** Everything the proxy logged, for suites that assert on what it did. */
  log: string[]
  stop: () => void
}

export async function startStorageProxy(
  config: ObjectStorageConfig,
  port: number,
  /*
    The one real bucket every tenant lives in (§4.5).

    Omitted keeps the original shape — a bucket per tenant, where S3 enforces the boundary. A suite
    exercising the shared layout has to say so, because the two cannot be mixed: half a customer's
    objects in each is the shape that looks like data loss.
  */
  sharedBucket?: string,
): Promise<RunningProxy> {
  const publicEndpoint = `http://127.0.0.1:${port}`
  const log: string[] = []

  const process_ = spawn(PROXY_BINARY, [], {
    env: {
      ...process.env,
      STORAGE_PROXY_LISTEN: `127.0.0.1:${port}`,
      STORAGE_PROXY_UPSTREAM: config.endpoint ?? "",
      STORAGE_PROXY_REGION: config.region,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      // Set here rather than left to the environment: one suite asserts on these lines, and a test
      // whose assertion depends on a log level someone else set is a test that silently checks
      // nothing.
      RUST_LOG: "storage_proxy=debug",
      ...(sharedBucket === undefined ? {} : { STORAGE_PROXY_SHARED_BUCKET: sharedBucket }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  // Both streams, by listener. `tracing_subscriber::fmt()` writes to *stdout*, and reading a stream
  // on demand returns only whatever happens to be buffered at that instant.
  const collect = (chunk: Buffer) => log.push(chunk.toString())
  process_.stdout?.on("data", collect)
  process_.stderr?.on("data", collect)

  // Watch the child, not only the port — see the note above.
  let exited: string | undefined
  process_.on("exit", (code) => {
    exited = `storage-proxy exited with ${code} before becoming ready (port ${port})`
  })

  const deadline = Date.now() + 15_000
  for (;;) {
    if (exited !== undefined) throw new Error(exited)
    if (Date.now() > deadline) throw new Error(`storage-proxy did not start on ${port}`)
    try {
      const response = await fetch(`${publicEndpoint}/healthz`)
      if (response.ok) break
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return {
    process: process_,
    config: { ...config, publicEndpoint },
    log,
    stop: () => {
      process_.kill("SIGTERM")
    },
  }
}
