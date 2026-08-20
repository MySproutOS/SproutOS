import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  input: "http://localhost:3001/openapi",
  output: {
    indexFile: false,
    path: "lib/typescript/api-client/src/generated",
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
