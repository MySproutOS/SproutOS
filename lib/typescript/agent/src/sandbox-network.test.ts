import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { SANDBOX_NETWORK_LAUNCHER_SOURCE } from "./sandbox-network"

const execute = promisify(execFile)

describe("sandbox network launcher", () => {
  it("is valid Node code and transparently runs commands when there is no database", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sproutos-network-"))
    const launcher = path.join(directory, "run.mjs")
    await writeFile(launcher, SANDBOX_NETWORK_LAUNCHER_SOURCE)

    try {
      await expect(execute(process.execPath, ["--check", launcher])).resolves.toMatchObject({
        stderr: "",
      })
      const env = { ...process.env }
      delete env.DATABASE_URL
      await expect(
        execute(
          process.execPath,
          [launcher, "--", process.execPath, "-e", "process.stdout.write('ok')"],
          {
            env,
          },
        ),
      ).resolves.toMatchObject({ stdout: "ok", stderr: "" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("contains no database or proxy credential", () => {
    expect(SANDBOX_NETWORK_LAUNCHER_SOURCE).not.toContain("postgresql://")
    expect(SANDBOX_NETWORK_LAUNCHER_SOURCE).not.toContain("Proxy-Authorization: Basic d")
  })

  it("carries Postgres bytes through Daytona's unauthenticated local HTTP sidecar", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sproutos-network-"))
    const launcher = path.join(directory, "run.mjs")
    await writeFile(launcher, SANDBOX_NETWORK_LAUNCHER_SOURCE)

    let request = ""
    const proxySockets = new Set<net.Socket>()
    const proxy = net.createServer((socket) => {
      proxySockets.add(socket)
      socket.on("close", () => proxySockets.delete(socket))
      let established = false
      let pending = Buffer.alloc(0)
      socket.on("data", (chunk) => {
        if (established) {
          socket.write(chunk)
          return
        }
        pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
        const end = pending.indexOf("\r\n\r\n")
        if (end === -1) return
        request = pending.subarray(0, end).toString("ascii")
        established = true
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        const remainder = pending.subarray(end + 4)
        if (remainder.length > 0) socket.write(remainder)
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const address = proxy.address()
    if (!address || typeof address === "string") throw new Error("proxy did not bind")

    const client = String.raw`
      const net = require("node:net")
      const url = new URL(process.env.DATABASE_URL)
      const socket = net.connect(Number(url.port), url.hostname, () => socket.write("ping"))
      socket.on("data", (chunk) => { process.stdout.write(chunk); socket.end() })
      socket.on("error", (error) => { throw error })
    `
    try {
      await expect(
        execute(process.execPath, [launcher, "--", process.execPath, "-e", client], {
          env: {
            ...process.env,
            DATABASE_URL: "postgresql://tenant:secret@postgres.sproutos.test:5432/app",
            HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
          },
        }),
      ).resolves.toMatchObject({ stdout: "ping", stderr: "" })
      expect(request).toContain("CONNECT postgres.sproutos.test:5432 HTTP/1.1")
      expect(request).not.toContain("Proxy-Authorization")
    } finally {
      for (const socket of proxySockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      await rm(directory, { recursive: true, force: true })
    }
  })
})
