import path from "node:path"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { viteStaticCopy } from "vite-plugin-static-copy"

const REPO_ROOT = path.resolve(__dirname, "../../..")

// Resolved from this app's own node_modules: the app declares the fontsource packages because it
// imports them in app.css. Reaching into `@ui/base/node_modules` instead used to work, but only
// because pnpm happened to place them there — it broke the moment anything else installed.
const fontsourceFiles = (pkg: string) =>
  path.resolve(__dirname, `node_modules/@fontsource-variable/${pkg}/files/*.woff2`)

export default defineConfig(({ mode }) => ({
  /*
    The repo-root `.env`, not one per SPA.

    Vite looks in the app directory by default, and there is no `.env` there — so every
    `import.meta.env.VITE_*` read resolved to `undefined`, and each of the five redirects written as
    `${import.meta.env.VITE_NEXTJS_URL ?? ""}/dashboard` quietly became a same-origin path. On the
    dashboard that happens to work, because the website proxies it at the same origin. On the admin
    SPA, served under `/admin/` on its own host, it is a 404 — which is how this was found.
  */
  envDir: REPO_ROOT,
  /*
    Relative in production, not an absolute CDN URL.

    This was `https://d1i66hf38xpie.cloudfront.net/admin/` — the upstream template's CloudFront
    distribution, inherited when this repo was copied and never swept. It is not ours: a production
    build would have loaded every chunk from an account we do not control.

    `VITE_ASSET_BASE` is the override for the day a CDN of our own sits in front.

    It goes through `loadEnv`, not `process.env`. `envDir` tells Vite where to find `.env` for
    `import.meta.env` in *client* code; it does not put anything on `process.env`, so a config-level
    `process.env.VITE_ASSET_BASE` only ever saw a real shell variable and silently ignored the
    repo-root `.env`. Measured: with `VITE_NEXTJS_URL` sitting in that file, `process.env` held zero
    `VITE_*` keys during config evaluation. `loadEnv` reads the file and merges the shell on top, so
    both work.
  */
  base: loadEnv(mode, REPO_ROOT, "").VITE_ASSET_BASE ?? "/admin/",
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
      "@frontends/admin": path.resolve(__dirname, "./src"),
      "@ui/base": path.resolve(__dirname, "../../../lib/typescript/ui/base/src"),
      "@ui/spa-shared": path.resolve(__dirname, "../../../lib/typescript/ui/spa-shared/src"),
      // Must come before the "@ui/seo-shared" prefix alias so seo-shared components render
      // links with TanStack Router's Link instead of the plain <a> template.
      "@ui/seo-shared/_internal/seo-link": path.resolve(__dirname, "./src/components/seo-link.tsx"),
      "@ui/seo-shared": path.resolve(__dirname, "../../../lib/typescript/ui/seo-shared/src"),
      "@lib/api-client": path.resolve(__dirname, "../../../lib/typescript/api-client/src"),
    },
  },
  server: {
    port: 3003,
  },
}))
