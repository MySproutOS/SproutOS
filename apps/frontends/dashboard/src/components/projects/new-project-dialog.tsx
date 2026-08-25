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
import { CheckIcon, GitForkIcon, FolderGitIcon, PlusIcon, SparklesIcon, XIcon } from "lucide-react"
import { useEffect, useState } from "react"
import {
  useCreateProject,
  useGithubRepositories,
  useRepositoryNameCheck,
} from "@frontends/dashboard/data/new-project"
import { useStoreListings } from "@frontends/dashboard/data/store"
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
type Source = "store" | "blank" | "repository"

const CARDS: { id: Source; icon: typeof GitForkIcon; title: string; detail: string }[] = [
  {
    id: "store",
    icon: GitForkIcon,
    title: "Fork an app",
    detail: "Start from something in the store that already runs, then make it yours.",
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

export function NewProjectDialog({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <PlusIcon />
            New project
          </Button>
        }
      />
      <DialogContent className="w-[34rem]">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Three ways to start. All of them end up as your code.
          </DialogDescription>
        </DialogHeader>
        <NewProjectForm
          orgSlug={orgSlug}
          onDone={() => {
            setOpen(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function NewProjectForm({ orgSlug, onDone }: { orgSlug: string; onDone: () => void }) {
  const [source, setSource] = useState<Source>("store")
  const [name, setName] = useState("")
  const [repositoryName, setRepositoryName] = useState("")
  const [listingId, setListingId] = useState<string | null>(null)
  const [repositoryId, setRepositoryId] = useState<string | null>(null)
  const [touchedRepoName, setTouchedRepoName] = useState(false)

  const navigate = useNavigate()
  const listings = useStoreListings()
  const repositories = useGithubRepositories(orgSlug, source === "repository")
  const create = useCreateProject(orgSlug)

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
    source !== "repository" && debounced.length > 0,
  )

  const needsRepoName = source !== "repository"
  const ready =
    name.trim().length > 0 &&
    (source !== "store" || listingId !== null) &&
    (source !== "repository" || repositoryId !== null) &&
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
              source:
                source === "store"
                  ? { type: "store", storeListingId: listingId!, repositoryName }
                  : source === "repository"
                    ? { type: "repository", repositoryId: repositoryId! }
                    : { type: "blank", repositoryName },
            },
          },
          {
            onSuccess: (result) => {
              onDone()
              const id = (result as { project?: { id?: string } }).project?.id
              if (id !== undefined) {
                void navigate({
                  to: "/orgs/$orgSlug/projects/$projectId",
                  params: { orgSlug, projectId: id },
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

      {source === "repository" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="np-repo">Repository</Label>
          {repositories.isError ? (
            <p className="text-[13px] text-muted-foreground">
              No GitHub account is connected to this organization yet, so there is nothing to list.
              Install the SproutOS GitHub App on the account that owns the repository.
            </p>
          ) : (
            <select
              id="np-repo"
              value={repositoryId ?? ""}
              onChange={(event) => {
                setRepositoryId(event.target.value === "" ? null : event.target.value)
              }}
              className="h-9 rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/20"
            >
              <option value="">
                {repositories.isPending ? "Loading…" : "Choose a repository…"}
              </option>
              {repositories.data?.data.map((repository) => (
                <option key={repository.githubRepoId} value={repository.githubRepoId}>
                  {repository.fullName}
                </option>
              ))}
            </select>
          )}
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
          <Label htmlFor="np-reponame">GitHub repository name</Label>
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
        </div>
      )}

      {create.isError && (
        <p className="text-[13px] text-destructive">
          The project could not be created. Nothing was changed on GitHub.
        </p>
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
