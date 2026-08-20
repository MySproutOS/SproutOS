import { exec } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createClient } from "@hey-api/openapi-ts"
import { describe, expect, it } from "vitest"

const execAsync = promisify(exec)

describe("OpenAPI Generation with hey-api", () => {
  // tsc for some reason builds this test file, so we're explicitly skipping it
  it.skipIf(process.env.CI === "true" || import.meta.url.endsWith(".js"))(
    "should generate OpenAPI specs via command line and create client with hey-api",
    async () => {
      expect.assertions(0)
      // Create a temporary directory
      const tempDir = await mkdtemp(join(tmpdir(), "openapi-test-"))

      try {
        // Generate OpenAPI specs using the command line
        const currentDir = dirname(dirname(fileURLToPath(import.meta.url)))
        const specsPath = join(tempDir, "openapi.json")

        await execAsync(`pnpm dlx tsx src/index.ts --openapi > ${specsPath}`, {
          cwd: currentDir,
        })

        const outputDir = join(tempDir, "client")

        await createClient({
          input: specsPath,
          output: outputDir,
        })
      } finally {
        // Clean up temporary directory
        await rm(tempDir, { recursive: true, force: true })
      }
    },
    1000 * 60 * 3,
  )
})
