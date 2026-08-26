import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@ui/base/ui/button"
import { BuildingIcon, PlusIcon, SettingsIcon, UserIcon } from "lucide-react"
import { useGithubOwners } from "@frontends/dashboard/data/new-project"

export const Route = createFileRoute("/orgs/$orgSlug/settings/github")({
  component: GithubSettings,
})

/**
 * Where the GitHub App is installed, and how to change that.
 *
 * There was no such page. The App could be installed exactly once, by whoever happened to follow
 * the link during onboarding, and after that the product offered no route to a second account and
 * no acknowledgement that one was possible. The new-project dialog then showed a single owner as
 * plain text — correctly, since one account is not a choice — which reads as "you may only use
 * this account" rather than "you have only installed it on this account".
 *
 * The two are very different, and only one of them is true.
 */
function GithubSettings() {
  const { orgSlug } = Route.useParams()
  const owners = useGithubOwners(orgSlug, true)
  const accounts = owners.data?.data ?? []
  const installUrl = owners.data?.installUrl ?? null

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-medium text-foreground">GitHub App</h2>
          <p className="max-w-prose text-[13px] text-muted-foreground">
            SproutOS creates and deploys repositories through a GitHub App. Install it on every
            account you want to build projects under — your personal account and any organization.
          </p>
        </div>

        {installUrl !== null && (
          <Button
            render={
              <a href={installUrl} target="_blank" rel="noreferrer">
                <PlusIcon />
                Install on an account
              </a>
            }
          />
        )}
      </div>

      {owners.isPending ? (
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : accounts.length === 0 ? (
        /*
          Not an error state. A new organization has no installation and that is simply where
          everyone starts — the page's whole job here is to say what to do next, which is the one
          thing the product never said.
        */
        <div className="rounded-lg border border-border bg-secondary/40 p-4">
          <p className="text-[13px] text-foreground">
            The App is not installed on any account yet.
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Until it is, SproutOS cannot create repositories or read the ones you already have.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => {
            const Icon = account.accountType === "Organization" ? BuildingIcon : UserIcon
            return (
              <li
                key={account.login}
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex flex-col">
                    <span className="text-[13px] font-medium text-foreground">{account.login}</span>
                    <span className="text-xs text-muted-foreground">
                      {account.accountType === "Organization" ? "Organization" : "Personal account"}
                      {account.isDefault ? " — used by default" : ""}
                    </span>
                  </span>
                </span>

                {/*
                  GitHub's own settings, not ours. Which repositories an installation may touch is
                  granted on GitHub and revocable there, and duplicating that here would be a second
                  place to read a permission that only GitHub can actually answer for.
                */}
                <Button
                  variant="outline"
                  size="sm"
                  render={
                    <a href={account.manageUrl} target="_blank" rel="noreferrer">
                      <SettingsIcon />
                      Manage on GitHub
                    </a>
                  }
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
