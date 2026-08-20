import { useQuery, type UseQueryResult } from "@tanstack/react-query"

/*
  ============================================================================
  PLACEHOLDER — every hook in `src/data/` is backed by this and by nothing else.
  ============================================================================

  The organization, project, billing, and store endpoints do not exist in
  `@lib/api-client` yet. Rather than hand-write a parallel API client, each hook
  declares the query key and the response shape it expects and resolves a fixture
  through `usePlaceholderQuery`.

  To swap one over when the generated client lands: replace the hook body with
  `useQuery(getV1...Options(...))` and delete its fixture. The call sites do not
  change, because they only ever see `{ data, isPending, isError }`.

  `grep -rn "usePlaceholderQuery" src/data` lists everything still unwired.
*/

/** Long enough that the skeleton and error states are actually exercised in dev. */
const PLACEHOLDER_LATENCY_MS = 220

export function usePlaceholderQuery<TData>(
  queryKey: readonly unknown[],
  data: TData,
): UseQueryResult<TData> {
  return useQuery({
    queryKey,
    queryFn: () =>
      new Promise<TData>((resolve) => {
        setTimeout(() => {
          resolve(data)
        }, PLACEHOLDER_LATENCY_MS)
      }),
    staleTime: Number.POSITIVE_INFINITY,
  })
}
