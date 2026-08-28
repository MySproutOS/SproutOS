import { createFileRoute } from "@tanstack/react-router"
import {
  CheckIcon,
  CopyIcon,
  DatabaseIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/base/ui/tooltip"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { credentialRotationGuidance } from "@frontends/dashboard/components/databases/credential-rotation"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import {
  type BackendService,
  FIRST_AVAILABLE_KIND,
  KIND_AVAILABLE,
  KIND_LABELS,
  SERVICE_KINDS,
  type ServiceKind,
  useBackendServices,
  useCreateBackendService,
  useDeleteBackendService,
  useRotateConnection,
} from "@frontends/dashboard/data/databases"
import { useProjects } from "@frontends/dashboard/data/projects"

export const Route = createFileRoute("/orgs/$orgSlug/databases")({
  component: DatabasesList,
})

const STATUS_VARIANTS: Record<string, "success" | "warning" | "outline" | "destructive"> = {
  active: "success",
  provisioning: "warning",
  suspended: "outline",
  deleting: "outline",
  error: "destructive",
}

function DatabasesList() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useBackendServices(orgSlug)

  return (
    <>
      <PageHeader title="Databases" count={data?.length}>
        <CreateDialog orgSlug={orgSlug} />
      </PageHeader>

      <PageBody>
        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          A database can stand on its own or belong to a project. Connection details are shown here;
          passwords are shown only once, when a database is created or its credential is rotated.
          There is no later View action because SproutOS does not keep a recoverable copy. If you
          lose the URI, rotate the credential to issue a replacement.
        </p>

        {isPending && <ListSkeleton rows={3} />}
        {isError && (
          <ListError
            title="Could not load databases"
            onRetry={() => {
              void refetch()
            }}
          />
        )}

        {data !== undefined && data.length === 0 && (
          <EmptyState>
            <EmptyStateIcon>
              <DatabaseIcon />
            </EmptyStateIcon>
            <EmptyStateTitle>No databases yet</EmptyStateTitle>
            <EmptyStateDescription>
              Spin one up and you get a connection URI straight away. Nothing else has to exist
              first.
            </EmptyStateDescription>
          </EmptyState>
        )}

        {data !== undefined && data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-28">Engine</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="hidden lg:table-cell">Host</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((service) => (
                <TableRow key={service.id}>
                  <TableCell>
                    <span className="font-medium">{service.name}</span>
                    {service.database !== null && (
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {service.database}
                      </span>
                    )}
                    {service.managedByOauthApp !== null && (
                      <span className="block text-[11px] text-muted-foreground">
                        Managed by {service.managedByOauthApp.name}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="muted">{KIND_LABELS[service.kind]}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[service.status] ?? "outline"}>
                      {service.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden font-mono text-[12px] text-muted-foreground lg:table-cell">
                    {service.host === null ? "—" : `${service.host}:${String(service.port)}`}
                  </TableCell>
                  <TableCell>
                    <RowActions orgSlug={orgSlug} service={service} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PageBody>
    </>
  )
}

function RowActions({ orgSlug, service }: { orgSlug: string; service: BackendService }) {
  const [uri, setUri] = useState<string | null>(null)

  return (
    <span className="flex items-center justify-end gap-1">
      <RotateButton orgSlug={orgSlug} service={service} onRotated={setUri} />
      <DeleteButton orgSlug={orgSlug} service={service} />

      {uri !== null && (
        <ConnectionDialog
          uri={uri}
          name={service.name}
          onClose={() => {
            setUri(null)
          }}
        />
      )}
    </span>
  )
}

function RotateButton({
  orgSlug,
  service,
  onRotated,
}: {
  orgSlug: string
  service: BackendService
  onRotated: (uri: string) => void
}) {
  const { rotate, isPending } = useRotateConnection(orgSlug)
  const { canRotate, tooltipCopy, tooltipId } = credentialRotationGuidance(service)

  return (
    <Dialog>
      <Tooltip>
        {canRotate ? (
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Rotate the credential for ${service.name}`}
                    aria-describedby={tooltipId}
                  >
                    <RefreshCwIcon />
                  </Button>
                }
              />
            }
          />
        ) : (
          <TooltipTrigger
            render={
              /* A disabled button cannot receive hover. Keeping the tooltip trigger on this
                 wrapper means the status explanation remains available while it provisions. */
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled
                  aria-label={`Rotate the credential for ${service.name}`}
                  aria-describedby={tooltipId}
                >
                  <RefreshCwIcon />
                </Button>
              </span>
            }
          />
        )}
        <TooltipContent className="max-w-72 leading-relaxed">
          <span id={tooltipId} role="tooltip">
            {tooltipCopy}
          </span>
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate the password for {service.name}?</DialogTitle>
          <DialogDescription>
            Your current connection URI stops working immediately. Anything still using it — a
            deployed app, a local script — will fail until you give it the new one. The replacement
            is shown only once, so copy it before closing.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <DialogClose
            render={
              <Button
                disabled={isPending}
                onClick={() => {
                  rotate(service.id)
                    .then(onRotated)
                    .catch(() => undefined)
                }}
              >
                Rotate and show URI
              </Button>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteButton({ orgSlug, service }: { orgSlug: string; service: BackendService }) {
  const { deleteService, isPending } = useDeleteBackendService(orgSlug)
  const [typed, setTyped] = useState("")

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) setTyped("")
      }}
    >
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            <Trash2Icon />
            <span className="sr-only">Delete {service.name}</span>
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {service.name}?</DialogTitle>
          <DialogDescription>
            The database and everything in it is destroyed. There is no undo and no backup to
            restore from.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          {/* Typing the name is friction on purpose: every other destructive action here is
              recoverable, and this one deletes a customer's data outright. */}
          <Label htmlFor={`confirm-${service.id}`}>
            Type <span className="font-mono">{service.name}</span> to confirm
          </Label>
          <Input
            id={`confirm-${service.id}`}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value)
            }}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <DialogClose
            render={
              <Button
                variant="destructive"
                disabled={isPending || typed !== service.name}
                onClick={() => {
                  void deleteService(service.id)
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

/** The only place a URI is ever on screen. Copy it or lose it. */
function ConnectionDialog({
  uri,
  name,
  onClose,
}: {
  uri: string
  name: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connection URI for {name}</DialogTitle>
          <DialogDescription>
            This contains the password and will not be shown again. Copy it before closing.
          </DialogDescription>
        </DialogHeader>
        <code className="block max-h-32 overflow-y-auto rounded-lg border border-border bg-soil-800 p-3 font-mono text-[12px] break-all">
          {uri}
        </code>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard
                .writeText(uri)
                .then(() => {
                  setCopied(true)
                })
                .catch(() => undefined)
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <DialogClose render={<Button>Done</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateDialog({ orgSlug }: { orgSlug: string }) {
  const { createService, isPending } = useCreateBackendService(orgSlug)
  const projects = useProjects(orgSlug)
  const attachableProjects = (projects.data ?? []).filter((project) => !project.isGroup)
  const [name, setName] = useState("")
  /*
    The first engine this deployment can actually deliver, rather than a hard-coded `postgres`.

    Naming one directly means the dialog opens on a disabled option the moment that engine stops
    being available — which is what happened to `postgres`, so the Create button was disabled on
    open and the reason for it was a line of small grey text below the select.
  */
  const [kind, setKind] = useState<ServiceKind>(FIRST_AVAILABLE_KIND)
  const [projectId, setProjectId] = useState("standalone")
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [uri, setUri] = useState<string | null>(null)
  const [createdName, setCreatedName] = useState("")

  const submit = () => {
    if (name.trim() === "") {
      setError("A name is required")
      return
    }
    setError(null)
    createService({
      name: name.trim(),
      kind,
      ...(projectId === "standalone" ? {} : { projectId }),
    })
      .then((connectionUri) => {
        // Captured before the field is cleared: the URI dialog names the database, and resetting
        // first made it say "your new database" for something the person had just named.
        setCreatedName(name.trim())
        setName("")
        setOpen(false)
        // Shown once, immediately. Nothing stores it, so losing this dialog means rotating it.
        setUri(connectionUri)
      })
      .catch(() => {
        setError(
          KIND_AVAILABLE[kind]
            ? "Could not create that database"
            : `${KIND_LABELS[kind]} is not available yet`,
        )
      })
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setError(null)
        }}
      >
        <DialogTrigger
          render={
            <Button size="sm">
              <PlusIcon />
              New database
            </Button>
          }
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New database</DialogTitle>
            <DialogDescription>
              You get a connection URI as soon as it is ready. It does not have to belong to a
              project.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="service-name">Name</Label>
              <Input
                id="service-name"
                placeholder="production"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Engine</Label>
              <Select
                items={SERVICE_KINDS.map((option) => ({
                  label: KIND_LABELS[option],
                  value: option,
                }))}
                value={kind}
                onValueChange={(next) => {
                  setKind(next ?? FIRST_AVAILABLE_KIND)
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_KINDS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {KIND_LABELS[option]}
                      {!KIND_AVAILABLE[option] && (
                        <span className="ml-1.5 text-muted-foreground">— coming soon</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!KIND_AVAILABLE[kind] && (
                <p className="text-xs text-muted-foreground">
                  {KIND_LABELS[kind]} is not available on this deployment yet.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Project</Label>
              <Select
                items={[
                  { label: "Standalone", value: "standalone" },
                  ...attachableProjects.map((project) => ({
                    label: project.name,
                    value: project.id,
                  })),
                ]}
                value={projectId}
                onValueChange={(next) => {
                  setProjectId(next ?? "standalone")
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standalone">Standalone</SelectItem>
                  {attachableProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Attaching writes the connection settings into that project's environment.
              </p>
            </div>

            {error !== null && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button disabled={isPending || !KIND_AVAILABLE[kind]} onClick={submit}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {uri !== null && (
        <ConnectionDialog
          uri={uri}
          name={createdName}
          onClose={() => {
            setUri(null)
          }}
        />
      )}
    </>
  )
}
