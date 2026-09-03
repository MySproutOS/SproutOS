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
      <div className="flex max-w-full items-center gap-1 overflow-x-auto border-b border-border px-5">
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
        <Link to="/orgs/$orgSlug/settings/github" params={{ orgSlug }} className={tabClassName}>
          GitHub
        </Link>
        <Link
          to="/orgs/$orgSlug/settings/sign-in-methods"
          params={{ orgSlug }}
          search={{ sign_in_method: undefined }}
          className={tabClassName}
        >
          Sign-in methods
        </Link>
        <Link to="/orgs/$orgSlug/settings/api-keys" params={{ orgSlug }} className={tabClassName}>
          API keys
        </Link>
        {/*
          Two OAuth tabs, because they are two different relationships and conflating them is how a
          person looking for "the app I signed into" ends up on a developer screen.

          "OAuth apps" is what you *publish* — clients you own, with secrets and redirect URIs.
          "Connected" is what you have *authorized* — somebody else's application acting for you,
          which is the one with a revoke button.
        */}
        <Link
          to="/orgs/$orgSlug/settings/oauth-clients"
          params={{ orgSlug }}
          className={tabClassName}
        >
          OAuth apps
        </Link>
        <Link
          to="/orgs/$orgSlug/settings/connected-apps"
          params={{ orgSlug }}
          className={tabClassName}
        >
          Connected
        </Link>
      </div>
      <Outlet />
    </>
  )
}
