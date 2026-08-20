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
declare const process: { env: { NODE_ENV?: string } }

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
 * is not something Next.js will resolve. `NODE_ENV` is the one variable both statically replace,
 * which is why the shape is a branch rather than a lookup.
 *
 * The production host used to be `api.nextjs-spa-split.andrewcwang.com` — the upstream template
 * author's domain, inherited when this repo was copied from `nextjs-spa-split` and never swept.
 * Every production build of all three apps would have sent authenticated requests, with cookies,
 * to somebody else's server. It never surfaced because nothing outside development exercises it.
 *
 * `API_HOST` is left as one named constant rather than an env read, so the next person changing
 * the domain changes it in one place and the grep that finds it is obvious.
 */
const API_HOST = "https://api.sproutos.dev"

export const baseUrl = process.env.NODE_ENV === "development" ? "http://localhost:3001" : API_HOST

client.setConfig({ baseUrl, credentials: "include" })
adminClient.setConfig({ baseUrl, credentials: "include" })
