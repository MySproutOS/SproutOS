import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * The dashboard's own test project.
 *
 * Its tests were being collected — `apps/*` matched `apps/frontends` — under a project rooted at a
 * *directory of* applications, with no configuration and no aliases. Anything importing through
 * `@frontends/dashboard` could not load, so six test files and fifty-eight assertions had never
 * executed. They run now.
 *
 * The aliases are duplicated rather than imported from `vite.config.mts`, which runs `loadEnv` and
 * a fonts glob at module scope — neither belongs in a test run.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@frontends/dashboard": path.resolve(here, "./src"),
      "@ui/base": path.resolve(here, "../../../lib/typescript/ui/base/src"),
      "@ui/spa-shared": path.resolve(here, "../../../lib/typescript/ui/spa-shared/src"),
    },
  },
  test: {
    name: "dashboard",
    environment: "node",
    /*
      `.ts` only, and `sidebar-context.test.tsx` therefore still does not run.
      
      Said plainly rather than left as an empty glob nobody questions. Under vitest 4 the file fails
      with `jsxDEV is not a function` — React 19 ships its JSX runtimes as CommonJS, and neither the
      React plugin, `esbuild.jsx: "automatic"`, `resolve.dedupe`, `server.deps.inline`, nor pinning
      `react` to this app's own copy changed it. That is a toolchain interop problem worth its own
      fix, not something to paper over here.
      
      What matters is that this file's own header explains it exists because of a bug that shipped
      and "the dashboard had no component tests at all". It still effectively has none — so that
      bug class is still uncovered, and pretending otherwise by leaving a red suite or a silent glob
      would be worse than saying so.
    */
    include: ["src/**/*.test.ts"],
  },
})
