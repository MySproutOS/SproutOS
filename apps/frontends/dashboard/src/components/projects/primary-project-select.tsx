import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/base/ui/select"
import type { Project } from "@frontends/dashboard/data/projects"

type ProjectChoice = Pick<Project, "id" | "isGroup" | "name" | "parentProjectId">

export function primaryProjectSelectModel(
  projectId: string,
  projects: ProjectChoice[] | undefined,
  value: string,
) {
  const children =
    projects?.filter(
      (candidate) => candidate.parentProjectId === projectId && !candidate.isGroup,
    ) ?? []

  return {
    children,
    items: [
      { label: "No primary project", value: "none" },
      ...children.map((candidate) => ({ label: candidate.name, value: candidate.id })),
    ],
    value,
  }
}

export function PrimaryProjectSelect({
  projectId,
  projects,
  value,
  onValueChange,
}: {
  projectId: string
  projects: ProjectChoice[] | undefined
  value: string
  onValueChange: (value: string) => void
}) {
  const model = primaryProjectSelectModel(projectId, projects, value)
  function handleValueChange(nextValue: string | null) {
    if (nextValue !== null) onValueChange(nextValue)
  }

  return (
    <Select items={model.items} value={model.value} onValueChange={handleValueChange}>
      <SelectTrigger>
        <SelectValue placeholder="No primary project" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No primary project</SelectItem>
        {model.children.map((candidate) => (
          <SelectItem key={candidate.id} value={candidate.id}>
            {candidate.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
