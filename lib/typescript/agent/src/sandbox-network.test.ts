import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
})
