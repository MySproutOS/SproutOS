/** A deployable directory inside a connected repository. */
export function isProjectRootDir(value: string): boolean {
  const path = value.trim()
  if (path === ".") return true
  if (path.length === 0 || path.length > 255 || path.startsWith("/") || path.endsWith("/")) {
    return false
  }
  if (path.includes("\\") || path.includes("\0")) return false
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}
