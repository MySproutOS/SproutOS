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
      name: "@hey-api/sdk",
      // validator: {
      //   request: "zod",
      // },
    },
  ],
})
