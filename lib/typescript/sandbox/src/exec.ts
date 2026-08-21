import { createHash, randomBytes } from "node:crypto"
import { Agent, request as httpsRequest } from "node:https"
import type { Duplex } from "node:stream"

/**
 * Running a command inside a sandbox that is already running.
 *
 * The Job in `run.ts` is for work that starts, finishes and goes away. A dev sandbox is the other
 * shape: a pod that stays up holding a workspace, that a person opens files in and runs commands
 * against. Its operations have to reach *into* the running pod, which is the `pods/exec`
 * subresource.
 *
 * Implemented over a raw WebSocket upgrade rather than a library, for the reason the kube client
 * uses `node:https`: the API server presents a certificate signed by the cluster's own CA, and
 * neither Node's global `WebSocket` nor `fetch` can be told about it. Doing the upgrade by hand
 * means the TLS options are ours.
 *
 * The wire format is Kubernetes' `v4.channel.k8s.io`: every binary frame is one byte of channel
 * number followed by payload. Channel 0 is stdin, 1 stdout, 2 stderr, 3 the error stream carrying a
 * JSON `Status`, and 4 resize. It is a simple protocol and the only subtlety is that the exit code
 * arrives on channel 3 rather than as a close code — a caller reading only stdout learns nothing
 * about whether the command worked.
 */

export const CHANNEL = {
  stdin: 0,
  stdout: 1,
  stderr: 2,
  error: 3,
} as const

export type ExecResult = {
  stdout: string
  stderr: string
  /** From the channel-3 `Status`. `0` on success; `null` when the stream closed without one. */
  exitCode: number | null
}

export type ExecInput = {
  server: string
  token?: () => string
  certificateAuthority?: string
  namespace: string
  pod: string
  container: string
  command: string[]
  /** Written to channel 0 and then closed. Absent means the command gets no stdin at all. */
  stdin?: string
  timeoutMs?: number
}

/** Two minutes, the same bound the Job sandbox uses. */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000

/**
 * The exec URL.
 *
 * `command` is repeated once per argument rather than joined, which is what keeps a filename with a
 * space in it one argument. Joining and letting a shell split it is how a path becomes two paths,
 * and how a path a customer chose becomes a second command.
 */
export function execPath(
  input: Pick<ExecInput, "namespace" | "pod" | "container" | "command" | "stdin">,
): string {
  const query = new URLSearchParams()
  query.set("container", input.container)
  query.set("stdout", "true")
  query.set("stderr", "true")
  if (input.stdin !== undefined) query.set("stdin", "true")
  for (const argument of input.command) query.append("command", argument)

  return `/api/v1/namespaces/${encodeURIComponent(input.namespace)}/pods/${encodeURIComponent(input.pod)}/exec?${query.toString()}`
}

/** Parse the channel-3 `Status`, which is where an exit code lives. */
export function exitCodeFrom(status: string): number | null {
  if (status === "") return null
  try {
    const parsed = JSON.parse(status) as {
      status?: string
      details?: { causes?: { reason?: string; message?: string }[] }
    }
    if (parsed.status === "Success") return 0
    const cause = parsed.details?.causes?.find((entry) => entry.reason === "ExitCode")
    const code = Number(cause?.message)
    return Number.isFinite(code) ? code : 1
  } catch {
    // A Status we cannot parse means the command did not report success, and reporting `null` here
    // would let a caller treat an unreadable failure as "no information" rather than as a failure.
    return 1
  }
}

export async function execInPod(input: ExecInput): Promise<ExecResult> {
  const url = new URL(input.server)
  const key = randomBytes(16).toString("base64")

  const headers: Record<string, string> = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
    // The channel protocol. `v4` is the one that carries an exit code; `v3` and below report a
    // command that failed exactly like one that succeeded.
    "Sec-WebSocket-Protocol": "v4.channel.k8s.io",
  }
  if (input.token !== undefined) headers.Authorization = `Bearer ${input.token()}`

  const agent =
    input.certificateAuthority === undefined
      ? undefined
      : new Agent({ ca: input.certificateAuthority })

  return await new Promise<ExecResult>((resolve, reject) => {
    const request = httpsRequest(`${url.origin}${execPath(input)}`, {
      method: "GET",
      headers,
      ...(agent === undefined ? {} : { agent }),
    })

    const timer = setTimeout(() => {
      request.destroy(
        new Error(`exec did not finish within ${input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS}ms`),
      )
    }, input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS)

    request.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })

    request.on("response", (response) => {
      // A response instead of an upgrade means the API server refused — 401, 403, or a pod that is
      // not running. Read it, because the body says which.
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => {
        clearTimeout(timer)
        reject(
          new Error(
            `exec was refused with ${response.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`,
          ),
        )
      })
    })

    request.on("upgrade", (upgrade, socket: Duplex, head: Buffer) => {
      const expected = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64")

      if (upgrade.headers["sec-websocket-accept"] !== expected) {
        clearTimeout(timer)
        socket.destroy()
        reject(new Error("the WebSocket handshake was not accepted"))
        return
      }

      const out: Buffer[] = []
      const err: Buffer[] = []
      const status: Buffer[] = []
      let buffer = head

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const frame = readFrame(buffer)
          if (frame === undefined) break
          buffer = frame.rest

          /*
            Binary frames only.

            A WebSocket close frame carries a two-byte status code, and the normal one is 1000 —
            `0x03 0xE8`. Read as a data frame that is channel **3**, the error stream, with a
            payload of `0xE8` and whatever reason text follows: unparseable as JSON, so
            `exitCodeFrom` reported a failure for every command that had just succeeded. Observed
            exactly that way — `node src/hello.js` printed its output and came back exit 1.

            Ping and pong have the same problem in principle and neither is likely from this
            server; checking the opcode covers all three and costs one comparison.
          */
          if (frame.opcode !== OPCODE_BINARY) continue
          if (frame.payload.length === 0) continue

          const channel = frame.payload[0]
          const body = frame.payload.subarray(1)
          if (channel === CHANNEL.stdout) out.push(body)
          else if (channel === CHANNEL.stderr) err.push(body)
          else if (channel === CHANNEL.error) status.push(body)
        }
      })

      socket.on("close", () => {
        clearTimeout(timer)
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          exitCode: exitCodeFrom(Buffer.concat(status).toString("utf8")),
        })
      })

      socket.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })

      if (input.stdin !== undefined) {
        socket.write(
          writeFrame(
            Buffer.concat([Buffer.from([CHANNEL.stdin]), Buffer.from(input.stdin, "utf8")]),
          ),
        )
        // Half-close stdin by sending an empty stdin frame; without it a command reading to EOF
        // never sees one and the exec hangs until the timeout.
        socket.write(writeFrame(Buffer.from([CHANNEL.stdin])))
      }
    })

    request.end()
  })
}

/**
 * One WebSocket frame off the front of a buffer, or `undefined` if it is not all there yet.
 *
 * Server-to-client frames are never masked, which is why there is no unmasking here — a masked
 * frame from a server is a protocol violation and would be a different bug entirely.
 */
export function readFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; rest: Buffer } | undefined {
  if (buffer.length < 2) return undefined

  const opcode = (buffer[0] ?? 0) & 0x0f
  const first = buffer[1] ?? 0
  const short = first & 0x7f
  let offset = 2
  let length = short

  if (short === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (short === 127) {
    if (buffer.length < 10) return undefined
    // `Number` of a 64-bit length: a frame larger than 2^53 bytes is not a case this has to carry,
    // and the alternative is bigint arithmetic on every frame of every exec.
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }

  if (buffer.length < offset + length) return undefined
  return {
    opcode,
    payload: buffer.subarray(offset, offset + length),
    rest: buffer.subarray(offset + length),
  }
}

/** Binary: the only opcode whose payload carries a channel byte. */
export const OPCODE_BINARY = 0x2

/** One masked binary frame. Client-to-server frames must be masked; the RFC is not optional here. */
export function writeFrame(payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = (masked[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }

  const header: number[] = [0x82]
  if (masked.length < 126) header.push(0x80 | masked.length)
  else if (masked.length < 65536) header.push(0x80 | 126, masked.length >> 8, masked.length & 0xff)
  else {
    header.push(0x80 | 127)
    for (let shift = 56; shift >= 0; shift -= 8) header.push((masked.length >> shift) & 0xff)
  }

  return Buffer.concat([Buffer.from(header), mask, masked])
}
