import {
  getV1OrgsByOrgSlugProjectsByProjectIdSandboxPreviewOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdSandboxPreviewQueryKey,
  postV1OrgsByOrgSlugProjectsByProjectIdSandboxActivityMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect } from "react"

/**
 * The dev server running inside the sandbox, as a link the browser can load.
 *
 * The agent works in a Daytona sandbox and runs the project's dev server there. Watching it used to
 * mean a desktop and a VNC bridge; it does not need one. Vite and Next serve ordinary HTTP on an
 * ordinary port, and the platform already mints a signed, short-lived preview link for any port —
 * so the thing a customer wants to see is an `iframe`, not a remote desktop.
 *
 * That link is why `previewUrl` signs rather than sending a header token: an `iframe` cannot set
 * headers, and the provider's only other option is marking the sandbox public, which puts a
 * customer's unfinished work behind a guessable URL with no authentication.
 */

/** What most dev servers land on, and what the platform assumes when nobody has said otherwise. */
export const COMMON_PREVIEW_PORTS = [3000, 5173, 8080, 4321, 1420] as const

/**
 * Refresh a minute before the link dies.
 *
 * The link is short-lived on purpose. Reloading exactly at expiry would show the customer a broken
 * frame for however long the round trip takes; a minute of margin is invisible and costs one extra
 * request per link lifetime.
 */
const REFRESH_MARGIN_MS = 60_000
const ACTIVITY_HEARTBEAT_MS = 60_000

export function useSandboxPreview(orgSlug: string, projectId: string, port?: number) {
  const client = useQueryClient()
  const { mutate: recordActivity } = useMutation({
    ...postV1OrgsByOrgSlugProjectsByProjectIdSandboxActivityMutation(),
  })

  const query = useQuery({
    ...getV1OrgsByOrgSlugProjectsByProjectIdSandboxPreviewOptions({
      path: { orgSlug, projectId },
      query: port === undefined ? {} : { port },
    }),
    /*
      Not retried, and not refetched on focus.

      "No running sandbox for this project" is the ordinary state for a project nobody is working
      on, and it arrives as a 404. Retrying it three times turns a normal empty state into three
      seconds of spinner, and refetching on focus does it again every time the tab is looked at.
    */
    retry: false,
    refetchOnWindowFocus: false,
    /*
      Kept fresh against its own expiry rather than a fixed interval.

      The server decides how long a link lives; hardcoding a number here would be a second opinion
      about that, and the two would drift the moment the TTL changed.
    */
    refetchInterval: (self) => {
      const expiresAt = self.state.data?.expiresAt
      if (expiresAt === undefined) return false
      const remaining = new Date(expiresAt).getTime() - Date.now() - REFRESH_MARGIN_MS
      return remaining > 0 ? remaining : 1000
    },
  })

  const refresh = useCallback(() => {
    void client.invalidateQueries({
      queryKey: getV1OrgsByOrgSlugProjectsByProjectIdSandboxPreviewQueryKey({
        path: { orgSlug, projectId },
        query: port === undefined ? {} : { port },
      }),
    })
  }, [client, orgSlug, projectId, port])

  useEffect(() => {
    if (query.data === undefined) return

    const heartbeat = () => {
      recordActivity({ path: { orgSlug, projectId } })
    }
    const interval = window.setInterval(heartbeat, ACTIVITY_HEARTBEAT_MS)
    return () => {
      window.clearInterval(interval)
    }
  }, [orgSlug, projectId, query.data, recordActivity])

  return { ...query, refresh }
}
