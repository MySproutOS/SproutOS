import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  /*
    The running API, whose port is not always 3001.

    It was hardcoded, which is fine until something else on the machine is already listening there —
    and then the generator reads *that* service's document and rewrites this client against it. The
    failure is not an error: it is a successful regeneration that silently drops every operation the
    real API has, which is worth one environment variable to avoid.
  */
  input: process.env.OPENAPI_INPUT ?? `http://localhost:${process.env.API_PORT ?? "3001"}/openapi`,
  output: {
    indexFile: false,
    path: "lib/typescript/api-client/src/generated",
  },
  parser: {
    filters: {
      // The generated fetch client buffers ordinary responses. The CLI owns the bounded SSE
      // parser for this operation, including resumable checkpoints and idle deadlines.
      operations: {
        exclude: ["GET /v1/orgs/{orgSlug}/projects/{projectId}/logs/follow"],
      },
    },
  },
  plugins: [
    "@hey-api/client-fetch",
    { name: "@tanstack/react-query", mutationOptions: true, queryKeys: true },
    "@hey-api/typescript",
    "@hey-api/transformers",
    // "zod",
    {
      /*
        `transformer: true` is what actually wires the transformers plugin in.

        Without it the plugin still emits `transformers.gen.ts` — 51 functions — and the SDK never
        calls any of them. The generated types then say `createdAt: Date` while every date arrives
        as an ISO string, which typechecks perfectly and throws `RangeError: Invalid time value` at
        render. Listing the plugin is not enabling it.
      */
      name: "@hey-api/sdk",
      transformer: true,
      // validator: {
      //   request: "zod",
      // },
    },
  ],
})
