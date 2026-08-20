import type { SVGProps } from "react"

/**
 * Two cotyledons breaking a soil line — the first thing a seed does above ground.
 */
export function SproutMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
      <path d="M12 21v-8.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path
        d="M12 13.2C12 9.9 9.6 7.4 6 6.9c-.5 3.6 1.8 6.6 6 6.3Z"
        fill="currentColor"
        fillOpacity="0.42"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M12 12.4c.2-3.6 2.6-6.2 6.2-6.7.4 3.8-2 6.8-6.2 6.7Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 21h15"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeOpacity="0.45"
      />
    </svg>
  )
}

/** GitHub's octocat mark, single-path so it inherits currentColor. */
export function GitHubMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
