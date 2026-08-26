import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type {
  CreateSandboxInput,
  CreatedSandbox,
  ExecResult,
  PreviewLink,
  SandboxDriver,
  TreeEntry,
} from "./types"
import { SandboxNotFoundError, SandboxUnavailableError } from "./types"

const run = promisify(execFile)

/**
 * A sandbox that is a local container.
 *
 * ## Why a second driver exists
 *
 * `SandboxDriver` had exactly one implementation, which meant the interface had never been tested
 * *as* an interface — and worse, that the whole sandbox feature could not be exercised by anybody
 * without a Daytona account. Nothing in this repository could start one, so nothing in it had ever
 * been run: no clone, no skill injection, no agent turn, no preview. A feature that only works
 * where a paid vendor is configured is a feature nobody develops against and nobody notices
 * breaking.
 *
 * This is the development driver. It is not a security boundary in the way Daytona is — a container
 * on the developer's own machine is exactly as isolated as a container, which is to say a kernel
 * away — and it is deliberately not selectable in production. What it is, is a real sandbox: a real
 * clone, a real shell, a real port to preview.
 *
 * ## What it deliberately does not do
 *
 * No image building, no snapshot management. It runs a stock image and expects the agent binaries
 * to be installed into it or absent — the same condition a wrong Daytona snapshot produces, which
 * is a failure worth being able to reproduce locally rather than only in production.
 */

export type DockerConfig = {
  /** The image containers are started from. */
  image: string
  /** `docker`, or a path to it. */
  binary: string
  /**
   * Where a preview is reachable from the developer's browser.
   *
   * Ports are published on the host, so this is `http://localhost` — stated rather than assumed
   * because the value differs under a remote docker context and a silent `localhost` there is a
   * preview that never loads with nothing to explain it.
   */
  previewHost: string
}

export function dockerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DockerConfig {
  return {
    binary: env.SANDBOX_DOCKER_BINARY ?? "docker",
    image: env.SANDBOX_DOCKER_IMAGE ?? "node:24-slim",
    previewHost: env.SANDBOX_DOCKER_PREVIEW_HOST ?? "http://localhost",
  }
}

/** The workspace path inside the container, matching the Daytona driver's. */
const WORKSPACE = "/workspace"

export function dockerDriver(config: DockerConfig): SandboxDriver {
  async function docker(args: string[], timeoutMs = 120_000): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await run(config.binary, args, {
        timeout: timeoutMs,
        // A clone or an install can print more than the default 1 MiB, and truncation would land
        // mid-line in output something else is parsing.
        maxBuffer: 64 * 1024 * 1024,
      })
      return { stdout, stderr, exitCode: 0 }
    } catch (cause) {
      const error = cause as { stdout?: string; stderr?: string; code?: number; message?: string }
      if (typeof error.code !== "number") {
        // No exit code means docker itself did not run — daemon down, binary missing. An
        // operational fault, never a customer error, which is the distinction `providerError`
        // depends on to answer 500 rather than 400.
        throw new SandboxUnavailableError(error.message ?? "docker could not be run")
      }
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code }
    }
  }

  async function requireContainer(externalId: string): Promise<void> {
    const found = await docker(["inspect", "--format", "{{.State.Running}}", externalId])
    if (found.exitCode !== 0) throw new SandboxNotFoundError(externalId)
  }

  return {
    provider: "docker",

    async create(input: CreateSandboxInput): Promise<CreatedSandbox> {
      const name = `sproutos-sandbox-${input.sandboxId}`

      /*
        `sleep infinity` as the entrypoint.

        The container's job is to be somewhere commands run, not to run one command. Without a
        long-lived process it exits the moment the image's default command finishes, and every
        subsequent `exec` fails with "container is not running" — which reads like the sandbox
        crashed rather than like it was never asked to stay.
      */
      const args = [
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        `sproutos.sandbox=${input.sandboxId}`,
        "--label",
        `sproutos.organization=${input.organizationId}`,
        "--workdir",
        WORKSPACE,
        // Published on an ephemeral host port, which `previewUrl` then looks up. Fixed ports would
        // collide the moment a developer ran two sandboxes.
        "--publish-all",
        "--expose",
        "3000",
        "--expose",
        "5173",
        "--expose",
        "8080",
      ]

      for (const [key, value] of Object.entries(input.env ?? {})) {
        args.push("--env", `${key}=${value}`)
      }

      args.push(config.image, "sleep", "infinity")

      const created = await docker(args)
      if (created.exitCode !== 0) {
        throw new SandboxUnavailableError(`docker run failed: ${created.stderr.trim()}`)
      }

      await docker(["exec", name, "mkdir", "-p", WORKSPACE])
      return { externalId: name }
    },

    async start(externalId: string): Promise<void> {
      const result = await docker(["start", externalId])
      if (result.exitCode !== 0) throw new SandboxNotFoundError(externalId)
    },

    async stop(externalId: string): Promise<void> {
      // Not an error if it is already stopped: `stop` is what a reaper calls, and a reaper that
      // throws on an idle sandbox somebody already closed is a job that fails every night.
      await docker(["stop", "--time", "5", externalId])
    },

    async destroy(externalId: string): Promise<void> {
      await docker(["rm", "--force", externalId])
    },

    async exec(externalId: string, argv: string[], timeoutMs: number): Promise<ExecResult> {
      await requireContainer(externalId)
      return await docker(["exec", "--workdir", WORKSPACE, externalId, ...argv], timeoutMs)
    },

    async execStream(
      externalId: string,
      argv: string[],
      timeoutMs: number,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<ExecResult> {
      await requireContainer(externalId)

      return await new Promise<ExecResult>((resolve) => {
        const child = execFile(
          config.binary,
          ["exec", "--workdir", WORKSPACE, externalId, ...argv],
          { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
        )

        let stdout = ""
        let stderr = ""
        child.stdout?.setEncoding("utf8")
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk
          onStdout(chunk)
        })
        child.stderr?.setEncoding("utf8")
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk
          onStderr(chunk)
        })

        // `close`, not `exit`: `exit` fires when the process ends and `close` when its pipes are
        // drained, and resolving on the first drops whatever was still in flight — which is the
        // last few events of every agent turn.
        child.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? -1 })
        })
        child.on("error", (cause) => {
          resolve({ stdout, stderr: `${stderr}${String(cause)}`, exitCode: -1 })
        })
      })
    },

    async readFile(externalId: string, path: string): Promise<string> {
      const result = await docker(["exec", externalId, "cat", path])
      if (result.exitCode !== 0) throw new SandboxNotFoundError(`${externalId}:${path}`)
      return result.stdout
    },

    async writeFile(externalId: string, path: string, content: string): Promise<void> {
      await requireContainer(externalId)
      const directory = path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/"
      await docker(["exec", externalId, "mkdir", "-p", directory])

      /*
        Written through stdin, never through a shell argument.

        The alternative is `sh -c "echo '<content>' > path"`, which breaks on the first quote in a
        file and is a command injection wearing a convenience's clothes. `docker exec -i` with the
        content on stdin has neither problem.
      */
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          config.binary,
          ["exec", "-i", externalId, "sh", "-c", `cat > ${shellQuote(path)}`],
          (error) => {
            if (error) reject(new SandboxUnavailableError(error.message))
            else resolve()
          },
        )
        child.stdin?.end(content)
      })
    },

    async tree(externalId: string, path?: string): Promise<TreeEntry[]> {
      const target = path ?? WORKSPACE
      const result = await docker([
        "exec",
        externalId,
        "sh",
        "-c",
        `find ${shellQuote(target)} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%p\\n' 2>/dev/null || true`,
      ])

      return result.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const [kind, size, entry] = line.split("\t")
          return {
            path: entry ?? "",
            kind: kind === "d" ? ("directory" as const) : ("file" as const),
            sizeBytes: kind === "d" ? null : Number(size ?? 0),
          }
        })
    },

    async previewUrl(externalId: string, port: number, expiresInS: number): Promise<PreviewLink> {
      const mapped = await docker(["port", externalId, String(port)])
      if (mapped.exitCode !== 0 || mapped.stdout.trim() === "") {
        // Named, because the cause is nearly always that the container was created before that port
        // was in the exposed list — a fact no error from docker mentions.
        throw new SandboxUnavailableError(
          `port ${port} is not published on this sandbox; it must be exposed at create time`,
        )
      }

      // `0.0.0.0:32771` or `[::]:32771`, possibly several lines. The last field of the first line is
      // the host port.
      const first = mapped.stdout.trim().split("\n")[0] ?? ""
      const hostPort = first.slice(first.lastIndexOf(":") + 1)

      return {
        url: `${config.previewHost}:${hostPort}`,
        expiresAt: new Date(Date.now() + expiresInS * 1000),
      }
    },

    startDisplay(): Promise<void> {
      // No desktop here, and none wanted. `preview-panel.tsx` explains why a dev server is a page
      // to open rather than a picture of a browser looking at a page.
      //
      // Rejected rather than thrown, so a caller that only awaits sees a failed promise like every
      // other driver error rather than a synchronous throw from a call it never wrapped.
      return Promise.reject(new SandboxUnavailableError("the docker driver has no desktop"))
    },

    displayUrl(): Promise<PreviewLink> {
      return Promise.reject(new SandboxUnavailableError("the docker driver has no desktop"))
    },

    async touch(): Promise<void> {
      // Nothing to tell: a local container has no provider-side autostop to keep at bay. Our own
      // reaper is authoritative either way — see `reapSandboxes`.
    },
  }
}

/** Single-quote for `sh`, closing and reopening around embedded quotes. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
