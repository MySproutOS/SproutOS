import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { ArrowLeftIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@ui/base/ui/button"
import {
  Card,
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
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/base/ui/select"
import { SkeletonText } from "@ui/base/ui/skeleton"
import { Switch } from "@ui/base/ui/switch"
import { Textarea } from "@ui/base/ui/textarea"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PrimaryProjectSelect } from "@frontends/dashboard/components/projects/primary-project-select"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import {
  useProject,
  useProjects,
  useRegions,
  useUpdateProject,
  useDeleteProject,
} from "@frontends/dashboard/data/projects"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/modify")({
  component: ModifyProject,
})

function ModifyProject() {
  const { orgSlug, projectId } = Route.useParams()
  const { data, isPending, isError, refetch } = useProject(orgSlug, projectId)

  return (
    <>
      <PageHeader title={data === undefined ? "Modify" : `Modify ${data.name}`}>
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/orgs/$orgSlug/projects/$projectId" params={{ orgSlug, projectId }} />}
        >
          <ArrowLeftIcon />
          Back
        </Button>
      </PageHeader>

      <PageBody>
        {isError && (
          <ListError
            title="Could not load this project"
            onRetry={() => {
              void refetch()
            }}
          />
        )}
        {isPending && (
          <Card>
            <CardContent>
              <SkeletonText />
            </CardContent>
          </Card>
        )}
        {data !== undefined && (
          <ModifyForm
            key={data.id}
            orgSlug={orgSlug}
            projectId={data.id}
            name={data.name}
            description={data.description}
            region={data.region}
            autoUpdateForks={data.autoUpdateForks}
            isGroup={data.isGroup}
            primaryChildProjectId={data.primaryChildProjectId}
          />
        )}
      </PageBody>
    </>
  )
}

function ModifyForm({
  orgSlug,
  projectId,
  name: initialName,
  description: initialDescription,
  region: initialRegion,
  autoUpdateForks: initialAutoUpdate,
  isGroup,
  primaryChildProjectId: initialPrimaryChildProjectId,
}: {
  orgSlug: string
  projectId: string
  name: string
  description: string
  region: string
  autoUpdateForks: boolean
  isGroup: boolean
  primaryChildProjectId: string | null
}) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [region, setRegion] = useState(initialRegion)
  const [autoUpdate, setAutoUpdate] = useState(initialAutoUpdate)
  const [primaryChildProjectId, setPrimaryChildProjectId] = useState(
    initialPrimaryChildProjectId ?? "none",
  )
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
    The regions the platform actually serves, from the database.

    This screen used to offer a hardcoded four, of which one (`ap-southeast-2`) is not seeded at all
    and two are seeded inactive — so three of the four choices would have failed, and the form could
    not save either way. Serving the active set means activating a region is a row update rather
    than a release.
  */
  const regions = useRegions()
  const projects = useProjects(orgSlug)
  const update = useUpdateProject(orgSlug)
  const remove = useDeleteProject(orgSlug)
  const navigate = useNavigate()
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const available = regions.data?.data ?? []
  const regionItems = available.map((row) => ({ label: row.code, value: row.code }))

  const nameIsValid = /^[a-z0-9-]+$/.test(name.trim().toLowerCase().replaceAll(" ", "-"))

  function save() {
    setError(null)
    setSaved(false)
    update.mutate(
      {
        path: { orgSlug, projectId },
        body: {
          name: name.trim(),
          description: description.trim() === "" ? null : description.trim(),
          ...(region === initialRegion || region === "—" ? {} : { region }),
          autoUpdateEnabled: autoUpdate,
          ...(isGroup
            ? {
                primaryChildProjectId:
                  primaryChildProjectId === "none" ? null : primaryChildProjectId,
              }
            : {}),
        },
      },
      {
        onSuccess: () => {
          setSaved(true)
        },
        onError: (cause) => {
          setError(cause instanceof Error ? cause.message : "That did not save. Try again.")
        },
      },
    )
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            Renaming changes what this project is called here. It does not rename the repository on
            GitHub, and it does not change the hostname the project is served on.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name" className={nameIsValid ? "" : "text-destructive"}>
              Project name
            </Label>
            <Input
              id="project-name"
              value={name}
              aria-invalid={!nameIsValid}
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
            {!nameIsValid && (
              <p className="text-[11px] text-destructive">
                Use letters, numbers, spaces, and dashes.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              rows={3}
              onChange={(event) => {
                setDescription(event.target.value)
              }}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Region</Label>
              <Select
                items={regionItems}
                value={region}
                onValueChange={(value: string | null) => {
                  if (value !== null) setRegion(value)
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {available.map((candidate) => (
                    <SelectItem key={candidate.code} value={candidate.code}>
                      <span className="tnum font-mono">{candidate.code}</span>
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {candidate.displayName}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auto-update">Auto-update forks</Label>
              <div className="flex h-8 items-center gap-[9px]">
                <Switch id="auto-update" checked={autoUpdate} onCheckedChange={setAutoUpdate} />
                <span className="text-[13px] text-muted-foreground">
                  {autoUpdate ? "On" : "Off"}
                </span>
              </div>
            </div>
          </div>

          {isGroup && (
            <div className="flex flex-col gap-1.5">
              <Label>Primary project</Label>
              <PrimaryProjectSelect
                projectId={projectId}
                projects={projects.data}
                value={primaryChildProjectId}
                onValueChange={setPrimaryChildProjectId}
              />
              <p className="text-[11px] text-muted-foreground">
                The group uses this child project’s custom domain or SproutOS hostname.
              </p>
            </div>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-3">
          {error === null ? null : <span className="text-xs text-destructive">{error}</span>}
          {saved && error === null ? (
            <span className="text-xs text-muted-foreground">Saved.</span>
          ) : null}
          <Button disabled={!nameIsValid || update.isPending} onClick={save}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Deleting a project tears down its databases and stops every workflow it owns. Billing
            records are kept.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-end border-destructive/30">
          <Dialog>
            <DialogTrigger render={<Button variant="destructive">Delete project</Button>} />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete {initialName}?</DialogTitle>
                <DialogDescription>
                  This removes the deployment and its data. It cannot be undone.
                </DialogDescription>
              </DialogHeader>
              {deleteError === null ? null : (
                <p className="mt-3 text-xs text-destructive">{deleteError}</p>
              )}
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                {/*
                  A button that deletes, rather than a `DialogClose` that does not.

                  This was `<DialogClose render={<Button variant="destructive">Delete</Button>} />`,
                  which closed the dialog and sent nothing — indistinguishable from a working delete
                  right up until the project was still in the list.
                */}
                <Button
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => {
                    setDeleteError(null)
                    remove.mutate(
                      { path: { orgSlug, projectId } },
                      {
                        onSuccess: () => {
                          void navigate({ to: "/orgs/$orgSlug/projects", params: { orgSlug } })
                        },
                        onError: (cause) => {
                          setDeleteError(
                            cause instanceof Error
                              ? cause.message
                              : "That did not work. Try again.",
                          )
                        },
                      },
                    )
                  }}
                >
                  {remove.isPending ? "Deleting…" : "Delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardFooter>
      </Card>
    </div>
  )
}
