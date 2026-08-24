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

/**
 * Google's "G". Inline stroke-free paths because it is a four-colour mark and the brand guidelines
 * do not permit recolouring it — unlike `GitHubMark`, which is monochrome and inherits
 * `currentColor`.
 */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.64h6.2a5.3 5.3 0 0 1-2.3 3.48v2.9h3.72c2.18-2 3.44-4.96 3.44-8.57Z"
      />
      <path
        fill="#34A853"
        d="M12 23.5c3.1 0 5.71-1.03 7.62-2.78l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.02-6.45-4.74H1.7v2.98A11.5 11.5 0 0 0 12 23.5Z"
      />
      <path
        fill="#FBBC05"
        d="M5.55 14.19a6.9 6.9 0 0 1 0-4.38V6.83H1.7a11.5 11.5 0 0 0 0 10.34l3.85-2.98Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.98c1.69 0 3.2.58 4.4 1.72l3.3-3.3C17.7 1.54 15.1.5 12 .5A11.5 11.5 0 0 0 1.7 6.83l3.85 2.98C6.46 7.09 9 4.98 12 4.98Z"
      />
    </svg>
  )
}
