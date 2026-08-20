import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowLeftIcon, EyeIcon, KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react"
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
import { Switch } from "@ui/base/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui/base/ui/tabs"
import { Textarea } from "@ui/base/ui/textarea"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import {
  ENV_TARGET_HINTS,
  ENV_TARGET_LABELS,
  ENV_TARGETS,
  type EnvTarget,
  type EnvVar,
  useDeleteEnvVar,
  useEnvVars,
  useRevealEnvVar,
  useSetEnvVar,
} from "@frontends/dashboard/data/env-vars"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/env")({
  component: ProjectEnvVars,
})

/** "All" first: it is where most variables belong, and the tab order should match that. */
const TAB_ORDER: readonly ("all" | EnvTarget)[] = [
  "all",
  "production",
  "preview",
  "development",
] as const

const TARGET_ITEMS = ENV_TARGETS.map((target) => ({
  label: ENV_TARGET_LABELS[target],
  value: target,
}))

function ProjectEnvVars() {
  const { orgSlug, projectId } = Route.useParams()
  const { data, isPending, isError, refetch } = useEnvVars(orgSlug, projectId)

  return (
    <>
      <PageHeader title="Environment variables" count={data?.length}>
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/orgs/$orgSlug/projects/$projectId" params={{ orgSlug, projectId }} />}
        >
          <ArrowLeftIcon />
          Project
        </Button>
        <EditDialog orgSlug={orgSlug} projectId={projectId} />
      </PageHeader>

      <PageBody>
        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Values are encrypted before they are stored and are never returned by the list. A variable
          set for a specific environment overrides the one set for all environments.
        </p>

        {isPending && <ListSkeleton rows={4} />}
        {isError && (
          <ListError
            title="Could not load environment variables"
            onRetry={() => {
              void refetch()
            }}
          />
        )}

        {data !== undefined && (
          <Tabs defaultValue="all">
            <TabsList>
              {TAB_ORDER.map((tab) => (
                <TabsTab key={tab} value={tab}>
                  {tab === "all" ? "All" : ENV_TARGET_LABELS[tab]}
                  <span className="ml-1.5 tnum font-mono text-[11px] text-muted-foreground">
                    {countFor(data, tab)}
                  </span>
                </TabsTab>
              ))}
            </TabsList>

            {TAB_ORDER.map((tab) => (
              <TabsPanel key={tab} value={tab} className="pt-4">
                {tab !== "all" && (
                  <p className="mb-3 text-xs text-muted-foreground">
                    {ENV_TARGET_HINTS[tab]} Includes variables set for all environments.
                  </p>
                )}
                <VarTable
                  orgSlug={orgSlug}
                  projectId={projectId}
                  rows={rowsFor(data, tab)}
                  showTarget={tab === "all"}
                />
              </TabsPanel>
            ))}
          </Tabs>
        )}
      </PageBody>
    </>
  )
}

/**
 * A tab shows what that environment would actually see: its own variables plus the `all`
 * fallbacks. Listing only the exact matches would make Production look empty for a project whose
 * variables are all set once, which is the common case.
 */
function rowsFor(rows: EnvVar[], tab: "all" | EnvTarget): EnvVar[] {
  if (tab === "all") return rows
  return rows.filter((row) => row.target === tab || row.target === "all")
}

function countFor(rows: EnvVar[], tab: "all" | EnvTarget): number {
  return rowsFor(rows, tab).length
}

function VarTable({
  orgSlug,
  projectId,
  rows,
  showTarget,
}: {
  orgSlug: string
  projectId: string
  rows: EnvVar[]
  showTarget: boolean
}) {
  if (rows.length === 0) {
    return (
      <EmptyState>
        <EmptyStateIcon>
          <KeyRoundIcon />
        </EmptyStateIcon>
        <EmptyStateTitle>No variables here yet</EmptyStateTitle>
        <EmptyStateDescription>
          Anything this app needs at runtime — a connection string, an API key, a feature flag.
        </EmptyStateDescription>
      </EmptyState>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="w-72">Value</TableHead>
          {showTarget && <TableHead className="hidden w-40 sm:table-cell">Environment</TableHead>}
          <TableHead className="hidden w-32 lg:table-cell">Updated</TableHead>
          <TableHead className="w-20" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-mono text-[13px]">{row.key}</TableCell>
            <TableCell>
              <ValueCell orgSlug={orgSlug} projectId={projectId} row={row} />
            </TableCell>
            {showTarget && (
              <TableCell className="hidden sm:table-cell">
                <Badge variant={row.target === "production" ? "outline" : "muted"}>
                  {ENV_TARGET_LABELS[row.target]}
                </Badge>
              </TableCell>
            )}
            <TableCell className="hidden text-[13px] text-muted-foreground lg:table-cell">
              {row.updatedLabel}
            </TableCell>
            <TableCell>
              <DeleteButton orgSlug={orgSlug} projectId={projectId} row={row} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * A revealed value lives in this component and nowhere else.
 *
 * Reveal is a POST that writes an audit row, so it is never cached and never prefetched — a
 * cached read would make the audit trail claim one look when there were five. Navigating away
 * unmounts the component and the plaintext goes with it.
 */
function ValueCell({
  orgSlug,
  projectId,
  row,
}: {
  orgSlug: string
  projectId: string
  row: EnvVar
}) {
  const { reveal, isPending } = useRevealEnvVar(orgSlug, projectId)
  const [value, setValue] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  if (value !== null) {
    return (
      <code className="block max-w-72 truncate font-mono text-[13px] text-foreground">{value}</code>
    )
  }

  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="font-mono text-[13px] text-muted-foreground">
        ••••••••
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={() => {
          setFailed(false)
          reveal(row.id)
            .then(setValue)
            .catch(() => {
              setFailed(true)
            })
        }}
      >
        <EyeIcon />
        <span className="sr-only">Reveal {row.key}</span>
      </Button>
      {failed && <span className="text-xs text-destructive">Could not decrypt</span>}
    </span>
  )
}

function DeleteButton({
  orgSlug,
  projectId,
  row,
}: {
  orgSlug: string
  projectId: string
  row: EnvVar
}) {
  const { deleteVar, isPending } = useDeleteEnvVar(orgSlug, projectId)

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            <Trash2Icon />
            <span className="sr-only">Delete {row.key}</span>
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {row.key}?</DialogTitle>
          <DialogDescription>
            The next deployment of this project will not have it. Nothing already running changes
            until it redeploys.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <DialogClose
            render={
              <Button
                variant="destructive"
                disabled={isPending}
                onClick={() => {
                  void deleteVar(row.id)
                }}
              >
                Delete
              </Button>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditDialog({ orgSlug, projectId }: { orgSlug: string; projectId: string }) {
  const { setVar, isPending } = useSetEnvVar(orgSlug, projectId)
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [target, setTarget] = useState<EnvTarget>("all")
  const [isSecret, setIsSecret] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Controlled, because Save is not a DialogClose: a rejected save has to leave the dialog open
  // with the typed value still in it, and only a successful one closes.
  const [open, setOpen] = useState(false)

  const reset = () => {
    setKey("")
    setValue("")
    setTarget("all")
    setIsSecret(true)
    setError(null)
  }

  const submit = () => {
    if (key.trim() === "") {
      setError("A name is required")
      return
    }
    setError(null)
    setVar({ key: key.trim(), value, target, isSecret })
      .then(() => {
        reset()
        setOpen(false)
      })
      .catch(() => {
        setError("Could not save that variable")
      })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Dismissing by backdrop, Escape, or the X should not leave a half-typed variable
        // waiting behind the button.
        if (!next) reset()
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon />
            Add variable
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an environment variable</DialogTitle>
          <DialogDescription>
            Saving a name that already exists for the same environment replaces its value.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="env-key">Name</Label>
            <Input
              id="env-key"
              className="font-mono"
              placeholder="DATABASE_URL"
              value={key}
              onChange={(event) => {
                setKey(event.target.value)
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="env-value">Value</Label>
            <Textarea
              id="env-value"
              className="font-mono"
              rows={3}
              value={value}
              onChange={(event) => {
                setValue(event.target.value)
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Environment</Label>
            <Select
              items={TARGET_ITEMS}
              value={target}
              onValueChange={(next) => {
                // Base UI can report a cleared selection as null. There is no "no environment",
                // so fall back to the default rather than storing an absent target.
                setTarget(next ?? "all")
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENV_TARGETS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ENV_TARGET_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{ENV_TARGET_HINTS[target]}</p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <div>
              <Label htmlFor="env-secret">Secret</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {/* Encryption is not the switch. Every value is encrypted; this only decides
                    whether the value is treated as sensitive in build logs and deploy output. */}
                Every value is encrypted either way. Secrets are also masked in build logs.
              </p>
            </div>
            <Switch
              id="env-secret"
              checked={isSecret}
              onCheckedChange={(next) => {
                setIsSecret(next)
              }}
            />
          </div>

          {error !== null && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button disabled={isPending} onClick={submit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
