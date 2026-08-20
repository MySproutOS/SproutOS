import path from "node:path"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteStaticCopy } from "vite-plugin-static-copy"

const fontsourceFiles = (pkg: string) =>
  path.resolve(
    __dirname,
    `../../../lib/typescript/ui/base/node_modules/@fontsource-variable/${pkg}/files/*.woff2`,
  )

export default defineConfig(() => ({
  /*
    The repo-root `.env`, not one per SPA.

    Vite looks in the app directory by default, and there is no `.env` there — so every
    `import.meta.env.VITE_*` read resolved to `undefined`, and each of the five redirects written as
    `${import.meta.env.VITE_NEXTJS_URL ?? ""}/dashboard` quietly became a same-origin path. On the
    dashboard that happens to work, because the website proxies it at the same origin. On the admin
    SPA, served under `/admin/` on its own host, it is a 404 — which is how this was found.
  */
  envDir: path.resolve(__dirname, "../../.."),
  /*
    Relative in production, not an absolute CDN URL.

    This was `https://d1i66hf38xpie.cloudfront.net/dashboard/` — the upstream template's CloudFront
    distribution, inherited when this repo was copied and never swept. It is not ours: a production
    build would have loaded every chunk from an account we do not control.

    `VITE_ASSET_BASE` is the override for the day a CDN of our own sits in front, and it is read
    from the repo-root `.env` via `envDir` below.
  */
  base: process.env.VITE_ASSET_BASE ?? "/",
  plugins: [
    tanstackRouter({ quoteStyle: "double" }),
    react(),
    tailwindcss(),
    babel({ presets: [reactCompilerPreset()] }),
    viteStaticCopy({
      targets: [
        { src: fontsourceFiles("geist"), dest: "assets/files", rename: { stripBase: true } },
        { src: fontsourceFiles("geist-mono"), dest: "assets/files", rename: { stripBase: true } },
      ],
    }),
  ],
  optimizeDeps: {
    entries: [
      "index.html",
      "src/**/*.{ts,tsx}",
      "../../../lib/typescript/ui/base/src/**/*.{ts,tsx}",
      "../../../lib/typescript/ui/spa-shared/src/**/*.{ts,tsx}",
      "../../../lib/typescript/ui/seo-shared/src/**/*.{ts,tsx}",
      "../../../lib/typescript/api-client/src/**/*.{ts,tsx}",
    ],
  },
  resolve: {
    alias: {
      "@frontends/dashboard": path.resolve(__dirname, "./src"),
      "@ui/base": path.resolve(__dirname, "../../../lib/typescript/ui/base/src"),
      "@ui/spa-shared": path.resolve(__dirname, "../../../lib/typescript/ui/spa-shared/src"),
      // Must come before the "@ui/seo-shared" prefix alias so seo-shared components render
      // links with TanStack Router's Link instead of the plain <a> template.
      "@ui/seo-shared/_internal/seo-link": path.resolve(__dirname, "./src/components/seo-link.tsx"),
      "@ui/seo-shared": path.resolve(__dirname, "../../../lib/typescript/ui/seo-shared/src"),
      "@lib/api-client": path.resolve(__dirname, "../../../lib/typescript/api-client/src"),
      // The package's exports map resolves "@lib/billing/money" to "./src/money"
      // with no extension, which neither tsc nor the bundler will complete. Same
      // alias shape as every other workspace package this SPA consumes.
      "@lib/billing": path.resolve(__dirname, "../../../lib/typescript/billing/src"),
    },
  },
  server: {
    port: 3002,
  },
}))
