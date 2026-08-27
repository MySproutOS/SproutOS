/** Platform-owned launcher written beneath `.git`, where customer Git can never stage it. */
export const SANDBOX_NETWORK_LAUNCHER = ".git/sproutos/network/run.mjs"

/**
 * Run an agent with ordinary `DATABASE_URL` semantics through Daytona's HTTPS-only egress.
 *
 * Daytona installs the authenticated proxy as `HTTPS_PROXY`, but Postgres clients do not speak
 * HTTP proxy protocol. The launcher opens a loopback TCP listener, carries each connection through
 * an authenticated CONNECT to the public pg-proxy listener, and rewrites only the host and port in
 * the child environment. The database credential never enters an argument, file, or log.
 *
 * The tunnel is a detached descendant of the Daytona process session. A successful turn keeps that
 * session alive for preview processes, so an app the agent starts keeps its database connection;
 * stop/destroy deletes the session and the tunnel with it.
 */
export const SANDBOX_NETWORK_LAUNCHER_SOURCE = String.raw`
import { spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import fs from "node:fs"
import net from "node:net"
import tls from "node:tls"

const fail = (message) => {
  process.stderr.write("SproutOS sandbox network setup failed: " + message + "\n")
  process.exit(1)
}

const authority = (host, port) => (net.isIPv6(host) ? "[" + host + "]:" + port : host + ":" + port)

async function tunnelMode() {
  const targetHost = process.argv[3]
  const targetPort = Number(process.argv[4])
  const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    fail("invalid Postgres destination")
  }
  if (!proxyValue) fail("HTTPS_PROXY is unavailable")

  const proxy = new URL(proxyValue)
  if (proxy.protocol !== "https:" || !proxy.username || !proxy.password) {
    fail("HTTPS_PROXY must be an authenticated HTTPS URL")
  }
  const proxyHost = proxy.hostname
  const proxyPort = Number(proxy.port || 443)
  const credentials = Buffer.from(
    decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password),
  ).toString("base64")
  const destination = authority(targetHost, targetPort)

  const server = net.createServer((client) => {
    let established = false
    let response = Buffer.alloc(0)
    const upstream = tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost })

    const close = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on("error", close)
    upstream.on("error", close)
    upstream.on("secureConnect", () => {
      upstream.write(
        "CONNECT " + destination + " HTTP/1.1\r\n" +
          "Host: " + destination + "\r\n" +
          "Proxy-Authorization: Basic " + credentials + "\r\n\r\n",
      )
    })
    upstream.on("data", (chunk) => {
      if (established) return
      response = Buffer.concat([response, chunk])
      if (response.length > 16384) return close()
      const end = response.indexOf("\r\n\r\n")
      if (end === -1) return
      const status = response.subarray(0, response.indexOf("\r\n")).toString("ascii")
      if (!/^HTTP\/1\.[01] 200(?: |$)/.test(status)) return close()
      established = true
      upstream.removeAllListeners("data")
      const remainder = response.subarray(end + 4)
      if (remainder.length > 0) client.write(remainder)
      client.pipe(upstream)
      upstream.pipe(client)
    })
  })

  server.on("error", (error) => fail(error.message))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") fail("could not allocate loopback listener")
    fs.writeSync(3, String(address.port) + "\n")
    fs.closeSync(3)
  })
}

async function launchMode() {
  const separator = process.argv.indexOf("--")
  const command = separator === -1 ? [] : process.argv.slice(separator + 1)
  if (command.length === 0) fail("no agent command was supplied")

  const childEnv = { ...process.env }
  const databaseValue = childEnv.DATABASE_URL
  if (databaseValue) {
    const database = new URL(databaseValue)
    if (database.protocol !== "postgres:" && database.protocol !== "postgresql:") {
      fail("DATABASE_URL is not PostgreSQL")
    }
    const targetHost = database.hostname
    const targetPort = Number(database.port || 5432)
    const tunnel = spawn(process.execPath, [process.argv[1], "--tunnel", targetHost, String(targetPort)], {
      detached: true,
      env: process.env,
      stdio: ["ignore", "ignore", "inherit", "pipe"],
    })
    const ready = tunnel.stdio[3]
    const localPort = await new Promise((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => reject(new Error("Postgres tunnel did not start")), 10000)
      ready.on("data", (chunk) => {
        output += chunk.toString("ascii")
        const newline = output.indexOf("\n")
        if (newline === -1) return
        clearTimeout(timer)
        const port = Number(output.slice(0, newline))
        if (!Number.isInteger(port) || port < 1 || port > 65535) reject(new Error("invalid tunnel port"))
        else resolve(port)
      })
      ready.on("error", reject)
      tunnel.on("exit", (code) => reject(new Error("Postgres tunnel exited with " + code)))
    }).catch((error) => fail(error.message))
    ready.destroy()
    tunnel.unref()
    database.hostname = "127.0.0.1"
    database.port = String(localPort)
    childEnv.DATABASE_URL = database.toString()
  }

  const child = spawn(command[0], command.slice(1), { env: childEnv, stdio: "inherit" })
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
  child.on("error", (error) => fail(error.message))
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })
}

if (process.argv[2] === "--tunnel") await tunnelMode()
else await launchMode()
`
