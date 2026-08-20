import { MenuIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@ui/base/ui/button"
import { useSidebar } from "@frontends/dashboard/components/shell/sidebar-context"

/**
 * The 52px bar from `design/parts/Main.html`: title, an optional count chip, then
 * the screen's controls. Every route owns its own header rather than the shell
 * guessing one, because the controls differ on every screen.
 */
export function PageHeader({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children?: ReactNode
}) {
  const { setMobileOpen } = useSidebar()

  return (
    <header className="flex h-13 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ml-1 md:hidden"
          aria-label="Open navigation"
          onClick={() => {
            setMobileOpen(true)
          }}
        >
          <MenuIcon />
        </Button>
        <span className="truncate text-[15px] font-semibold">{title}</span>
        {count !== undefined && (
          <span className="tnum rounded-full bg-secondary px-[7px] py-px font-mono text-xs text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </header>
  )
}

/** Standard 20px gutter for the region under a `PageHeader`. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-5">{children}</div>
}
