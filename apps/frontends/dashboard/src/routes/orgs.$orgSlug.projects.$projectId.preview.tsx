import { createFileRoute } from "@tanstack/react-router"

import { SandboxPreviewPanel } from "@frontends/dashboard/components/sandbox/preview-panel"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"

/**
 * Watching the agent's dev server, in a browser tab, without a remote desktop.
 *
 * The sandbox driver has carried a `displayUrl` since it was written — an X server, a window
 * manager and a VNC bridge — and nothing has ever called it. That is the right outcome: a Vite or
 * Next dev server is ordinary HTTP on an ordinary port, and the useful thing to look at is the page
 * itself, not a picture of a browser looking at the page. A picture of a browser also cannot be
 * clicked on a phone, cannot be zoomed, and costs a video stream per viewer.
 */
export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/preview")({
  component: Preview,
})

function Preview() {
  const { orgSlug, projectId } = Route.useParams()

  return (
    <>
      <PageHeader title="Preview" />
      <PageBody>
        <p className="mb-4 text-sm text-muted-foreground">
          The dev server running in this project&rsquo;s sandbox.
        </p>
        <SandboxPreviewPanel orgSlug={orgSlug} projectId={projectId} />
      </PageBody>
    </>
  )
}
