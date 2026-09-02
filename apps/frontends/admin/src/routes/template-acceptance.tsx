import { useMutation } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { postV1OrgsByOrgSlugStoreListingsByListingIdAcceptanceProjectsMutation } from "@lib/api-client/generated/@tanstack/react-query.gen"
import type { PostV1OrgsByOrgSlugStoreListingsByListingIdAcceptanceProjectsResponse } from "@lib/api-client/generated/types.gen"
import { Alert, AlertDescription, AlertTitle } from "@ui/base/ui/alert"
import { Button } from "@ui/base/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { Textarea } from "@ui/base/ui/textarea"
import { type ReactNode, useState } from "react"

export const Route = createFileRoute("/template-acceptance")({
  component: TemplateAcceptancePage,
})

type AcceptanceResult = PostV1OrgsByOrgSlugStoreListingsByListingIdAcceptanceProjectsResponse

/**
 * The controlled bridge between a blocked signed catalogue entry and its production evidence.
 *
 * This is deliberately an admin page, not a public install escape hatch. The API independently
 * requires an unimpersonated platform-admin session, an active unevidenced draft, exact signed
 * provenance, a private empty destination repository, and the customer's own project:create
 * permission. The page only makes that existing boundary operable without copying a session
 * cookie into a terminal.
 */
function TemplateAcceptancePage() {
  const [organization, setOrganization] = useState("andrew-chen-wang-s-team")
  const [listingId, setListingId] = useState("")
  const [name, setName] = useState("")
  const [region, setRegion] = useState("us-east-1")
  const [ownerLogin, setOwnerLogin] = useState("TestSproutOS")
  const [repositoryName, setRepositoryName] = useState("")
  const [githubRepoId, setGithubRepoId] = useState("")
  const [reason, setReason] = useState(
    "Production catalogue acceptance before publishing the signed listing.",
  )
  const [result, setResult] = useState<AcceptanceResult | null>(null)

  const createAcceptance = useMutation({
    ...postV1OrgsByOrgSlugStoreListingsByListingIdAcceptanceProjectsMutation(),
    onSuccess: (data) => {
      setResult(data)
    },
  })

  const valid =
    organization.trim().length >= 2 &&
    listingId.trim().length > 0 &&
    name.trim().length > 0 &&
    region.trim().length > 0 &&
    ownerLogin.trim().length > 0 &&
    repositoryName.trim().length > 0 &&
    reason.trim().length >= 10

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Template acceptance</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Create a private production project from an exact blocked signed catalogue entry. This
          does not publish the listing; it creates the evidence needed before publication.
        </p>
      </div>

      <Alert variant="warning">
        <AlertTitle>Production resources and customer credits</AlertTitle>
        <AlertDescription>
          The project provisions real services in the selected region. Use a disposable repository
          name, record the resulting project and job IDs, and delete the project after evidence is
          captured. Project deletion never deletes its GitHub repository.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Acceptance project</CardTitle>
          <CardDescription>
            Leave GitHub repository ID empty to let the linked installation create a new private
            repository. A supplied ID must identify an empty private repository visible to the App.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              setResult(null)
              createAcceptance.mutate({
                path: {
                  orgSlug: organization.trim(),
                  listingId: listingId.trim(),
                },
                body: {
                  name: name.trim(),
                  region: region.trim(),
                  ownerLogin: ownerLogin.trim(),
                  repositoryName: repositoryName.trim(),
                  reason: reason.trim(),
                  templateInputs: [],
                  ...(githubRepoId.trim() === "" ? {} : { githubRepoId: githubRepoId.trim() }),
                },
              })
            }}
          >
            <Field label="Organization slug" id="acceptance-organization">
              <Input
                id="acceptance-organization"
                value={organization}
                autoComplete="off"
                onChange={(event) => {
                  setOrganization(event.target.value)
                }}
              />
            </Field>
            <Field label="Region" id="acceptance-region">
              <Input
                id="acceptance-region"
                value={region}
                autoComplete="off"
                onChange={(event) => {
                  setRegion(event.target.value)
                }}
              />
            </Field>
            <Field label="Signed listing ID" id="acceptance-listing">
              <Input
                id="acceptance-listing"
                value={listingId}
                autoComplete="off"
                placeholder="UUIDv7 listing ID"
                onChange={(event) => {
                  setListingId(event.target.value)
                }}
              />
            </Field>
            <Field label="Project name" id="acceptance-name">
              <Input
                id="acceptance-name"
                value={name}
                autoComplete="off"
                placeholder="Memos production acceptance"
                onChange={(event) => {
                  setName(event.target.value)
                }}
              />
            </Field>
            <Field label="GitHub owner" id="acceptance-owner">
              <Input
                id="acceptance-owner"
                value={ownerLogin}
                autoComplete="off"
                onChange={(event) => {
                  setOwnerLogin(event.target.value)
                }}
              />
            </Field>
            <Field label="Repository name" id="acceptance-repository">
              <Input
                id="acceptance-repository"
                value={repositoryName}
                autoComplete="off"
                placeholder="sproutos-memos-acceptance-20260902"
                onChange={(event) => {
                  setRepositoryName(event.target.value)
                }}
              />
            </Field>
            <Field label="Existing GitHub repository ID (optional)" id="acceptance-github-id">
              <Input
                id="acceptance-github-id"
                value={githubRepoId}
                inputMode="numeric"
                autoComplete="off"
                placeholder="Leave empty to create one"
                onChange={(event) => {
                  setGithubRepoId(event.target.value)
                }}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Audit reason" id="acceptance-reason">
                <Textarea
                  id="acceptance-reason"
                  value={reason}
                  rows={3}
                  onChange={(event) => {
                    setReason(event.target.value)
                  }}
                />
              </Field>
            </div>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={!valid || createAcceptance.isPending}>
                {createAcceptance.isPending
                  ? "Creating private project…"
                  : "Create acceptance project"}
              </Button>
              <p className="text-xs text-muted-foreground">
                The API always forces the repository private.
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      {createAcceptance.isError && (
        <Alert variant="destructive">
          <AlertTitle>Acceptance project was not created</AlertTitle>
          <AlertDescription>
            Check that the listing is an active unverified catalogue draft, the region is active,
            and the destination repository name is unused.
          </AlertDescription>
        </Alert>
      )}

      {result !== null && (
        <Alert variant="success">
          <AlertTitle>Private acceptance project queued</AlertTitle>
          <AlertDescription>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono">
              <dt>Project</dt>
              <dd>{result.projectId}</dd>
              <dt>Job</dt>
              <dd>{result.projectJobId}</dd>
              <dt>Repository</dt>
              <dd>
                {result.repository.ownerLogin}/{result.repository.name}
              </dd>
              <dt>Source</dt>
              <dd>{result.sourceSha}</dd>
              <dt>Plugin</dt>
              <dd className="break-all">{result.pluginDigest}</dd>
            </dl>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}
