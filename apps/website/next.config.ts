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
