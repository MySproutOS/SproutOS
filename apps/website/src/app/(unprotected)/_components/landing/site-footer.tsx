import { SproutMark } from "@website/components/icons"

export function SiteFooter() {
  return (
    <footer className="border-t rule-soft py-10">
      <div className="container-page flex flex-col items-center justify-between gap-4 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <SproutMark className="size-5 text-primary" />
          <span className="font-display text-sm font-semibold tracking-tight">SproutOS</span>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          © {new Date().getFullYear()} SproutOS · Open source infrastructure
        </p>
      </div>
    </footer>
  )
}
