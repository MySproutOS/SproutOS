import { QueryClient } from "@tanstack/react-query"
import { ErrorResponseT } from "@lib/api-client/generated/types.gen"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
    },
    mutations: {
      retry: 0,
      onError: (error) => {
        if ("error" in error) {
          const err = error as ErrorResponseT
          console.error(err.error.message)
        }
      },
    },
  },
})
