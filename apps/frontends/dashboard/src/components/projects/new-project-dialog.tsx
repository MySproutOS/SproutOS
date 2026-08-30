import { useNavigate } from "@tanstack/react-router"
import { Button } from "@ui/base/ui/button"
import {
  Dialog,
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
import {
  CheckIcon,
  FolderGitIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  LockIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import {
  useCreateProject,
  useGithubOwners,
  useGithubRepositories,
  useRepositoryNameCheck,
} from "@frontends/dashboard/data/new-project"
import { useStoreListings } from "@frontends/dashboard/data/store"
import { useRegions } from "@frontends/dashboard/data/projects"
import { projectCreateErrorMessage } from "./project-create-error"
import { nextFreeName, parseRepoRef } from "./repo-ref"
import { isProjectRootDir } from "./project-root-dir"
import { slugify } from "./slug"

/**
 * Starting a project, in the three ways the API has always supported.
 *
 * `ProjectSource` is a union of `store`, `blank` and `repository`, and the button that said
 * "New project" navigated to `/store` — so two of the three were reachable only by calling the API
 * directly. Somebody who wanted to start from scratch, or from a repository they already had, was
 * shown a shelf of other people's applications instead.
 *
 * The repository name is asked for here rather than derived, and checked while it is being typed.
 * The create runs inside a `project_job`, so GitHub's "name already exists" would otherwise reach
 * the customer as a failed provision some minutes later, by which time the form is gone.
 */
type Source = "store" | "template" | "blank" | "repository"

const CARDS: { id: Source; icon: typeof GitForkIcon; title: string; detail: string }[] = [
  {
    id: "store",
    icon: GitForkIcon,
    title: "Fork an app",
    detail: "Start from something in the store that already runs, then make it yours.",
  },
  {
    id: "template",
    icon: GitBranchIcon,
    title: "From any GitHub repository",
    detail: "Paste a repository. SproutOS copies it into a new one that belongs to you.",
  },
  {
    id: "blank",
    icon: SparklesIcon,
    title: "Start blank",
    detail: "An empty repository. You and the agent build it from nothing.",
  },
  {
    id: "repository",
    icon: FolderGitIcon,
    title: "Use a repository you own",
    detail: "Point SproutOS at code that already exists on GitHub.",
  },
]

const VISIBILITY: {
  private: boolean
  icon: typeof GlobeIcon
  label: string
  detail: string
}[] = [
  {
    private: false,
    icon: GlobeIcon,
    label: "Public",
    detail: "Anyone can read the code. You choose who can push.",
  },
  {
    private: true,
    icon: LockIcon,
    label: "Private",
    detail: "Only people you invite on GitHub can see it.",
  },
]

export function NewProjectDialog({
  orgSlug,
  kind = "site",
  parentProjectId = null,
  triggerLabel = "New project",
}: {
  orgSlug: string
  kind?: "site" | "workflow"
  parentProjectId?: string | null
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <PlusIcon />
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent className="w-[34rem]">
        <DialogHeader>
          <DialogTitle>{kind === "workflow" ? "New workflow" : "New project"}</DialogTitle>
          <DialogDescription>
            Three ways to start. All of them end up as your code.
          </DialogDescription>
        </DialogHeader>
        <NewProjectForm
          orgSlug={orgSlug}
          kind={kind}
          parentProjectId={parentProjectId}
          onDone={() => {
            setOpen(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function NewProjectForm({
  orgSlug,
  kind,
  parentProjectId,
  onDone,
}: {
  orgSlug: string
  kind: "site" | "workflow"
  parentProjectId: string | null
  onDone: () => void
}) {
  const [source, setSource] = useState<Source>("store")
  const [name, setName] = useState("")
  const [repositoryName, setRepositoryName] = useState("")
  const [listingId, setListingId] = useState<string | null>(null)
  /*
    GitHub's numeric id, not one of this platform's row ids.

    It used to be sent as `repositoryId`, which the API validates as a UUID — so every attempt to
    start a project from a repository you already own failed at the validator, and the third card
    could never have worked. The picker lists what the *installation* can reach, and most of those
    have no row here at all, so GitHub's id is the only handle it has. The API imports on first use.
  */
  const [githubRepoId, setGithubRepoId] = useState<string | null>(null)
  const [touchedRepoName, setTouchedRepoName] = useState(false)
  const [owner, setOwner] = useState<string | null>(null)
  const [templateRef, setTemplateRef] = useState("")
  const [rootDir, setRootDir] = useState(".")
  /*
    Public by default, and stated rather than assumed.

    The API defaults a new repository to private, which is the right default for a caller who said
    nothing. A person filling in this form did say something, and what they overwhelmingly want is
    a repository they can show somebody — so the form makes the choice explicitly and sends it.
  */
  const [isPrivate, setIsPrivate] = useState(false)
  const [workflowTrigger, setWorkflowTrigger] = useState<"interval" | "webhook">("interval")
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)

  const navigate = useNavigate()
  const listings = useStoreListings()
  // Enabled beyond the "repository" card: the existing-repository prompt needs this list to know
  // whether the repository somebody already has is one the App can actually attach a project to.
  const repositories = useGithubRepositories(orgSlug, true)
  const owners = useGithubOwners(orgSlug, source !== "repository")
  const ownerOptions = owners.data?.data ?? []
  const installUrl = owners.data?.installUrl ?? null
  // The picker is uncontrolled until the list arrives, so the effective owner is the chosen one or
  // whichever the API marked default — the same one the server would have used on its own.
  const effectiveOwner =
    owner ?? ownerOptions.find((candidate) => candidate.isDefault)?.login ?? null
  const create = useCreateProject(orgSlug)
  const regions = useRegions()
  const availableRegions = regions.data?.data ?? []
  const defaultRegion =
    availableRegions.find((candidate) => candidate.code === "us-east-1")?.code ??
    availableRegions[0]?.code ??
    null
  // us-east-1 is the product default. Keep it visible as a choice and select it when the server
  // answers, falling back only if that region is unavailable rather than silently creating a
  // project with no placement and displaying "—".
  const region = selectedRegion ?? defaultRegion

  /*
    The repository name follows the project name until somebody edits it.

    Typing "To Your Credit" and then a second time into a repository box asks a person to restate
    the same answer in a different alphabet. It stops following the moment they change it, because
    after that the two really are different names and overwriting theirs would be worse.

    Done here, on the event, rather than in an effect watching `name`. An effect would set state
    during render and cascade a second one, and the value is not synchronising with anything
    outside React — it is a consequence of a keystroke, which is where it belongs.
  */
  function applyName(next: string) {
    setName(next)
    if (!touchedRepoName) setRepositoryName(slugify(next))
  }

  // Debounced, because the query key is the name and every keystroke would otherwise be a request
  // to GitHub — and the answers would arrive out of order.
  const debounced = useDebounced(repositoryName, 400)
  const nameCheck = useRepositoryNameCheck(
    orgSlug,
    debounced,
    effectiveOwner,
    source !== "repository" && debounced.length > 0,
  )

  const template = parseRepoRef(templateRef)

  /*
    The upstream's own name is the obvious default for the copy, and it is almost always what people
    want — but only until they say otherwise, which is the same rule the project name already
    follows. Applied on the event rather than in an effect, for the reason `applyName` documents.
  */
  function applyTemplate(next: string) {
    setTemplateRef(next)
    const parsed = parseRepoRef(next)
    if (parsed !== null && !touchedRepoName) setRepositoryName(parsed.repo)
  }

  /*
    A name that is free, derived from one that is not.

    Suffixing rather than asking them to invent one: the name they typed is the name they wanted,
    and `-2` says "the same thing again" in a way `toyourcredit-new` does not. It only ever seeds
    the box — the availability check still has to agree before Create is enabled.
  */
  const suggestedName = nextFreeName(repositoryName, repositories.data?.data ?? [])

  // The row for the repository they already have, when the App can actually reach it. Without one
  // there is nothing to attach a project to, and only the rename is a real option.
  const existingRepositoryId =
    repositories.data?.data.find(
      (candidate) =>
        candidate.name.toLowerCase() === repositoryName.toLowerCase() &&
        candidate.ownerLogin.toLowerCase() === (effectiveOwner ?? "").toLowerCase(),
    )?.githubRepoId ?? null

  const needsRepoName = source !== "repository"
  const ready =
    name.trim().length > 0 &&
    region !== null &&
    (source !== "store" || listingId !== null) &&
    (source !== "template" || template !== null) &&
    (source !== "repository" || githubRepoId !== null) &&
    (source !== "repository" || isProjectRootDir(rootDir)) &&
    (!needsRepoName || (repositoryName.length > 0 && nameCheck.data?.available === true))

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate(
          {
            path: { orgSlug },
            body: {
              name: name.trim(),
              kind,
              region,
              ...(parentProjectId === null ? {} : { parentProjectId }),
              source:
                source === "store"
                  ? {
                      type: "store",
                      storeListingId: listingId!,
                      repositoryName,
                      private: isPrivate,
                      ...(effectiveOwner === null ? {} : { ownerLogin: effectiveOwner }),
                    }
                  : source === "repository"
                    ? {
                        type: "repository",
                        githubRepoId: githubRepoId!,
                      }
                    : {
                        /*
                          `blank` with a template is the copy, and `blank` without one is the empty
                          repository — the same API shape, which is why they are one branch here.
                          A template copy rather than a fork: a fork carries GitHub's "forked from"
                          link and cannot be made private or renamed freely, and what somebody
                          starting a project wants is their own repository, not an attribution to
                          somebody else's.
                        */
                        type: "blank",
                        repositoryName,
                        private: isPrivate,
                        ...(effectiveOwner === null ? {} : { ownerLogin: effectiveOwner }),
                        ...(source === "template" && template !== null
                          ? { templateOwner: template.owner, templateRepo: template.repo }
                          : {}),
                      },
              // This is part of the API JSON body. Putting it beside `body` makes it client
              // metadata, which the generated client accepts and silently omits from the request.
              ...(source === "repository" ? { rootDir: rootDir.trim() } : {}),
            },
          },
          {
            onSuccess: (result) => {
              onDone()
              const id = (result as { project?: { id?: string } }).project?.id
              if (id !== undefined) {
                void navigate({
                  to:
                    kind === "workflow"
                      ? "/orgs/$orgSlug/projects/$projectId/agent"
                      : "/orgs/$orgSlug/projects/$projectId",
                  params: { orgSlug, projectId: id },
                  ...(kind === "workflow"
                    ? {
                        search: {
                          prompt: `Create a ${workflowTrigger} workflow in this repository. Include environment variable documentation, structured logs, and observable failure handling.`,
                        },
                      }
                    : {}),
                })
              }
            },
          },
        )
      }}
    >
      <div className="grid gap-2">
        {CARDS.map((card) => {
          const Icon = card.icon
          const selected = source === card.id
          return (
            <button
              key={card.id}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setSource(card.id)
              }}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? "border-primary/60 bg-primary/8"
                  : "border-border hover:border-soil-600 hover:bg-secondary/40"
              }`}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-foreground">{card.title}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{card.detail}</span>
              </span>
            </button>
          )
        })}
      </div>

      {kind === "workflow" && (
        <div className="flex flex-col gap-1.5">
          <Label>Trigger</Label>
          <Select
            value={workflowTrigger}
            onValueChange={(value: "interval" | "webhook" | null) => {
              if (value !== null) setWorkflowTrigger(value)
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="interval">Interval schedule</SelectItem>
              <SelectItem value="webhook">Webhook</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="np-region">Region</Label>
        <Select
          items={availableRegions.map((candidate) => ({
            label: candidate.code,
            value: candidate.code,
          }))}
          value={region}
          onValueChange={(value) => {
            setSelectedRegion(value)
          }}
          disabled={regions.isPending || regions.isError || availableRegions.length === 0}
        >
          <SelectTrigger id="np-region">
            <SelectValue
              placeholder={regions.isPending ? "Loading regions…" : "Choose a region…"}
            />
          </SelectTrigger>
          <SelectContent>
            {availableRegions.map((candidate) => (
              <SelectItem key={candidate.code} value={candidate.code}>
                {candidate.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {regions.isError && (
          <p className="text-[13px] text-destructive">
            Regions could not be loaded. Try reopening this dialog.
          </p>
        )}
      </div>

      {source === "store" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="np-listing">App to fork</Label>
          <select
            id="np-listing"
            value={listingId ?? ""}
            onChange={(event) => {
              setListingId(event.target.value === "" ? null : event.target.value)
              const picked = listings.data?.find((l) => l.id === event.target.value)
              if (picked && name === "") applyName(picked.name)
            }}
            className="h-9 rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/20"
          >
            <option value="">Choose an app…</option>
            {listings.data?.map((listing) => (
              <option key={listing.id} value={listing.id}>
                {listing.name} — {listing.tagline}
              </option>
            ))}
          </select>
        </div>
      )}

      {source === "template" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="np-template">Repository to copy</Label>
          <Input
            id="np-template"
            value={templateRef}
            onChange={(event) => {
              applyTemplate(event.target.value)
            }}
            placeholder="Andrew-Chen-Wang/reddit-clone"
            aria-describedby="np-template-status"
            spellCheck={false}
          />
          <p id="np-template-status" className="text-[13px] text-muted-foreground">
            {templateRef.trim() === "" ? (
              "Any public repository — paste the URL or owner/repo."
            ) : template === null ? (
              <span className="flex items-start gap-1.5 text-destructive">
                <XIcon className="mt-0.5 size-3.5 shrink-0" />
                That does not look like a GitHub repository.
              </span>
            ) : (
              `Copying ${template.owner}/${template.repo}. The copy is yours — no fork link, no shared history.`
            )}
          </p>
        </div>
      )}

      {source === "repository" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="np-repo">Repository</Label>
            {repositories.isError ? (
              <p className="text-[13px] text-muted-foreground">
                No GitHub account is connected to this organization yet, so there is nothing to
                list. Install the SproutOS GitHub App on the account that owns the repository.
              </p>
            ) : (
              <Select
                items={(repositories.data?.data ?? []).map((repository) => ({
                  label: repository.fullName,
                  value: repository.githubRepoId,
                }))}
                value={githubRepoId}
                onValueChange={(value) => {
                  setGithubRepoId(value)
                }}
              >
                <SelectTrigger id="np-repo">
                  <SelectValue
                    placeholder={repositories.isPending ? "Loading…" : "Choose a repository…"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {repositories.data?.data.map((repository) => (
                    <SelectItem key={repository.githubRepoId} value={repository.githubRepoId}>
                      {repository.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="np-root-dir">Project directory</Label>
            <Input
              id="np-root-dir"
              value={rootDir}
              onChange={(event) => {
                setRootDir(event.target.value)
              }}
              placeholder="apps/website"
              aria-describedby="np-root-dir-help"
              spellCheck={false}
            />
            <p
              id="np-root-dir-help"
              className={`text-[13px] ${isProjectRootDir(rootDir) ? "text-muted-foreground" : "text-destructive"}`}
            >
              {isProjectRootDir(rootDir)
                ? "Relative to the repository root. Use . for the whole repository; monorepo projects from the same repository stay together as one group."
                : "Enter . or a relative directory without empty, . or .. segments."}
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="np-name">Project name</Label>
        <Input
          id="np-name"
          value={name}
          onChange={(event) => {
            applyName(event.target.value)
          }}
          placeholder="ToYourCredit"
        />
      </div>

      {needsRepoName && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="np-reponame">GitHub repository</Label>
          {/*
            Owner and name together, in that order, because that is the repository's actual address.
            Splitting them into separate rows hides the fact that "is this name free" is only ever a
            question about one account — the same name can be free on the personal account and taken
            on the organization.
          */}
          <div className="flex items-center gap-1.5">
            {/*
              Always a control, even with one account.

              It used to render a single owner as plain text on the reasoning that one account is
              not a choice. That is true and it is not what a person reads: an unstyled login beside
              an input says "this is where your code goes and you cannot change it", when the actual
              situation is "you have installed the App on one account so far". The two are very
              different and only one of them is true. A select that lists one account and offers to
              add another says the second.
            */}
            {ownerOptions.length > 0 ? (
              <Select
                items={ownerOptions.map((candidate) => ({
                  label: candidate.login,
                  value: candidate.login,
                }))}
                value={effectiveOwner}
                onValueChange={(next) => {
                  setOwner(next)
                }}
              >
                <SelectTrigger className="w-[11rem] shrink-0" aria-label="Repository owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ownerOptions.map((candidate) => (
                    <SelectItem key={candidate.login} value={candidate.login}>
                      {candidate.login}
                      {candidate.accountType === "Organization" ? "" : " (personal)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="shrink-0 truncate text-[13px] text-muted-foreground">—</span>
            )}
            <span className="text-muted-foreground">/</span>
            <Input
              id="np-reponame"
              value={repositoryName}
              onChange={(event) => {
                setTouchedRepoName(true)
                setRepositoryName(event.target.value)
              }}
              placeholder="toyourcredit"
              aria-describedby="np-reponame-status"
            />
          </div>
          <p id="np-reponame-status" className="flex items-center gap-1.5 text-[13px]">
            {repositoryName.length === 0 ? (
              <span className="text-muted-foreground">Where the code will live.</span>
            ) : nameCheck.isPending || debounced !== repositoryName ? (
              <span className="text-muted-foreground">Checking…</span>
            ) : nameCheck.data?.available === true ? (
              <span className="flex items-center gap-1.5 text-leaf">
                <CheckIcon className="size-3.5" />
                {nameCheck.data.ownerLogin}/{repositoryName} is free
              </span>
            ) : (
              <span className="flex items-start gap-1.5 text-destructive">
                <XIcon className="mt-0.5 size-3.5 shrink-0" />
                {nameCheck.data?.reason ?? "That name could not be checked."}
              </span>
            )}
          </p>

          {/*
            You may already have this repository, and that is not an error.

            Copying a repository twice is a normal thing to do — and so is having copied it months
            ago and forgotten. Reporting only "that name is taken" leaves somebody to invent a name
            and wonder whether they were about to duplicate their own work. Both real answers are
            offered instead, and neither is chosen for them: reusing a repository picks up whatever
            is already in it, which is right when it is the project they meant and wrong when it is
            an abandoned experiment. Only the person knows which.
          */}
          {nameCheck.data?.conflict === "exists" && (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-secondary/40 p-2.5">
              <p className="text-[13px] text-foreground">
                You already have{" "}
                <span className="font-medium">
                  {nameCheck.data.ownerLogin}/{repositoryName}
                </span>
                .
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {existingRepositoryId !== null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setGithubRepoId(existingRepositoryId)
                      setSource("repository")
                    }}
                  >
                    Use that repository
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setTouchedRepoName(true)
                    setRepositoryName(suggestedName)
                  }}
                >
                  Name it {suggestedName}
                </Button>
              </div>
              {existingRepositoryId === null && (
                <p className="text-xs text-muted-foreground">
                  It is not one the SproutOS App can reach, so it cannot be used directly — grant
                  the App access to it, or create a new one.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/*
        The way out of a one-account organization.

        Nothing in the product said the App could be installed anywhere else, so an organization
        whose App landed on one account had no route to a second and no reason to think there was
        one. Shown beside the owner rather than only in settings, because this is the moment
        somebody discovers the account they wanted is missing.
      */}
      {needsRepoName && installUrl !== null && (
        <p className="text-[13px] text-muted-foreground">
          Need a different account?{" "}
          <a
            href={installUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-2 hover:text-leaf"
          >
            Install the SproutOS App there
          </a>{" "}
          and it will appear here.
        </p>
      )}

      {needsRepoName && (
        <div className="flex flex-col gap-1.5">
          <Label>Visibility</Label>
          {/*
            Two labelled choices rather than a switch. A switch shows one word and leaves the other
            state to be inferred, and "private off" is not a sentence anybody wants to parse about
            who can read their code.
          */}
          <div className="grid grid-cols-2 gap-2">
            {VISIBILITY.map((option) => {
              const Icon = option.icon
              const selected = isPrivate === option.private
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setIsPrivate(option.private)
                  }}
                  className={`flex items-start gap-2 rounded-md border p-2.5 text-left transition-colors ${
                    selected
                      ? "border-leaf bg-leaf/10"
                      : "border-border hover:border-muted-foreground"
                  }`}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium">{option.label}</span>
                    <span className="text-[12px] text-muted-foreground">{option.detail}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {create.isError && (
        <p className="text-[13px] text-destructive">{projectCreateErrorMessage(create.error)}</p>
      )}

      {/*
        The one blocker a person can clear themselves, said where they hit it.

        Creating a repository needs either a GitHub App installation on the account or an OAuth
        token carrying `repo`. A new organization has neither, and the failure surfaces inside a
        `project_job` — so the project sits at "creating", turns `failed`, and the sentence naming
        the fix is in a job record nobody opens.

        The installation route cannot help here either: `github.installation.sync` matches an
        installation to an organization by `repository.owner_login`, so an organization with no
        repositories yet has nothing to match and the installation is deliberately kept out of the
        table. Re-authenticating is the path that works from a standing start, and it is one link.
      */}
      {needsRepoName && nameCheck.data?.ownerLogin === null && repositoryName.length > 0 && (
        <p className="rounded-md border border-border bg-secondary/40 p-2.5 text-[13px] text-muted-foreground">
          SproutOS cannot create repositories for this organization yet.{" "}
          <a
            href={`${import.meta.env.VITE_NEXTJS_URL ?? ""}/login/github?scopes=repository`}
            className="font-medium text-foreground underline underline-offset-2 hover:text-leaf"
          >
            Grant repository access
          </a>{" "}
          and come back — it takes one round trip through GitHub.
        </p>
      )}

      <DialogFooter>
        <Button type="submit" disabled={!ready || create.isPending}>
          {create.isPending ? "Creating…" : "Create project"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value)
    }, ms)
    return () => {
      clearTimeout(timer)
    }
  }, [value, ms])
  return settled
}
