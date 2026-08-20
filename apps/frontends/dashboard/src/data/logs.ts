import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
// The raw call, not an options factory: `useInfiniteQuery` builds its own query, and the generated
// `...Options` helpers are for `useQuery`.
import { getV1OrgsByOrgSlugProjectsByProjectIdLogs } from "@lib/api-client/generated/sdk.gen"
import {
  getV1OrgsByOrgSlugProjectsByProjectIdObservabilityOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdObservabilityQueryKey,
  postV1OrgsByOrgSlugProjectsByProjectIdObservabilityKeyMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

/**
 * OpenTelemetry severity numbers, in the bands the spec defines.
 *
 * The *number* is what is filtered on, not the text, because the text is whatever the customer's
 * logger emitted — `warn`, `WARNING`, `W` — and a filter matching strings would miss most of it.
 */
export const SEVERITY_LEVELS = [
  { value: 0, label: "All levels" },
  { value: 5, label: "Debug and above" },
  { value: 9, label: "Info and above" },
  { value: 13, label: "Warning and above" },
  { value: 17, label: "Errors only" },
] as const

export type LogLine = {
  timestamp: string
  cursor: string
  severityNumber: number
  severityText: string
  body: string
  serviceName: string
  scopeName: string
  traceId: string
  spanId: string
  attributes: Record<string, string>
}

export type LogFilters = {
  search: string
  minSeverity: number
  service: string
  windowMinutes: number
}

export const DEFAULT_FILTERS: LogFilters = {
  search: "",
  minSeverity: 0,
  service: "",
  windowMinutes: 60,
}

/** The tone a severity gets in the list. `--husk` is money only, so nothing here is amber. */
export function severityTone(severityNumber: number): "error" | "warn" | "info" | "debug" {
  if (severityNumber >= 17) return "error"
  if (severityNumber >= 13) return "warn"
  if (severityNumber >= 9) return "info"
  return "debug"
}

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

/**
 * The timestamp as shown in the list.
 *
 * Time only, with the milliseconds kept: a log page is almost always read within one day, and the
 * ordering of two lines a few milliseconds apart is the thing a person is actually looking for.
 */
export function logTime(timestamp: string): string {
  const date = new Date(timestamp)
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0")
  return `${TIME_FORMAT.format(date)}.${milliseconds}`
}

/**
 * A page of logs, newest first, paged by the cursor the API hands back.
 *
 * `useInfiniteQuery` rather than an offset page: the store is append-mostly and new lines arrive
 * while the page is open, so a numbered offset would shift under the reader and show them the same
 * line twice. A keyset cursor on the timestamp cannot.
 */
export function useLogs(orgSlug: string, projectId: string, filters: LogFilters) {
  return useInfiniteQuery({
    queryKey: ["logs", orgSlug, projectId, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      /*
        `until` is fixed at the moment the query is built, not at the moment each page is fetched.

        Letting it drift to "now" per page would mean a line written between two fetches lands in a
        range the reader has already scrolled past, and never appears at all.
      */
      const until = new Date().toISOString()
      const since = new Date(Date.now() - filters.windowMinutes * 60_000).toISOString()

      const response = await getV1OrgsByOrgSlugProjectsByProjectIdLogs({
        path: { orgSlug, projectId },
        query: {
          since,
          until,
          limit: "100",
          ...(filters.search === "" ? {} : { search: filters.search }),
          ...(filters.minSeverity === 0 ? {} : { minSeverity: String(filters.minSeverity) }),
          ...(filters.service === "" ? {} : { service: filters.service }),
          ...(pageParam === undefined ? {} : { before: pageParam }),
        },
        throwOnError: true,
      })
      return response.data
    },
    getNextPageParam: (last) => last?.nextBefore ?? undefined,
  })
}

/** A project's ingest endpoint, retention, usage, and the services it has sent from. */
export function useObservabilityStream(orgSlug: string, projectId: string) {
  return useQuery(
    getV1OrgsByOrgSlugProjectsByProjectIdObservabilityOptions({ path: { orgSlug, projectId } }),
  )
}

/**
 * Issues or rotates the ingest key.
 *
 * The key comes back exactly once and is never stored here — the caller shows it and forgets it.
 * Caching it in the query client would put a live credential in memory for the rest of the session
 * and, with devtools open, on screen.
 */
export function useRotateIngestKey(orgSlug: string, projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postV1OrgsByOrgSlugProjectsByProjectIdObservabilityKeyMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsByProjectIdObservabilityQueryKey({
          path: { orgSlug, projectId },
        }),
      })
    },
  })
}

/** Bytes, for the usage line. Not money, so no `--husk`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
