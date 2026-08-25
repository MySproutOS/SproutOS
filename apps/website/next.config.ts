import * as path from "node:path"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactCompiler: true,
  // The container runs `node apps/website/server.js`, which only exists under standalone output.
  // Without this the image builds cleanly and then exits instantly on a missing module.
  output: "standalone",
  // In a workspace the traced tree must be rooted at the repo, not at this app, or the symlinked
  // `@lib/*` and `@sproutos/db` packages are traced as dangling links and left out of the bundle.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  /*
    Half of `@swc/helpers` is not enough, and tracing only found half.

    The standalone bundle shipped `@swc/helpers/cjs` and no `esm/`, so the server started and threw
    `Cannot find module '.../@swc/helpers/esm/_interop_require_default.js'` — a module Next's own
    `require-hook` loads. Tracing follows what it can see statically, and that hook resolves the
    path at runtime, so the ESM half is never traced.

    It builds, it packages, and it dies on the instance. Nothing before that point fails, which is
    why this was found by a load balancer health check rather than by a build.
  */
  outputFileTracingIncludes: {
    "/**": ["../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**"],
  },
  // Links routinely point at SPA routes served through the proxy (e.g. /dashboard),
  // which typed routes would reject as unknown Next.js routes
  typedRoutes: false,
  transpilePackages: [
    "@sproutos/db",
    "@lib/api-client",
    "@lib/envelope",
    "@lib/oauth",
    "@ui/base",
    "@ui/seo-shared",
    "@ui/spa-shared",
    "@utils/cookies",
    "@utils/crypto",
  ],
  turbopack: {
    root: path.join(__dirname, "..", ".."),
    resolveAlias: {
      // Swap the seo-shared link template for the next/link adapter
      "@ui/seo-shared/_internal/seo-link": "./src/components/seo-link.tsx",
    },
  },
}

export default nextConfig
