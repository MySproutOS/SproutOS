import { Link, Outlet, createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@frontends/dashboard/components/shell/page-header"

export const Route = createFileRoute("/orgs/$orgSlug/settings")({
  component: SettingsLayout,
})

// Active styling rides `data-[status=active]` rather than `activeProps`: the
// router appends active classes, but CSS order decides which utility wins, and a
// plain `border-primary` loses to the base `border-transparent`.
const tabClassName =
  "-mb-px flex h-8 items-center rounded-t-md border-b-2 border-transparent px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[status=active]:border-primary data-[status=active]:text-foreground"

/*
  A row of routed links rather than `Tabs`: each panel is its own URL under ADR
  0003, so the browser's back button has to move between them.
*/
function SettingsLayout() {
  const { orgSlug } = Route.useParams()

  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex items-center gap-1 border-b border-border px-5">
        <Link to="/orgs/$orgSlug/settings/profile" params={{ orgSlug }} className={tabClassName}>
          Profile
        </Link>
        <Link to="/orgs/$orgSlug/settings/billing" params={{ orgSlug }} className={tabClassName}>
          Billing
        </Link>
        <Link to="/orgs/$orgSlug/settings/members" params={{ orgSlug }} className={tabClassName}>
          Members
        </Link>
        <Link to="/orgs/$orgSlug/settings/agent" params={{ orgSlug }} className={tabClassName}>
          Agent
        </Link>
        <Link to="/orgs/$orgSlug/settings/api-keys" params={{ orgSlug }} className={tabClassName}>
          API keys
        </Link>
      </div>
      <Outlet />
    </>
  )
}
