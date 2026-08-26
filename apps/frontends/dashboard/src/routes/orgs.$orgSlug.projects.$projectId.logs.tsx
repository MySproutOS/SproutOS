import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowLeftIcon, KeyRoundIcon, ScrollTextIcon, SearchIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ui/base/ui/dialog"
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/base/ui/select"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import {
  DEFAULT_FILTERS,
  DEFAULT_OTLP_FILTERS,
  LOG_LEVELS,
  formatBytes,
  invocationSummary,
  type LogSource,
  logTime,
  type OtlpFilters,
  type OtlpLine,
  otlpTone,
  SEVERITY_LEVELS,
  severityTone,
  useOtlpLogs,
  useLogs,
  useObservabilityStream,
  useRotateIngestKey,
  type LogFilters,
  type LogLine,
} from "@frontends/dashboard/data/logs"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/logs")({
  component: ProjectLogs,
})

const WINDOWS = [
  { value: 15, label: "Last 15 minutes" },
  { value: 60, label: "Last hour" },
  { value: 360, label: "Last 6 hours" },
  { value: 1440, label: "Last 24 hours" },
  { value: 10080, label: "Last 7 days" },
] as const

/*
  The trigger has to render the *label*, not the value.

  `SelectValue` with no children shows whatever the value is, so the controls read "0", "60" and
  "__all" — three dropdowns nobody can make sense of. Passing a render function is explicit about
  the mapping rather than relying on Base UI matching an `items` array against the current value.
*/
const LEVEL_LABELS = new Map(LOG_LEVELS.map((level) => [level.value, level.label]))
const SEVERITY_LABELS = new Map(SEVERITY_LEVELS.map((l) => [String(l.value), l.label]))
const WINDOW_LABELS = new Map(WINDOWS.map((window) => [String(window.value), window.label]))

function labelFor(labels: Map<string, string>, value: unknown): string {
  return labels.get(String(value)) ?? String(value)
}

/** Colour per severity band. Amber is `--husk` and means money, so warnings borrow nothing from it. */
const TONE_CLASS: Record<ReturnType<typeof severityTone>, string> = {
  error: "text-destructive",
  warn: "text-orange-400",
  info: "text-foreground",
  debug: "text-muted-foreground",
}

function ProjectLogs() {
  const { orgSlug, projectId } = Route.useParams()
  const [filters, setFilters] = useState<LogFilters>(DEFAULT_FILTERS)
  // The box is separate from the applied filter so typing does not fire a query per keystroke.
  const [searchDraft, setSearchDraft] = useState("")

  /*
    Which table is being read.

    Runtime is the default because it is the one that fills by itself: a project's own output goes
    to it whether or not anybody configured anything. OpenTelemetry is the opt-in source, and it is
    empty until somebody points an exporter at it — which is why the ingest key lives on that tab
    rather than in the page header, where it invited people to configure something they did not
    need in order to see logs they already had.
  */
  const [source, setSource] = useState<LogSource>("runtime")
  const [otlpFilters, setOtlpFilters] = useState<OtlpFilters>(DEFAULT_OTLP_FILTERS)

  const stream = useObservabilityStream(orgSlug, projectId)
  const logs = useLogs(orgSlug, projectId, filters)
  const otlp = useOtlpLogs(orgSlug, projectId, otlpFilters)

  const lines: LogLine[] = (logs.data?.pages ?? []).flatMap(
    (page) => (page?.lines ?? []) as LogLine[],
  )
  const otlpLines: OtlpLine[] = (otlp.data?.pages ?? []).flatMap(
    (page) => (page?.lines ?? []) as OtlpLine[],
  )

  // Whichever source is showing owns the loading, error and paging state below.
  const active = source === "runtime" ? logs : otlp
  const activeCount = source === "runtime" ? lines.length : otlpLines.length
  const configured = (stream.data?.streamId ?? null) !== null

  return (
    <>
      <PageHeader title="Logs">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            render={
              <Link to="/orgs/$orgSlug/projects/$projectId" params={{ orgSlug, projectId }} />
            }
          >
            <ArrowLeftIcon className="size-4" />
            Project
          </Button>
          {source === "otlp" ? (
            <IngestKeyDialog orgSlug={orgSlug} projectId={projectId} configured={configured} />
          ) : null}
        </div>
      </PageHeader>
      <PageBody>
        {/*
          Two sources, named for where the logs come from rather than for the technology.

          "Runtime" is what the project printed; "OpenTelemetry" is what its exporter sent. Somebody
          who has never heard of OTel needs to recognise the first one immediately, and somebody who
          has will find the second exactly where they expect.
        */}
        <div className="mb-3 flex items-center gap-1 rounded-md border border-border p-1 w-fit">
          <Button
            size="sm"
            variant={source === "runtime" ? "default" : "ghost"}
            onClick={() => {
              setSource("runtime")
            }}
          >
            Runtime
          </Button>
          <Button
            size="sm"
            variant={source === "otlp" ? "default" : "ghost"}
            onClick={() => {
              setSource("otlp")
            }}
          >
            OpenTelemetry
          </Button>
        </div>

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (source === "runtime") {
              setFilters((current) => ({ ...current, search: searchDraft.trim() }))
            } else {
              setOtlpFilters((current) => ({ ...current, search: searchDraft.trim() }))
            }
          }}
        >
          <div className="min-w-[16rem] flex-1">
            <Label htmlFor="log-search" className="sr-only">
              Search
            </Label>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="log-search"
                value={searchDraft}
                onChange={(event) => {
                  setSearchDraft(event.target.value)
                }}
                placeholder="Search message text"
                className="pl-8"
              />
            </div>
          </div>

          {source === "runtime" ? (
            <Select
              value={filters.level}
              onValueChange={(value) => {
                setFilters((current) => ({
                  ...current,
                  level: value === null ? "" : String(value),
                }))
              }}
            >
              <SelectTrigger className="w-[13rem]">
                <SelectValue>{(value) => labelFor(LEVEL_LABELS, value)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LOG_LEVELS.map((level) => (
                  <SelectItem key={level.value} value={level.value}>
                    {level.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            /*
              A severity *floor* for OTLP, where the runtime source has an exact level.

              The difference is not cosmetic: OTel severity numbers are an ordering the spec
              defines, so "warning and above" is exact. Runtime levels are parsed out of whatever a
              program printed, so the same control there would assert an ordering we inferred.
            */
            <Select
              value={String(otlpFilters.minSeverity)}
              onValueChange={(value) => {
                setOtlpFilters((current) => ({ ...current, minSeverity: Number(value ?? 0) }))
              }}
            >
              <SelectTrigger className="w-[13rem]">
                <SelectValue>{(value) => labelFor(SEVERITY_LABELS, value)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_LEVELS.map((level) => (
                  <SelectItem key={level.value} value={String(level.value)}>
                    {level.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select
            value={String(source === "runtime" ? filters.windowMinutes : otlpFilters.windowMinutes)}
            onValueChange={(value) => {
              const minutes = Number(value ?? 60)
              if (source === "runtime") {
                setFilters((current) => ({ ...current, windowMinutes: minutes }))
              } else {
                setOtlpFilters((current) => ({ ...current, windowMinutes: minutes }))
              }
            }}
          >
            <SelectTrigger className="w-[11rem]">
              <SelectValue>{(value) => labelFor(WINDOW_LABELS, value)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((window) => (
                <SelectItem key={window.value} value={String(window.value)}>
                  {window.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/*
            No service filter.

            `service_name` is an OpenTelemetry field and belongs to `log_record`, the table a
            customer's own exporter writes into. These lines are one function's output — there is
            no second service to pick between — so the dropdown was markup that could never render
            for the data this page now shows.
          */}

          <Button type="submit" size="sm">
            Search
          </Button>
        </form>

        {stream.data !== undefined ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {stream.data.usage.records.toLocaleString()} records ·{" "}
            {formatBytes(stream.data.usage.bytes)} · kept {stream.data.retentionDays} days
          </p>
        ) : null}

        <div className="mt-4">
          {active.isPending ? <ListSkeleton rows={8} /> : null}
          {active.isError ? <ListError onRetry={() => void active.refetch()} /> : null}

          {/*
            The empty state says something true of the source being shown.

            It used to key on `configured` — whether an OTLP ingest key had been issued — and tell
            everybody to "point an OpenTelemetry exporter at this project". That was right when this
            page only ever read the OTel table. Against runtime logs it is advice for a different
            feature: nothing needs pointing anywhere, the project's own output arrives by itself,
            and what is actually missing is a deployment that ran.
          */}
          {!active.isPending && !active.isError && activeCount === 0 ? (
            <EmptyState className="my-6">
              <EmptyStateIcon>
                <ScrollTextIcon className="size-[26px] text-primary" />
              </EmptyStateIcon>
              <EmptyStateTitle>
                {source === "runtime"
                  ? "No logs in this window"
                  : configured
                    ? "No records in this window"
                    : "Nothing sent yet"}
              </EmptyStateTitle>
              <EmptyStateDescription>
                {source === "runtime"
                  ? "Widen the time range, or clear the filters. A deployed project logs whatever it prints — nothing to set up."
                  : configured
                    ? "Widen the time range, or clear the filters."
                    : "Get an ingest key and point an OpenTelemetry exporter at this project."}
              </EmptyStateDescription>
            </EmptyState>
          ) : null}

          {source === "runtime" && lines.length > 0 ? (
            <div className="rule-soft overflow-hidden rounded-md border">
              {/*
                A list of monospaced rows rather than a table.

                A log body is arbitrary length and a table cell either truncates it or makes every
                other column jump. Rows that wrap keep the timestamp column aligned and let the
                message be as long as it is.
              */}
              <ul className="divide-y divide-border">
                {lines.map((line) => (
                  <li
                    key={`${line.cursor}-${line.message.slice(0, 24)}`}
                    className="flex gap-3 px-3 py-1.5 font-mono text-xs"
                  >
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {logTime(line.timestamp)}
                    </span>
                    <span
                      className={`w-14 shrink-0 uppercase ${TONE_CLASS[severityTone(line.level)]}`}
                    >
                      {line.level === "" ? "—" : line.level}
                    </span>
                    {/*
                      The last eight characters of the request id, not the whole thing.

                      A full uuid is 36 characters of noise on every row; the tail is enough to see
                      that two lines belong to the same invocation, which is the only thing this
                      column is read for. Blank where Lambda did not attach one — see
                      `requestIdOf`, which leaves it empty rather than inventing a placeholder that
                      would group unrelated lines together.
                    */}
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {line.requestId === "" ? "" : line.requestId.slice(-8)}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                      {line.message}
                      {invocationSummary(line) === null ? null : (
                        <span className="ml-2 text-muted-foreground">
                          {invocationSummary(line)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {source === "otlp" && otlpLines.length > 0 ? (
            <div className="rule-soft overflow-hidden rounded-md border">
              <ul className="divide-y divide-border">
                {otlpLines.map((line) => (
                  <li
                    key={`${line.cursor}-${line.body.slice(0, 24)}`}
                    className="flex gap-3 px-3 py-1.5 font-mono text-xs"
                  >
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {logTime(line.timestamp)}
                    </span>
                    <span
                      className={`w-14 shrink-0 uppercase ${TONE_CLASS[otlpTone(line.severityNumber)]}`}
                    >
                      {line.severityText === "" ? "—" : line.severityText}
                    </span>
                    {/* The emitting service, which is the column OTel has and runtime logs do not:
                        one project can send from several. */}
                    {line.serviceName === "" ? null : (
                      <span className="shrink-0 text-muted-foreground">{line.serviceName}</span>
                    )}
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                      {line.body}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {active.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={logs.isFetchingNextPage}
              onClick={() => void logs.fetchNextPage()}
            >
              {logs.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          ) : null}
        </div>
      </PageBody>
    </>
  )
}

/**
 * Issuing and rotating the ingest key.
 *
 * The key is shown once and never fetched again — it is stored as a one-way hash, so there is no
 * route that could return it. The dialog says so, because a user who assumes they can come back for
 * it later will not write it down.
 */
function IngestKeyDialog(props: { orgSlug: string; projectId: string; configured: boolean }) {
  const [issued, setIssued] = useState<string | null>(null)
  const rotate = useRotateIngestKey(props.orgSlug, props.projectId)
  const stream = useObservabilityStream(props.orgSlug, props.projectId)

  return (
    <Dialog
      onOpenChange={(open) => {
        // Cleared on close so a credential does not sit in component state for the session.
        if (!open) setIssued(null)
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <KeyRoundIcon className="size-4" />
            {props.configured ? "Rotate key" : "Get ingest key"}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.configured ? "Rotate the ingest key" : "Ingest key"}</DialogTitle>
          <DialogDescription>
            {props.configured
              ? "The current key stops working the moment this is issued. Every exporter you have deployed will need the new one."
              : "Point your OpenTelemetry exporter at this endpoint with the key as a bearer token."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Endpoint</Label>
            <p className="rule-soft mt-1 break-all rounded-md border px-2 py-1.5 font-mono text-xs">
              {stream.data?.endpoint ?? "—"}
            </p>
          </div>

          {issued === null ? null : (
            <div>
              <Label className="text-xs text-muted-foreground">
                Key — copy it now, it is not shown again
              </Label>
              <p className="rule-soft mt-1 break-all rounded-md border px-2 py-1.5 font-mono text-xs">
                {issued}
              </p>
              <Badge variant="outline" className="mt-2">
                Stored hashed. Rotating is the only way to replace it.
              </Badge>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost">Close</Button>} />
          <Button
            disabled={rotate.isPending}
            onClick={() => {
              rotate.mutate(
                { path: { orgSlug: props.orgSlug, projectId: props.projectId }, body: {} },
                {
                  onSuccess: (data) => {
                    setIssued(data.key)
                  },
                },
              )
            }}
          >
            {rotate.isPending ? "Issuing…" : props.configured ? "Rotate" : "Issue key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
