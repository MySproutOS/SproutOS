import { createFileRoute } from "@tanstack/react-router"
import {
  CheckIcon,
  CopyIcon,
  DatabaseIcon,
  EyeIcon,
  GitBranchIcon,
  Globe2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import { useState } from "react"
import { Badge } from "@ui/base/ui/badge"
import { Alert, AlertDescription } from "@ui/base/ui/alert"
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
  useCreateDatabaseBranch,
  useDeleteBackendService,
  useDeleteDatabaseBranch,
  useDatabaseBranches,
  parseObjectStorageConnection,
  useObjectStorageAccess,
  useRotateConnection,
  useRotateDatabaseBranch,
  useViewObjectStorageConnection,
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
          A data service can stand on its own or belong to a project. Most passwords are shown only
          when created or rotated because SproutOS stores only their hash. Object-storage keys are
          derived from a platform root key, so an interactive owner can safely view the current S3
          connection again without rotating it.
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
                    {service.publicRead !== null && (
                      <span className="block text-[11px] text-muted-foreground">
                        {service.publicRead ? "Public reads enabled" : "Private by default"}
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
      {service.kind === "postgres" && service.status === "active" && (
        <BranchesButton orgSlug={orgSlug} service={service} />
      )}
      <RotateButton orgSlug={orgSlug} service={service} onRotated={setUri} />
      {service.kind === "object_storage" && service.status === "active" && (
        <>
          <PublicAccessButton orgSlug={orgSlug} service={service} />
          <ViewObjectStorageButton orgSlug={orgSlug} service={service} onViewed={setUri} />
        </>
      )}
      <DeleteButton orgSlug={orgSlug} service={service} />

      {uri !== null && (
        <ConnectionDialog
          uri={uri}
          name={service.name}
          kind={service.kind}
          onClose={() => {
            setUri(null)
          }}
        />
      )}
    </span>
  )
}

function PublicAccessButton({ orgSlug, service }: { orgSlug: string; service: BackendService }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { setPublicRead, isPending } = useObjectStorageAccess(orgSlug)
  const enabled = service.publicRead === true

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button variant="ghost" size="sm">
                  <Globe2Icon />
                  <span className="sr-only">Public access for {service.name}</span>
                </Button>
              }
            />
          }
        />
        <TooltipContent>{enabled ? "Disable public reads" : "Enable public reads"}</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {enabled ? "Make objects private by default?" : "Enable public reads?"}
          </DialogTitle>
          <DialogDescription>
            {enabled
              ? "Objects without an explicit public-read override will stop being anonymously readable."
              : "Every object without an explicit private override will be readable by anyone who knows its URL."}
          </DialogDescription>
        </DialogHeader>
        {!enabled && (
          <Alert>
            <AlertDescription>
              Public URLs are bearer-free and may be copied or cached. Disabling this setting cannot
              revoke copies that were already downloaded.
            </AlertDescription>
          </Alert>
        )}
        {error !== null && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            variant={enabled ? "outline" : "default"}
            disabled={isPending}
            onClick={() => {
              setError(null)
              setPublicRead(service.id, !enabled)
                .then(() => {
                  setOpen(false)
                })
                .catch(() => {
                  setError("Could not update public access")
                })
            }}
          >
            {enabled ? "Make private by default" : "Enable public reads"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BranchesButton({ orgSlug, service }: { orgSlug: string; service: BackendService }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [parentId, setParentId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const branches = useDatabaseBranches(orgSlug, service.id, open)
  const { createBranch, isPending: isCreating } = useCreateDatabaseBranch(orgSlug, service.id)
  const { rotateBranch, isPending: isRotating } = useRotateDatabaseBranch(orgSlug, service.id)
  const { deleteBranch, isPending: isDeleting } = useDeleteDatabaseBranch(orgSlug, service.id)
  const active = branches.data?.data ?? []
  const selectedParentId = parentId || active[0]?.id || ""

  const submit = () => {
    if (name.trim() === "" || selectedParentId === "") return
    setError(null)
    createBranch(name.trim(), selectedParentId)
      .then((created) => {
        setName("")
        setParentId(created.id)
        setUri(created.connectionUri)
      })
      .catch(() => {
        setError("Could not create that branch")
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
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Manage branches for ${service.name}`}
                  >
                    <GitBranchIcon />
                  </Button>
                }
              />
            }
          />
          <TooltipContent>Create, connect to, and delete Postgres branches.</TooltipContent>
        </Tooltip>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Branches for {service.name}</DialogTitle>
            <DialogDescription>
              Branches are copy-on-write databases retained until you delete them. A connection URI
              is shown only when a branch is created or its credential is rotated.
            </DialogDescription>
          </DialogHeader>

          {branches.isPending && <ListSkeleton rows={2} />}
          {branches.isError && (
            <ListError
              title="Could not load branches"
              onRetry={() => {
                void branches.refetch()
              }}
            />
          )}
          {branches.data !== undefined && (
            <div className="flex flex-col gap-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {active.map((branch) => (
                    <TableRow key={branch.id}>
                      <TableCell>
                        <span className="font-medium">{branch.name}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {branch.kind === "user" ? "Persistent" : branch.kind}
                        </span>
                      </TableCell>
                      <TableCell className="text-[12px] text-muted-foreground">
                        {active.find((candidate) => candidate.id === branch.parentDatabaseBranchId)
                          ?.name ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isRotating}
                            aria-label={`Rotate the credential for ${branch.name}`}
                            onClick={() => {
                              rotateBranch(branch.id)
                                .then(setUri)
                                .catch(() => undefined)
                            }}
                          >
                            <RefreshCwIcon />
                          </Button>
                          {!branch.isProtected && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isDeleting}
                              aria-label={`Delete ${branch.name}`}
                              onClick={() => {
                                deleteBranch(branch.id).catch(() => {
                                  setError("Delete its child branches first")
                                })
                              }}
                            >
                              <Trash2Icon />
                            </Button>
                          )}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`branch-name-${service.id}`}>New branch name</Label>
                  <Input
                    id={`branch-name-${service.id}`}
                    placeholder="feature-checkout"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Branch from</Label>
                  <Select
                    items={active.map((branch) => ({ label: branch.name, value: branch.id }))}
                    value={selectedParentId}
                    onValueChange={(next) => {
                      setParentId(next ?? "")
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {active.map((branch) => (
                        <SelectItem key={branch.id} value={branch.id}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {error !== null && (
                  <p className="text-xs text-destructive sm:col-span-2">{error}</p>
                )}
                <Button
                  className="sm:col-span-2"
                  disabled={isCreating || name.trim() === "" || selectedParentId === ""}
                  onClick={submit}
                >
                  <PlusIcon />
                  Create branch and show URI
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {uri !== null && (
        <ConnectionDialog
          uri={uri}
          name={`${service.name} branch`}
          kind="postgres"
          onClose={() => {
            setUri(null)
          }}
        />
      )}
    </>
  )
}

function ViewObjectStorageButton({
  orgSlug,
  service,
  onViewed,
}: {
  orgSlug: string
  service: BackendService
  onViewed: (uri: string) => void
}) {
  const { view, clear, isPending } = useViewObjectStorageConnection(orgSlug, service.id)
  const enabled = service.status === "active"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="sm"
              disabled={!enabled || isPending}
              aria-label={`View the S3 connection for ${service.name}`}
              onClick={() => {
                view()
                  .then((uri) => {
                    onViewed(uri)
                    clear()
                  })
                  .catch(() => undefined)
              }}
            >
              <EyeIcon />
            </Button>
          </span>
        }
      />
      <TooltipContent className="max-w-72 leading-relaxed">
        {enabled
          ? "View the current endpoint, bucket, access key, and secret without rotating them."
          : "Connection details are available after this storage service becomes active."}
      </TooltipContent>
    </Tooltip>
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
            {service.kind === "object_storage"
              ? "can be viewed again by an interactive owner."
              : "is shown only once, so copy it before closing."}
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
            {service.kind === "object_storage" ? "The storage service" : "The database"} and
            everything in it is destroyed. There is no undo and no backup to restore from.
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
  kind,
  onClose,
}: {
  uri: string
  name: string
  kind: ServiceKind
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const storage = kind === "object_storage" ? parseObjectStorageConnection(uri) : null

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
            {storage === null
              ? "This contains the password and will not be shown again. Copy it before closing."
              : "Use these values with an ordinary AWS S3 SDK. Keep the access key and secret private; you can view this derived credential again later."}
          </DialogDescription>
        </DialogHeader>
        {storage !== null && (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 rounded-lg border border-border bg-soil-800 p-3 text-[12px]">
            {[
              ["Endpoint", storage.endpoint],
              ["Port", String(storage.port)],
              ["Bucket", storage.bucket],
              ["Region", storage.region],
              ["Access key ID", storage.accessKeyId],
              ["Secret access key", storage.secretAccessKey],
              ["Path-style", storage.forcePathStyle ? "Required" : "Not required"],
            ].map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-all font-mono">{value}</dd>
              </div>
            ))}
          </dl>
        )}
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
  const [publicRead, setPublicRead] = useState(false)
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
      ...(kind === "object_storage" ? { publicRead } : {}),
    })
      .then((connectionUri) => {
        // Captured before the field is cleared: the URI dialog names the database, and resetting
        // first made it say "your new database" for something the person had just named.
        setCreatedName(name.trim())
        setName("")
        setPublicRead(false)
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
              {kind === "object_storage" && (
                <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="storage-public-read">Public reads</Label>
                    <p className="text-xs text-muted-foreground">
                      Allow plain object URLs unless an object is explicitly private.
                    </p>
                  </div>
                  <Switch
                    id="storage-public-read"
                    checked={publicRead}
                    onCheckedChange={setPublicRead}
                  />
                </div>
              )}
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
          kind={kind}
          onClose={() => {
            setUri(null)
          }}
        />
      )}
    </>
  )
}
