import type { Project } from "@frontends/dashboard/data/projects"

export type ProjectSection = {
  key: string
  /** Null for projects that belong to no group. */
  header: Project | null
  headerIsContext: boolean
  children: Project[]
}

/**
 * Arrange projects into groups, filtered, without changing their API order.
 *
 * The filter must not orphan a child. A query matching only a child still renders its parent
 * header because the group is what makes the child's name legible: two repositories can both
 * have an `api`, and a flat list of matches cannot tell you which is which.
 */
export function groupProjects(projects: readonly Project[], query: string): ProjectSection[] {
  const needle = query.trim().toLowerCase()
  const matches = (project: Project) =>
    needle === "" ||
    project.name.toLowerCase().includes(needle) ||
    project.repo.toLowerCase().includes(needle)

  const groups = projects.filter((project) => project.isGroup)
  const byId = new Map(groups.map((project) => [project.id, project]))
  const sections: ProjectSection[] = []

  for (const header of groups) {
    const children = projects.filter(
      (project) => project.parentProjectId === header.id && matches(project),
    )
    const headerMatches = matches(header)

    if (children.length === 0 && !headerMatches) continue
    if (children.length === 0 && headerMatches) {
      sections.push({ key: header.id, header, headerIsContext: false, children: [] })
      continue
    }

    sections.push({
      key: header.id,
      header,
      headerIsContext: !headerMatches,
      children,
    })
  }

  /*
    Projects belonging to no group, and projects whose group is missing.

    The second case is defensive rather than theoretical: a child's parent can be absent from a
    paginated response or removed before the child is refreshed. Showing that child as ungrouped
    is better than silently dropping it.
  */
  const loose = projects.filter(
    (project) =>
      !project.isGroup &&
      (project.parentProjectId === null || !byId.has(project.parentProjectId)) &&
      matches(project),
  )

  if (loose.length > 0) {
    sections.push({ key: "__loose", header: null, headerIsContext: false, children: loose })
  }

  return sections
}
