import { createFileRoute } from "@tanstack/react-router"
import { Spinner } from "@ui/base/ui/spinner"
import { DashboardShell } from "@frontends/dashboard/components/shell/dashboard-shell"
import { ListError } from "@frontends/dashboard/components/list-states"
import { useLastOrganizationSlug } from "@frontends/dashboard/data/organizations"

export const Route = createFileRoute("/store")({
  component: StoreLayout,
})

/*
  `/store` is a shared route in `apps/website/src/proxy.ts`: Next.js renders it for
  logged-out visitors and rewrites to this SPA once the session cookie validates.
  It is not org-scoped, so the shell borrows the reader's current organization to
  keep the sidebar — and its balance — from disappearing mid-browse.
*/
function StoreLayout() {
  const { data: orgSlug, isPending, isError, refetch } = useLastOrganizationSlug()

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    )
  }

  if (isError || orgSlug === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-md">
          <ListError
            title="Could not load the store"
            onRetry={() => {
              void refetch()
            }}
          />
        </div>
      </div>
    )
  }

  return <DashboardShell orgSlug={orgSlug} />
}
