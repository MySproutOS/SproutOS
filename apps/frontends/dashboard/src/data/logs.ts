import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
// The raw call, not an options factory: `useInfiniteQuery` builds its own query, and the generated
// `...Options` helpers are for `useQuery`.
import {
  getV1OrgsByOrgSlugProjectsByProjectIdLogs,
  getV1OrgsByOrgSlugProjectsByProjectIdLogsOtlp,
} from "@lib/api-client/generated/sdk.gen"
import {
  getV1OrgsByOrgSlugProjectsByProjectIdObservabilityOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdObservabilityQueryKey,
  postV1OrgsByOrgSlugProjectsByProjectIdObservabilityKeyMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

/**
 * The levels `levelOf()` derives from a runtime line.
 *
 * Exact matches rather than a severity floor. These are parsed out of whatever the customer's
 * program printed, so "error and above" would be asserting an ordering over strings we inferred —
 * and `platform` has no place in such an ordering at all: it is Lambda's own `START`/`END`/`REPORT`
 * bookkeeping, which a reader wants to isolate or hide, never to threshold.
 */
export const LOG_LEVELS = [
  { value: "", label: "All levels" },
  { value: "error", label: "Errors" },
  { value: "warn", label: "Warnings" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
  { value: "platform", label: "Platform" },
] as const

/** One line as the platform observed it. The nullable fields are populated on `REPORT` only. */
export type LogLine = {
  timestamp: string
  cursor: string
  level: string
  message: string
  requestId: string
  deploymentId: string
  durationMs: number | null
  billedMs: number | null
  memoryMb: number | null
  initMs: number | null
  coldStart: boolean | null
}

export type LogFilters = {
  search: string
  level: string
  windowMinutes: number
}

export const DEFAULT_FILTERS: LogFilters = {
  search: "",
  level: "",
  windowMinutes: 60,
}

/** The tone a level gets in the list. `--husk` is money only, so nothing here is amber. */
export function severityTone(level: string): "error" | "warn" | "info" | "debug" {
  if (level === "error" || level === "fatal") return "error"
  if (level === "warn") return "warn"
  if (level === "platform" || level === "debug" || level === "trace") return "debug"
  return "info"
}

/**
 * The trailing detail on a `REPORT` line, or nothing.
 *
 * Duration and memory are what a reader scans for after "did it work" — and `billedMs` is the one
 * that maps to what the invocation cost, which is why it is shown rather than left in the message
 * text it was parsed out of.
 */
export function invocationSummary(line: LogLine): string | null {
  if (line.durationMs === null && line.billedMs === null && line.memoryMb === null) return null
  const parts: string[] = []
  if (line.durationMs !== null) parts.push(`${line.durationMs.toFixed(1)} ms`)
  if (line.billedMs !== null) parts.push(`billed ${line.billedMs} ms`)
  if (line.memoryMb !== null) parts.push(`${line.memoryMb} MB`)
  if (line.coldStart === true) parts.push("cold start")
  return parts.join(" · ")
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
          ...(filters.level === "" ? {} : { level: filters.level }),
          ...(pageParam === undefined ? {} : { before: pageParam }),
        },
        throwOnError: true,
      })
      return response.data
    },
    getNextPageParam: (last) => last?.nextBefore ?? undefined,
  })
}

/** Which table the viewer is reading. Two sources, two shapes — see `OtlpLine`. */
export type LogSource = "runtime" | "otlp"

/** One record a customer's own OpenTelemetry exporter sent. */
export type OtlpLine = {
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

/**
 * OpenTelemetry severity numbers, in the bands the spec defines.
 *
 * A floor here, unlike the runtime level, and for the opposite reason: these numbers *are* an
 * ordering the spec defines, so "warning and above" means something exact. Runtime levels are
 * parsed out of whatever a program printed and have no such guarantee.
 */
export const SEVERITY_LEVELS = [
  { value: 0, label: "All levels" },
  { value: 5, label: "Debug and above" },
  { value: 9, label: "Info and above" },
  { value: 13, label: "Warning and above" },
  { value: 17, label: "Errors only" },
] as const

/** The tone an OTel severity gets. `--husk` is money only, so nothing here is amber. */
export function otlpTone(severityNumber: number): "error" | "warn" | "info" | "debug" {
  if (severityNumber >= 17) return "error"
  if (severityNumber >= 13) return "warn"
  if (severityNumber >= 9) return "info"
  return "debug"
}

export type OtlpFilters = {
  search: string
  minSeverity: number
  service: string
  windowMinutes: number
}

export const DEFAULT_OTLP_FILTERS: OtlpFilters = {
  search: "",
  minSeverity: 0,
  service: "",
  windowMinutes: 60,
}

/**
 * A page of OTLP records, from the table a customer's exporter writes into.
 *
 * A second hook against a second route rather than a `source` parameter on the first: the rows are
 * genuinely different — `trace_id` and attribute maps here, Lambda's billing fields there — and one
 * endpoint returning a union would make every caller narrow the type before it could read anything.
 */
export function useOtlpLogs(orgSlug: string, projectId: string, filters: OtlpFilters) {
  return useInfiniteQuery({
    queryKey: ["logs-otlp", orgSlug, projectId, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      // Fixed at query-build time, for the reason the runtime hook gives: a drifting `until` hides
      // lines written between two page fetches.
      const until = new Date().toISOString()
      const since = new Date(Date.now() - filters.windowMinutes * 60_000).toISOString()

      const response = await getV1OrgsByOrgSlugProjectsByProjectIdLogsOtlp({
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

/** A project's retention, usage, and — if it sends OTLP as well — its ingest endpoint. */
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
