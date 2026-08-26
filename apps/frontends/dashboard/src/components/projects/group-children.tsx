import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { getV1OrgsByOrgSlugServicesOptions } from "@lib/api-client/generated/@tanstack/react-query.gen"
import { Badge } from "@ui/base/ui/badge"
import { Card, CardContent } from "@ui/base/ui/card"
import { Skeleton } from "@ui/base/ui/skeleton"
import { DatabaseIcon } from "lucide-react"
import { type Project, useProjects } from "@frontends/dashboard/data/projects"

/**
 * What a group actually contains: its projects, and the databases those projects use.
 *
 * The second half is the point. The question this answers was asked directly — "would our AI get
 * confused on which database to use?" — and a group listing every datastore its children hold is
 * the shape of the answer a person needs before they can trust an agent with it: one place that
 * says this repository's web app talks to that Postgres and its API talks to the same one.
 *
 * Services are read once for the organization and grouped here rather than fetched per child. A
 * group with six projects would otherwise make six requests to render one panel, and the list
 * endpoint already returns the `projectId` each service is attached to.
 */
export function GroupChildren({ orgSlug, group }: { orgSlug: string; group: Project }) {
  const projects = useProjects(orgSlug)
  const services = useQuery(getV1OrgsByOrgSlugServicesOptions({ path: { orgSlug } }))

  const children = (projects.data ?? []).filter((project) => project.parentProjectId === group.id)

  const byProject = new Map<string, { id: string; name: string; kind: string; status: string }[]>()
  for (const service of services.data?.data ?? []) {
    if (service.projectId === null || service.projectId === undefined) continue
    const list = byProject.get(service.projectId) ?? []
    list.push({ id: service.id, name: service.name, kind: service.kind, status: service.status })
    byProject.set(service.projectId, list)
  }

  if (projects.isPending) return <Skeleton className="h-40 w-full rounded-lg" />

  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="eyebrow">Projects in this group</h2>

      {children.length === 0 ? (
        <p className="rule-soft rounded-lg border px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing in this group yet. A project created against this repository can be placed here.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {children.map((child) => {
            const databases = byProject.get(child.id) ?? []

            return (
              <Card key={child.id}>
                <CardContent className="flex flex-col gap-3 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <Link
                      to="/orgs/$orgSlug/projects/$projectId"
                      params={{ orgSlug, projectId: child.id }}
                      className="truncate text-sm font-medium hover:text-leaf"
                    >
                      {child.name}
                    </Link>
                    {child.url === null ? (
                      <span className="text-[11.5px] text-muted-foreground">not deployed</span>
                    ) : (
                      <a
                        href={child.url}
                        target="_blank"
                        rel="noreferrer"
                        className="tnum truncate font-mono text-[11.5px] text-muted-foreground hover:text-leaf hover:underline"
                      >
                        {new URL(child.url).host}
                      </a>
                    )}
                  </div>

                  {/*
                    Databases per child, not per group.

                    Two projects in one group frequently share a database and just as frequently do
                    not, and rolling them up to the group would lose exactly the distinction anybody
                    reading this panel is trying to make.
                  */}
                  {databases.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground">No databases attached.</p>
                  ) : (
                    <ul className="flex flex-wrap gap-1.5">
                      {databases.map((service) => (
                        <li key={service.id}>
                          <Badge variant="outline" className="gap-1.5 font-normal">
                            <DatabaseIcon className="size-3" aria-hidden="true" />
                            <span className="truncate">{service.name}</span>
                            <span className="tnum font-mono text-[10px] text-muted-foreground">
                              {service.kind}
                            </span>
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </section>
  )
}
