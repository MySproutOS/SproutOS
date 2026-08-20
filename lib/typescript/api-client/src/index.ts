import { client } from "./generated/client.gen"
import { client as adminClient } from "./admin-generated/client.gen"

export * from "./generated/client.gen"
export * from "./generated/types.gen"
export * from "./generated/sdk.gen"

// Hardcoded rather than read from env: this module is consumed by both Next.js and the Vite
// SPAs, and NEXT_PUBLIC_* inlining doesn't reach a Vite build. NODE_ENV is the one variable
// both bundlers statically replace.
export const baseUrl =
  process.env.NODE_ENV === "development"
    ? "http://localhost:3001"
    : "https://api.nextjs-spa-split.andrewcwang.com"

client.setConfig({ baseUrl, credentials: "include" })
adminClient.setConfig({ baseUrl, credentials: "include" })
