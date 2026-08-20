import { CircleAlertIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@ui/base/ui/alert"
import { Button } from "@ui/base/ui/button"
import { Skeleton } from "@ui/base/ui/skeleton"

/**
 * Skeleton, not a spinner: the shape of a project row is known before the response
 * arrives, so the placeholder is that shape.
 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3.5 rounded-lg border border-border bg-card px-4 py-3.5"
        >
          <Skeleton className="size-[34px] shrink-0 rounded-[9px]" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-2.5 w-56" />
          </div>
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}

/** The third state every list screen owes. `detail` takes a `<code>` where useful. */
export function ListError({
  title = "Could not load",
  detail,
  onRetry,
}: {
  title?: string
  detail?: ReactNode
  onRetry?: () => void
}) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{detail ?? "The request did not come back. Try again."}</AlertDescription>
      {onRetry !== undefined && (
        <AlertActions>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </AlertActions>
      )}
    </Alert>
  )
}
