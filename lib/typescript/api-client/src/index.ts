/*
  Declared, not imported from `@types/node`.

  This module is bundled into two browser apps, whose tsconfigs deliberately do not include node
  types — so `process` was an error in both SPAs for as long as this file has existed. It was
  invisible because `vite build` does not typecheck at all: it strips types with esbuild and never
  runs `tsc`, so a green build said nothing about it.

  The declaration is not a lie about the runtime. `process.env.NODE_ENV` is the one expression both
  Next.js and Vite statically replace with a literal at build time, so nothing named `process`
  survives into the bundle. Narrowing it to the single field we use is what keeps that true — a
  wider shim would invite a second reference that really does need node.
*/
declare const process: { env: { NODE_ENV?: string; NEXT_PUBLIC_API_URL?: string } }

import { client } from "./generated/client.gen"
import { client as adminClient } from "./admin-generated/client.gen"

export * from "./generated/client.gen"
export * from "./generated/types.gen"
export * from "./generated/sdk.gen"

/**
 * Where the API lives.
 *
 * This module is consumed by both Next.js and the Vite SPAs, and neither bundler can see the
 * other's convention: `NEXT_PUBLIC_*` inlining does not reach a Vite build, and `import.meta.env`
 * is not something Next.js will resolve. `NODE_ENV` is the one variable both statically replace
 * without help, which is why the development branch is a comparison rather than a lookup.
 *
 * `NEXT_PUBLIC_API_URL` is the production host, and it is **inlined at build time in all three
 * apps** — Next.js does it natively, and each SPA's `vite.config.ts` carries a matching `define`.
 * One environment variable, three bundlers, no second name to keep in step.
 *
 * It used to be a hard-coded constant. First `https://api.nextjs-spa-split.andrewcwang.com` — the
 * upstream template author's domain, inherited when this repo was copied and never swept — and then
 * `https://api.sproutos.dev`, which is ours in intent and does not resolve. Either way every
 * production build of all three apps sent authenticated requests, with cookies, to a host nobody
 * had checked. A constant cannot be right for two deployments, and this platform is deliberately
 * deployed to more than one.
 *
 * Unset, it is the empty string rather than a guess. An empty base URL makes every request relative
 * to the page's own origin: wrong, immediately visible in the network panel, and — the part that
 * matters — incapable of sending a session cookie to a stranger. The SPA builds refuse outright
 * (see `vite.config.ts`), so reaching this fallback in production means someone bypassed the build.
 */
const API_HOST = process.env.NEXT_PUBLIC_API_URL ?? ""

export const baseUrl = process.env.NODE_ENV === "development" ? "http://localhost:3001" : API_HOST

client.setConfig({ baseUrl, credentials: "include" })
adminClient.setConfig({ baseUrl, credentials: "include" })
