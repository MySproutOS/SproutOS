/**
 * A project name as a GitHub repository name.
 *
 * Its own module rather than a helper inside the dialog, so it can be tested without dragging a
 * React component and its data hooks into the test.
 *
 * The result has to land inside what GitHub accepts, because it is pre-filled and most people will
 * not edit it. A default that produces an invalid name is worse than no default: the create runs
 * in a background job, so the rejection arrives minutes later with the form long gone.
 *
 * Leading and trailing hyphens are trimmed even though GitHub allows them — they come from
 * punctuation nobody thought of as part of the name, and `-my-app-` reads as a mistake.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 100)
}
