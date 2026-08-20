import { Link, createFileRoute } from "@tanstack/react-router"
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
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import { useProject } from "@frontends/dashboard/data/projects"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/modify")({
  component: ModifyProject,
})

const REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-2"]
const REGION_ITEMS = REGIONS.map((region) => ({ label: region, value: region }))

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
            name={data.name}
            description={data.description}
            region={data.region}
            autoUpdateForks={data.autoUpdateForks}
          />
        )}
      </PageBody>
    </>
  )
}

function ModifyForm({
  name: initialName,
  description: initialDescription,
  region: initialRegion,
  autoUpdateForks: initialAutoUpdate,
}: {
  name: string
  description: string
  region: string
  autoUpdateForks: boolean
}) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [region, setRegion] = useState(initialRegion)
  const [autoUpdate, setAutoUpdate] = useState(initialAutoUpdate)

  const nameIsValid = /^[a-z0-9-]+$/.test(name.trim().toLowerCase().replaceAll(" ", "-"))

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            Renaming a project does not change its URL until the next deploy.
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
                items={REGION_ITEMS}
                value={region}
                onValueChange={(value: string | null) => {
                  if (value !== null) setRegion(value)
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REGIONS.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      <span className="tnum font-mono">{candidate}</span>
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
        </CardContent>
        <CardFooter className="justify-end">
          <Button disabled={!nameIsValid}>Save changes</Button>
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
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                <DialogClose render={<Button variant="destructive">Delete</Button>} />
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardFooter>
      </Card>
    </div>
  )
}
