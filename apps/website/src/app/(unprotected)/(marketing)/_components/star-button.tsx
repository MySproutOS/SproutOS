import { GitHubMark, StarMark } from "@website/components/icons"
import { REPOSITORY_URL } from "@website/lib/github-stars"

/**
 * Star the repository, with the count beside it.
 *
 * The count is a `number | null`, and `null` is a real case rather than a defensive one: GitHub
 * being unreachable is not the same fact as nobody having starred it, so the count segment is
 * dropped entirely instead of rendering a zero we did not read.
 *
 * `size="sm"` is the header; `size="default"` sits beside the hero's secondary link.
 */
export function StarButton({
  stars,
  size = "default",
  className,
}: {
  stars: number | null
  size?: "sm" | "default"
  className?: string
}) {
  const compact = size === "sm"
  const height = compact ? "h-8" : "h-10"
  const padding = compact ? "px-2.5" : "px-3.5"
  const text = compact ? "text-[0.8125rem]" : "text-sm"
  const label = stars === null ? null : new Intl.NumberFormat("en-US").format(stars)

  return (
    <a
      href={REPOSITORY_URL}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={
        label === null ? "Star SproutOS on GitHub" : `Star SproutOS on GitHub — ${label} stars`
      }
      className={`group inline-flex shrink-0 items-center rounded-xl transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${className ?? ""}`}
    >
      <span
        className={`inline-flex items-center gap-2 ${height} ${padding} ${text} rounded-l-xl border border-border bg-card font-medium transition-colors group-hover:bg-secondary ${label === null ? "rounded-r-xl" : "border-r-0"}`}
      >
        <GitHubMark className={compact ? "size-4" : "size-[1.0625rem]"} />
        <StarMark className={`${compact ? "size-3.5" : "size-4"} text-primary`} />
        {compact ? null : "Star"}
      </span>
      {label === null ? null : (
        <span
          className={`tnum inline-flex items-center ${height} ${padding} ${text} rounded-r-xl border border-border bg-background/60 font-mono`}
        >
          {label}
        </span>
      )}
    </a>
  )
}
