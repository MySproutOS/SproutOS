import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  input: "http://localhost:3001/admin-openapi",
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
      name: "@hey-api/sdk",
    },
  ],
})
