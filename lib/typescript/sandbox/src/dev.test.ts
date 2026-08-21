import { describe, expect, it } from "vitest"
import {
  PathEscapesWorkspaceError,
  WORKSPACE,
  devSandboxPod,
  resolveWorkspacePath,
  shellQuote,
} from "./dev"
import { CHANNEL, exitCodeFrom, execPath, OPCODE_BINARY, readFrame, writeFrame } from "./exec"

/*
  The file API takes a path a customer typed. Everything else about the pod — no root, no
  capabilities, its own namespace — is irrelevant to being asked for `../../etc/shadow`, and the
  container has files worth not handing out.
*/
describe("resolveWorkspacePath", () => {
  it("resolves a plain relative path into the workspace", () => {
    expect(resolveWorkspacePath("src/index.ts")).toBe(`${WORKSPACE}/src/index.ts`)
  })

  it("collapses . and interior .. that stay inside", () => {
    expect(resolveWorkspacePath("src/./nested/../index.ts")).toBe(`${WORKSPACE}/src/index.ts`)
  })

  it("refuses every way out of the workspace", () => {
    const escapes = [
      "../etc/passwd",
      "src/../../etc/passwd",
      "..",
      "./..",
      "a/../..",
      "/etc/passwd",
      "/workspace/../etc/passwd",
    ]
    const accepted = escapes.filter((path) => {
      try {
        resolveWorkspacePath(path)
        return true
      } catch {
        return false
      }
    })
    expect(accepted).toEqual([])
  })

  it("refuses an absolute path rather than rebasing it", () => {
    // Rebasing `/etc/passwd` to `/workspace/etc/passwd` reads a silently different file from the
    // one asked for, and silence is what makes a path bug hard to find.
    expect(() => resolveWorkspacePath("/etc/passwd")).toThrow(PathEscapesWorkspaceError)
  })

  it("refuses a NUL byte, which truncates a path in a syscall", () => {
    expect(() => resolveWorkspacePath("safe\0../../etc/passwd")).toThrow(PathEscapesWorkspaceError)
  })

  it("refuses the empty path and a path of only separators", () => {
    expect(() => resolveWorkspacePath("")).toThrow(PathEscapesWorkspaceError)
    expect(() => resolveWorkspacePath("///")).toThrow(PathEscapesWorkspaceError)
  })
})

describe("shellQuote", () => {
  it("handles the case people forget", () => {
    // A single quote cannot be escaped inside single quotes; the standard dance is to close, emit
    // an escaped quote, and reopen. `writeFile` interpolates a path into a shell string, so this
    // is the only thing between a filename and a second command.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })

  it("quotes the characters a shell would otherwise act on", () => {
    expect(shellQuote("a b;rm -rf /")).toBe(`'a b;rm -rf /'`)
    expect(shellQuote("$(whoami)")).toBe(`'$(whoami)'`)
  })
})

describe("the dev sandbox pod", () => {
  const base = {
    namespace: "tenant-acme",
    name: "sbx-1",
    image: "node:24-alpine",
    idleTimeoutSeconds: 900,
    organizationId: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
    projectId: "01912d40-0000-7000-8000-0000000000a1",
  }

  /*
    A dev sandbox holds a pod for fifteen minutes past the last keystroke, on a real node. It
    carried no attribution label, so all of that was free.
  */
  it("labels the pod with who pays for it", () => {
    const pod = devSandboxPod(base) as { metadata: { labels: Record<string, string> } }
    expect(pod.metadata.labels).toMatchObject({
      "sproutos.dev/organization-id": "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
      "sproutos.dev/project-id": "01912d40-0000-7000-8000-0000000000a1",
    })
  })

  it("carries no service-account token", () => {
    const pod = devSandboxPod(base) as { spec: Record<string, unknown> }
    expect(pod.spec.automountServiceAccountToken).toBe(false)
  })

  it("never restarts, because a silent restart loses the state somebody was working in", () => {
    const pod = devSandboxPod(base) as { spec: { restartPolicy: string } }
    expect(pod.spec.restartPolicy).toBe("Never")
  })

  it("sleeps rather than running the customer's dev command", () => {
    // A command baked into the pod takes the sandbox with it when it exits, and a person debugging
    // a crash-on-start has just lost the environment they were debugging it in.
    const pod = devSandboxPod(base) as { spec: { containers: { command: string[] }[] } }
    expect(pod.spec.containers[0]?.command).toEqual(["sleep", "infinity"])
  })

  it("records the idle timeout where a reaper can read it", () => {
    const pod = devSandboxPod(base) as { metadata: { annotations: Record<string, string> } }
    expect(pod.metadata.annotations["sproutos.dev/idle-timeout-seconds"]).toBe("900")
  })
})

/*
  The exec channel is a hand-rolled WebSocket, because neither Node's global `WebSocket` nor `fetch`
  can be given the cluster's CA. That makes the framing ours to get right.
*/
describe("the exec channel", () => {
  /*
    A frame as a *server* sends it: unmasked.

    `writeFrame` masks, because the RFC requires a client to and the API server closes the
    connection on an unmasked client frame. `readFrame` does not unmask, because a masked frame
    from a server is a protocol violation. That asymmetry is correct and it makes a naive
    write-then-read round trip meaningless — which is what the first version of this test did, and
    it failed against code that was right.
  */
  function serverFrame(payload: Buffer): Buffer {
    const header: number[] = [0x82]
    if (payload.length < 126) header.push(payload.length)
    else header.push(126, payload.length >> 8, payload.length & 0xff)
    return Buffer.concat([Buffer.from(header), payload])
  }

  it("reads a short server frame", () => {
    const payload = Buffer.from([1, ...Buffer.from("hello", "utf8")])
    const read = readFrame(serverFrame(payload))
    expect(read?.payload).toEqual(payload)
    expect(read?.rest.length).toBe(0)
  })

  it("reads a frame long enough to need the 16-bit length", () => {
    const payload = Buffer.concat([Buffer.from([1]), Buffer.alloc(700, 0x61)])
    expect(readFrame(serverFrame(payload))?.payload).toEqual(payload)
  })

  it("returns undefined for a frame that has not all arrived", () => {
    // Every socket read is a partial frame until it is not, and treating a short buffer as a whole
    // one is how a stream parser loses data.
    expect(readFrame(serverFrame(Buffer.from([1, 2, 3, 4, 5])).subarray(0, 3))).toBeUndefined()
  })

  it("leaves the remainder when two frames arrive together", () => {
    const both = Buffer.concat([
      serverFrame(Buffer.from([1, 65])),
      serverFrame(Buffer.from([1, 66])),
    ])
    const first = readFrame(both)
    expect(first?.payload).toEqual(Buffer.from([1, 65]))
    expect(readFrame(first?.rest ?? Buffer.alloc(0))?.payload).toEqual(Buffer.from([1, 66]))
  })

  /*
    The close frame that looked like an error.

    A normal WebSocket close carries status 1000 — `0x03 0xE8`. Read as a data frame that is
    channel 3, the error stream, with an unparseable payload, so every successful command came back
    exit 1 while its stdout sat right there. Opcode is the only thing that distinguishes them.
  */
  it("reports the opcode, so a close frame is not read as channel 3", () => {
    const close = Buffer.from([0x88, 0x02, 0x03, 0xe8])
    const read = readFrame(close)
    expect(read?.opcode).toBe(0x8)
    expect(read?.payload).toEqual(Buffer.from([0x03, 0xe8]))
    // The payload really does begin with the error channel's number, which is why the opcode has
    // to be the thing that is checked.
    expect(read?.payload[0]).toBe(CHANNEL.error)
  })

  it("reports binary for a data frame", () => {
    expect(readFrame(serverFrame(Buffer.from([1, 65])))?.opcode).toBe(OPCODE_BINARY)
  })

  it("masks what it writes, which the server requires of a client", () => {
    const framed = writeFrame(Buffer.from([1, 65, 66, 67]))
    // Bit 7 of the second byte is the mask flag. Without it the API server closes the connection,
    // and the failure looks like the pod refusing rather than the frame being malformed.
    expect((framed[1] ?? 0) & 0x80).toBe(0x80)
    expect(framed.length).toBe(2 + 4 + 4)
  })

  it("reads the exit code off the status stream, not the close code", () => {
    expect(exitCodeFrom(JSON.stringify({ status: "Success" }))).toBe(0)
    expect(
      exitCodeFrom(
        JSON.stringify({
          status: "Failure",
          details: { causes: [{ reason: "ExitCode", message: "42" }] },
        }),
      ),
    ).toBe(42)
  })

  it("treats an unparseable status as a failure rather than as no information", () => {
    expect(exitCodeFrom("{not json")).toBe(1)
  })

  it("is null only when the stream said nothing at all", () => {
    expect(exitCodeFrom("")).toBeNull()
  })

  it("sends each command argument separately, so a path with a space stays one path", () => {
    const path = execPath({
      namespace: "n",
      pod: "p",
      container: "dev",
      command: ["cat", "--", "/workspace/two words.txt"],
    })
    expect(path).toContain("command=cat")
    // `+` for the space: `URLSearchParams` writes form encoding, which is what Go's `net/url`
    // decodes on the other side. The argument arrives as one string either way, which is the
    // property that matters.
    expect(path).toContain("command=%2Fworkspace%2Ftwo+words.txt")
  })
})
