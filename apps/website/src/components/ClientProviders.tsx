"use client"

import { QueryClientProvider } from "@tanstack/react-query"
import { queryClient } from "@website/services/api"
import { useState } from "react"

export function ClientProviders({ children }: Readonly<{ children: React.ReactNode }>) {
  const [stateQueryClient] = useState(() => queryClient)

  return <QueryClientProvider client={stateQueryClient}>{children}</QueryClientProvider>
}
