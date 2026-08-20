import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { client } from "@lib/api-client/generated/client.gen"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@frontends/dashboard/app.css"
import { routeTree } from "@frontends/dashboard/routeTree.gen"
import { baseUrl } from "@lib/api-client/index"

client.setConfig({ baseUrl, credentials: "include" })

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1 },
    mutations: { retry: 0 },
  },
})

const router = createRouter({ routeTree, basepath: "/" })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
