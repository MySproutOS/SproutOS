import { formatBalanceMicroUsd } from "@lib/billing/money"
import { Link, type LinkProps } from "@tanstack/react-router"
import { useCallback, useMemo } from "react"
import {
  ChevronsUpDownIcon,
  BookOpenIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  GlobeLockIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  MergeIcon,
  PanelLeftIcon,
  ScaleIcon,
  SettingsIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"
import { Avatar, AvatarFallback } from "@ui/base/ui/avatar"
import { Money } from "@ui/base/ui/money"
import { Progress } from "@ui/base/ui/progress"
import { ScrollArea } from "@ui/base/ui/scroll-area"
import { Skeleton } from "@ui/base/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/base/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/base/ui/dropdown-menu"
import { cn } from "@ui/base/lib/utils"
import { useCreditBalance } from "@frontends/dashboard/data/billing"
import {
  organizationRoleLabel,
  type Organization,
  useOrganization,
  useOrganizations,
} from "@frontends/dashboard/data/organizations"
import { useSidebar } from "@frontends/dashboard/components/shell/sidebar-context"
import { ProjectSwitcher } from "@frontends/dashboard/components/shell/project-switcher"

type NavLinkProps = LinkProps & { icon: LucideIcon; label: string }

type ExternalNavLinkProps = { href: string; icon: LucideIcon; label: string }

const navLinkClassName = (collapsed: boolean) =>
  cn(
    // Active styling rides `data-[status=active]` rather than `activeProps`.
    // Router appends the active classes to the end of the attribute, but CSS
    // order decides the winner — plain `text-foreground` loses to the base
    // `text-muted-foreground`, and the highlight silently never appears.
    "flex h-8 items-center gap-[9px] rounded-md px-[9px] text-[13px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:font-medium data-[status=active]:text-foreground [&[data-status=active]_svg]:text-leaf",
    collapsed && "justify-center px-0",
  )

function NavLink({ icon: Icon, label, ...linkProps }: NavLinkProps) {
  const { collapsed, setMobileOpen } = useSidebar()
  const closeMobile = useCallback(() => {
    setMobileOpen(false)
  }, [setMobileOpen])

  const link = useMemo(
    () => (
      <Link {...linkProps} onClick={closeMobile} className={navLinkClassName(collapsed)}>
        <Icon className="size-[15px] shrink-0" aria-hidden="true" />
        {collapsed ? <span className="sr-only">{label}</span> : label}
      </Link>
    ),
    [Icon, closeMobile, collapsed, label, linkProps],
  )

  if (!collapsed) {
    return link
  }

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function ExternalNavLink({ href, icon: Icon, label }: ExternalNavLinkProps) {
  const { collapsed, setMobileOpen } = useSidebar()
  const closeMobile = useCallback(() => {
    setMobileOpen(false)
  }, [setMobileOpen])
  const link = useMemo(
    () => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={closeMobile}
        className={navLinkClassName(collapsed)}
      >
        <Icon className="size-[15px] shrink-0" aria-hidden="true" />
        {collapsed ? (
          <span className="sr-only">{label}</span>
        ) : (
          <>
            <span>{label}</span>
            <ExternalLinkIcon className="ml-auto size-3" aria-hidden="true" />
          </>
        )}
      </a>
    ),
    [Icon, closeMobile, collapsed, href, label],
  )

  if (!collapsed) return link

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function OrganizationMenuItem({ organization }: { organization: Organization }) {
  const params = useMemo(() => ({ orgSlug: organization.slug }), [organization.slug])
  const organizationLink = useMemo(
    () => (
      <Link to="/orgs/$orgSlug/projects" params={params}>
        <span className="truncate">{organization.name}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {organizationRoleLabel(organization)}
        </span>
      </Link>
    ),
    [organization, params],
  )

  return <DropdownMenuItem render={organizationLink} />
}

function TeamSwitcher({ orgSlug }: { orgSlug: string }) {
  const { collapsed } = useSidebar()
  const { data: current } = useOrganization(orgSlug)
  const { data: organizations } = useOrganizations()
  const settingsParams = useMemo(() => ({ orgSlug }), [orgSlug])
  const settingsLink = useMemo(
    () => <Link to="/orgs/$orgSlug/settings" params={settingsParams} />,
    [settingsParams],
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex h-10 w-full items-center gap-[9px] rounded-lg px-2 text-left transition-colors outline-none hover:bg-secondary/60 focus-visible:ring-3 focus-visible:ring-ring/20 data-popup-open:bg-secondary/60",
          collapsed && "justify-center px-0",
        )}
        aria-label="Switch organization"
      >
        <Avatar className="size-6 bg-leaf text-primary-foreground">
          <AvatarFallback className="text-xs font-bold">{current?.initial ?? "·"}</AvatarFallback>
        </Avatar>
        {!collapsed && (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium">{current?.name ?? "…"}</span>
              <span className="text-[11px] text-muted-foreground">
                {organizationRoleLabel(current)}
              </span>
            </span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel>Organizations</DropdownMenuGroupLabel>
          {organizations?.map((organization) => (
            <OrganizationMenuItem key={organization.id} organization={organization} />
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={settingsLink}>Organization settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/*
  The one amber element in the chrome. It is a balance, so it is money, so it is
  amber and mono and tabular — and nothing else in the sidebar may borrow that.
*/
function CreditBalanceCard({ orgSlug }: { orgSlug: string }) {
  const { collapsed } = useSidebar()
  const { data, isPending } = useCreditBalance(orgSlug)
  const billingParams = useMemo(() => ({ orgSlug }), [orgSlug])
  const collapsedBillingLink = useMemo(
    () => (
      <Link
        to="/orgs/$orgSlug/settings/billing"
        params={billingParams}
        className="m-2 flex flex-col items-center gap-1.5 rounded-lg border border-border bg-soil-800 px-1 py-2.5"
      >
        <span className="eyebrow text-[9px]">$</span>
        <Progress
          value={data?.percentRemaining ?? 0}
          className="w-6"
          indicatorClassName="bg-husk"
          aria-label="Credit balance remaining"
        />
      </Link>
    ),
    [billingParams, data?.percentRemaining],
  )

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={collapsedBillingLink} />
        <TooltipContent side="right">
          {data === undefined
            ? "Balance"
            : `${formatBalanceMicroUsd(data.balanceMicros)} — ${data.runwayLabel}`}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Link
      to="/orgs/$orgSlug/settings/billing"
      params={billingParams}
      className="m-2 flex flex-col gap-[7px] rounded-lg border border-border bg-soil-800 px-3 py-[11px] transition-colors hover:border-husk/40"
    >
      <span className="flex items-baseline justify-between">
        <span className="eyebrow text-[10px]">Balance</span>
        {isPending ? (
          <Skeleton className="h-4 w-12" />
        ) : (
          <Money size="lg">
            {data === undefined ? "" : formatBalanceMicroUsd(data.balanceMicros)}
          </Money>
        )}
      </span>
      <Progress
        value={data?.percentRemaining ?? 0}
        indicatorClassName="bg-husk"
        aria-label="Credit balance remaining"
      />
      <span className="text-[11px] text-muted-foreground">
        {isPending ? " " : data?.runwayLabel}
      </span>
    </Link>
  )
}

export function SidebarBody({ orgSlug }: { orgSlug: string }) {
  const { collapsed } = useSidebar()
  const orgParams = useMemo(() => ({ orgSlug }), [orgSlug])

  return (
    <>
      <div className="border-b border-sidebar-border p-3">
        <TeamSwitcher orgSlug={orgSlug} />
        {/*
          The project switcher sits under the team switcher, as the reference dashboard has it.

          Hidden when the sidebar is collapsed rather than squeezed into an icon: it is a
          find-as-you-type list, and there is no useful 32-pixel representation of one.
        */}
        {collapsed ? null : (
          <div className="mt-1.5">
            <ProjectSwitcher orgSlug={orgSlug} />
          </div>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2.5">
        <NavLink
          to="/orgs/$orgSlug/projects"
          params={orgParams}
          icon={LayoutDashboardIcon}
          label="Projects"
        />
        <NavLink
          to="/orgs/$orgSlug/workflows"
          params={orgParams}
          icon={WorkflowIcon}
          label="Workflows"
        />
        <NavLink
          to="/orgs/$orgSlug/databases"
          params={orgParams}
          icon={DatabaseIcon}
          label="Databases"
        />
        <NavLink
          to="/orgs/$orgSlug/domains"
          params={orgParams}
          icon={GlobeLockIcon}
          label="Custom domains"
        />
        <NavLink to="/store" icon={MergeIcon} label="Store" />
        <ExternalNavLink href="https://sproutos.me/docs" icon={BookOpenIcon} label="Docs" />
        <ExternalNavLink href="https://sproutos.me/legal" icon={ScaleIcon} label="Legal" />

        <div className={cn("mx-[9px] my-2.5 h-px bg-sidebar-border", collapsed && "mx-2")} />

        <NavLink
          to="/orgs/$orgSlug/observability"
          params={orgParams}
          icon={GlobeIcon}
          label="Observability"
        />
        <NavLink
          to="/orgs/$orgSlug/settings"
          params={orgParams}
          icon={SettingsIcon}
          label="Settings"
        />
      </nav>

      <CreditBalanceCard orgSlug={orgSlug} />
    </>
  )
}

export function Sidebar({ orgSlug }: { orgSlug: string }) {
  const { collapsed, toggleCollapsed } = useSidebar()

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 self-start flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 md:flex",
        collapsed ? "w-14" : "w-58",
      )}
    >
      <ScrollArea
        className="min-h-0 flex-1"
        viewportClassName="[&>[data-slot=scroll-area-content]]:w-full [&>[data-slot=scroll-area-content]]:min-w-0!"
      >
        <div className="flex min-h-dvh w-full min-w-0 flex-col">
          <SidebarBody orgSlug={orgSlug} />
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            className="m-2 mt-0 flex h-7 items-center justify-center gap-2 rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/20"
          >
            <PanelLeftIcon className="size-4 shrink-0" />
            {!collapsed && <span className="text-[11px]">Collapse</span>}
          </button>
        </div>
      </ScrollArea>
    </aside>
  )
}
