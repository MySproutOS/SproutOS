const FALLBACK = "The project could not be created. Nothing was changed on GitHub."

/** Preserve the API's actionable refusal instead of replacing every failure with one generic line. */
export function projectCreateErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "object" &&
    error.error !== null &&
    "message" in error.error &&
    typeof error.error.message === "string" &&
    error.error.message.trim().length > 0
  ) {
    return error.error.message
  }

  if (error instanceof Error && error.message.trim().length > 0) return error.message
  if (typeof error === "string" && error.trim().length > 0) return error
  return FALLBACK
}
