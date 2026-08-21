import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * The app's own path alias, so its tests can import its modules the way it does.
 *
 * `tsconfig.json` maps `@website/*` to `./src/*` and Next.js honours it, but Vitest resolves
 * nothing from a tsconfig. Without this, a test of any route file fails at import — which is why
 * the only website tests that existed were of modules reached by a relative path. That is a check
 * shaped by what was easy to reach rather than by what was worth testing.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@website": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
})
