import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  // Same as the public config: the port is not always 3001, and reading another service's document
  // rewrites this client against it without erroring.
  input:
    process.env.OPENAPI_ADMIN_INPUT ??
    `http://localhost:${process.env.API_PORT ?? "3001"}/admin-openapi`,
  output: {
    indexFile: false,
    path: "lib/typescript/api-client/src/admin-generated",
  },
  plugins: [
    "@hey-api/client-fetch",
    { name: "@tanstack/react-query", mutationOptions: true, queryKeys: true },
    "@hey-api/typescript",
    "@hey-api/transformers",
    {
      /*
        `transformer: true` is what actually wires the transformers plugin in.

        Without it the plugin still emits `transformers.gen.ts` — 51 functions in the public client —
        and the SDK never calls any of them. The generated types then say `createdAt: Date` while
        every date arrives as an ISO string, which typechecks perfectly and throws
        `RangeError: Invalid time value` at render. Found by a teammate session whose members screen
        crashed on it; the dashboard had grown boundary coercions and comments apologising for the
        client "having no transformers".
      */
      name: "@hey-api/sdk",
      transformer: true,
    },
  ],
})
