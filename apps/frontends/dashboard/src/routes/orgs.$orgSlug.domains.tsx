import { createFileRoute } from "@tanstack/react-router"
import {
  CalendarClockIcon,
  CheckIcon,
  CopyIcon,
  GlobeLockIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@ui/base/ui/alert"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@ui/base/ui/card"
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
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/base/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/base/ui/tooltip"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import {
  CUSTOM_DOMAIN_STATUS_LABELS,
  customDomainMutationErrorMessage,
  eligibleCustomDomainProjects,
  type CustomDomain,
  type CustomDomainStatus,
  useCheckCustomDomain,
  useCreateCustomDomain,
  useCustomDomains,
  useDeleteCustomDomain,
} from "@frontends/dashboard/data/custom-domains"
import { useProjects } from "@frontends/dashboard/data/projects"

export const Route = createFileRoute("/orgs/$orgSlug/domains")({
  component: CustomDomains,
})

const STATUS_VARIANTS: Record<
  CustomDomainStatus,
  "success" | "warning" | "outline" | "destructive" | "muted"
> = {
  pending_dns: "warning",
  issuing: "warning",
  propagating: "warning",
  active: "success",
  renewal_warning: "warning",
  failed: "destructive",
  deleting: "muted",
}

const DATE = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
})

function formatDate(value: Date | string | null): string {
  return value === null ? "—" : DATE.format(new Date(value))
}

function CustomDomains() {
  const { orgSlug } = Route.useParams()
  const domains = useCustomDomains(orgSlug)

  return (
    <>
      <PageHeader title="Custom domains" count={domains.data?.data.length}>
        <CreateDomainDialog orgSlug={orgSlug} />
      </PageHeader>
      <PageBody>
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
          Point a hostname you own at a deployed project. SproutOS checks both DNS records and
          provisions and renews its HTTPS certificate automatically.
        </p>

        {domains.isPending ? <ListSkeleton rows={3} /> : null}
        {domains.isError ? (
          <ListError
            title="Could not load custom domains"
            onRetry={() => {
              void domains.refetch()
            }}
          />
        ) : null}

        {domains.data?.data.length === 0 ? (
          <EmptyState className="my-6">
            <EmptyStateIcon>
              <GlobeLockIcon />
            </EmptyStateIcon>
            <EmptyStateTitle>No custom domains yet</EmptyStateTitle>
            <EmptyStateDescription>
              Add a hostname, publish the DNS records shown here, and SproutOS will turn on HTTPS.
            </EmptyStateDescription>
            <EmptyStateActions>
              <CreateDomainDialog orgSlug={orgSlug} />
            </EmptyStateActions>
          </EmptyState>
        ) : null}

        <div className="mt-2 grid gap-4 xl:grid-cols-2">
          {domains.data?.data.map((domain) => (
            <DomainCard key={domain.id} orgSlug={orgSlug} domain={domain} />
          ))}
        </div>
      </PageBody>
    </>
  )
}

function CreateDomainDialog({ orgSlug }: { orgSlug: string }) {
  const projects = useProjects(orgSlug)
  const create = useCreateCustomDomain(orgSlug)
  const eligibleProjects = eligibleCustomDomainProjects(projects.data ?? [])
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState("")
  const [hostname, setHostname] = useState("")
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setProjectId("")
    setHostname("")
    setError(null)
  }

  const submit = () => {
    const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "")
    if (projectId === "") {
      setError("Choose a deployed project")
      return
    }
    if (normalizedHostname === "") {
      setError("Enter the hostname you want to use")
      return
    }
    setError(null)
    create.mutate(
      { path: { orgSlug, projectId }, body: { hostname: normalizedHostname } },
      {
        onSuccess: () => {
          setOpen(false)
          reset()
        },
        onError: (mutationError) => {
          setError(customDomainMutationErrorMessage(mutationError))
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon />
            Add domain
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a custom domain</DialogTitle>
          <DialogDescription>
            Choose the deployed project this exact hostname should serve. Add www separately if you
            want both versions.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Project</Label>
            <Select
              items={eligibleProjects.map((project) => ({
                label: project.name,
                value: project.id,
              }))}
              value={projectId || null}
              onValueChange={(value) => {
                setProjectId(value ?? "")
              }}
              disabled={projects.isPending || eligibleProjects.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a deployed project" />
              </SelectTrigger>
              <SelectContent>
                {eligibleProjects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!projects.isPending && eligibleProjects.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Deploy a dynamic project before attaching a custom domain.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-domain-hostname">Hostname</Label>
            <Input
              id="custom-domain-hostname"
              value={hostname}
              onChange={(event) => {
                setHostname(event.target.value)
              }}
              placeholder="app.example.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button disabled={create.isPending || eligibleProjects.length === 0} onClick={submit}>
            Add domain
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DomainCard({ orgSlug, domain }: { orgSlug: string; domain: CustomDomain }) {
  const check = useCheckCustomDomain(orgSlug)
  const [checkResult, setCheckResult] = useState<
    { kind: "queued" } | { kind: "failed"; message: string } | null
  >(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="truncate font-mono text-[15px]">{domain.hostname}</CardTitle>
        <CardDescription>
          {domain.project.name} · added {formatDate(domain.createdAt)}
        </CardDescription>
        <CardAction>
          <Badge variant={STATUS_VARIANTS[domain.status]}>
            {CUSTOM_DOMAIN_STATUS_LABELS[domain.status]}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {domain.statusReason !== null ? (
          <Alert variant={domain.status === "failed" ? "destructive" : "default"}>
            <AlertTitle>
              {domain.status === "failed" ? "Action required" : "Certificate status"}
            </AlertTitle>
            <AlertDescription>{domain.statusReason}</AlertDescription>
          </Alert>
        ) : null}
        {checkResult !== null ? (
          <output
            className={
              checkResult.kind === "failed" ? "text-xs text-destructive" : "text-xs text-leaf"
            }
          >
            {checkResult.kind === "queued"
              ? "Re-check queued. DNS and certificate work continues in the background."
              : checkResult.message}
          </output>
        ) : null}

        <div className="grid gap-3 text-xs sm:grid-cols-2">
          <div>
            <span className="block text-muted-foreground">Certificate expires</span>
            <span className="mt-1 flex items-center gap-1.5">
              <CalendarClockIcon className="size-3.5 text-muted-foreground" />
              {formatDate(domain.certificateExpiresAt)}
            </span>
          </div>
          <div>
            <span className="block text-muted-foreground">Last checked</span>
            <span className="mt-1 block">{formatDate(domain.lastCheckedAt)}</span>
          </div>
        </div>

        <section aria-labelledby={`dns-${domain.id}`} className="flex flex-col gap-2.5">
          <div>
            <h3 id={`dns-${domain.id}`} className="text-sm font-medium">
              DNS records
            </h3>
            <p className="text-xs text-muted-foreground">
              Keep the ownership TXT record in place, including after activation.
            </p>
          </div>
          <DnsRecord
            type={domain.instructions.verification.type}
            name={domain.instructions.verification.name}
            value={domain.instructions.verification.value}
            note="Proves that you control this hostname."
          />
          {domain.instructions.traffic.map((record) => (
            <DnsRecord
              key={`${record.type}:${record.name}:${record.value}`}
              type={record.type}
              name={record.name}
              value={record.value}
              note={record.note}
            />
          ))}
        </section>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                disabled={check.isPending || domain.status === "deleting"}
                onClick={() => {
                  setCheckResult(null)
                  check.mutate(
                    {
                      path: {
                        orgSlug,
                        projectId: domain.project.id,
                        domainId: domain.id,
                      },
                    },
                    {
                      onSuccess: () => {
                        setCheckResult({ kind: "queued" })
                      },
                      onError: (mutationError) => {
                        setCheckResult({
                          kind: "failed",
                          message: customDomainMutationErrorMessage(mutationError),
                        })
                      },
                    },
                  )
                }}
              >
                <RefreshCwIcon className={check.isPending ? "animate-spin" : undefined} />
                Re-check
              </Button>
            }
          />
          <TooltipContent>
            Ask the background worker to check DNS now. This does not wait for certificate issuance.
          </TooltipContent>
        </Tooltip>
        <DeleteDomainDialog orgSlug={orgSlug} domain={domain} />
      </CardFooter>
    </Card>
  )
}

function DnsRecord({
  type,
  name,
  value,
  note,
}: {
  type: string
  name: string
  value: string
  note: string
}) {
  const [copied, setCopied] = useState<"name" | "value" | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)

  const copy = (field: "name" | "value", text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(field)
        setCopyFailed(false)
      })
      .catch(() => {
        setCopyFailed(true)
      })
  }

  return (
    <div className="rounded-lg border border-border bg-soil-800/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Badge variant="outline">{type}</Badge>
        <span className="text-right text-[11px] text-muted-foreground">{note}</span>
      </div>
      <CopyField
        label="Name"
        value={name}
        copied={copied === "name"}
        onCopy={() => {
          copy("name", name)
        }}
      />
      <CopyField
        label="Value"
        value={value}
        copied={copied === "value"}
        onCopy={() => {
          copy("value", value)
        }}
      />
      {copyFailed ? (
        <output className="mt-1 text-[11px] text-destructive">
          Clipboard access failed. Select and copy the value manually.
        </output>
      ) : null}
    </div>
  )
}

function CopyField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="grid grid-cols-[3.25rem_minmax(0,1fr)_2rem] items-center gap-2 py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <code className="truncate font-mono text-[11px]" title={value}>
        {value}
      </code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Copy DNS ${label.toLowerCase()} ${value}`}
              onClick={onCopy}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          }
        />
        <TooltipContent>{copied ? "Copied" : `Copy ${label.toLowerCase()}`}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function DeleteDomainDialog({ orgSlug, domain }: { orgSlug: string; domain: CustomDomain }) {
  const remove = useDeleteCustomDomain(orgSlug)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(false)
      }}
    >
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" disabled={domain.status === "deleting"}>
            <Trash2Icon />
            Remove
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {domain.hostname}?</DialogTitle>
          <DialogDescription>
            SproutOS will stop routing this hostname to {domain.project.name}, withdraw the
            certificate, and release the claim. Your DNS records are not changed automatically.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <output className="text-xs text-destructive">
            Could not start domain removal. Try again.
          </output>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              setError(false)
              remove.mutate(
                {
                  path: {
                    orgSlug,
                    projectId: domain.project.id,
                    domainId: domain.id,
                  },
                },
                {
                  onSuccess: () => {
                    setOpen(false)
                  },
                  onError: () => {
                    setError(true)
                  },
                },
              )
            }}
          >
            Remove domain
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
