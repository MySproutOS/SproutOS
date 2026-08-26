import { Button } from "@ui/base/ui/button"
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { ExternalLinkIcon, MonitorPlayIcon, RefreshCwIcon } from "lucide-react"
import { useState } from "react"

import { COMMON_PREVIEW_PORTS, useSandboxPreview } from "@frontends/dashboard/data/sandbox-preview"

/**
 * The dev server running in the agent's sandbox, in the customer's own browser.
 *
 * No VNC, no desktop. Vite and Next serve ordinary HTTP on an ordinary port, and the platform mints
 * a signed short-lived link for any port — so this is an `iframe`, which is both simpler and the
 * only version that works on a phone.
 *
 * The frame is sandboxed. What runs inside is the customer's own application, but it is *also*
 * whatever an agent has just written, on our origin's neighbouring subdomain — so it gets scripts
 * and forms and nothing else. `allow-same-origin` is deliberately absent: the preview host is not
 * ours to trust, and granting it would let that page reach into storage it has no business in.
 */
export function SandboxPreviewPanel({
  orgSlug,
  projectId,
}: {
  orgSlug: string
  projectId: string
}) {
  const [port, setPort] = useState<number | undefined>(undefined)
  const [draft, setDraft] = useState("")
  const { data, error, isPending, refresh } = useSandboxPreview(orgSlug, projectId, port)

  if (isPending) {
    return <div className="h-[70vh] animate-pulse rounded-lg border border-border bg-muted/30" />
  }

  if (error !== null || data === undefined) {
    return (
      <EmptyState>
        <EmptyStateIcon>
          <MonitorPlayIcon />
        </EmptyStateIcon>
        <EmptyStateTitle>Nothing is running yet</EmptyStateTitle>
        <EmptyStateDescription>
          {/*
            The honest sentence. A 404 here means there is no sandbox — which is the normal state
            for a project nobody is working on, not an error, and saying "failed to load preview"
            would send someone looking for a fault that is not there.
          */}
          Start the agent and run your dev server. Once it is listening, its output appears here —
          no remote desktop required.
        </EmptyStateDescription>
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="preview-port">Port</Label>
          <div className="flex gap-1">
            <Input
              id="preview-port"
              className="w-24"
              inputMode="numeric"
              placeholder={String(data.port)}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                const parsed = Number(draft)
                // Refuse rather than send: the API would reject it anyway, and a validation error
                // for a value the field could have caught is a worse way to learn you typed a word.
                if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) setPort(parsed)
              }}
            />
            {COMMON_PREVIEW_PORTS.map((candidate) => (
              <Button
                key={candidate}
                size="sm"
                variant={data.port === candidate ? "secondary" : "ghost"}
                onClick={() => {
                  setPort(candidate)
                  setDraft("")
                }}
              >
                {candidate}
              </Button>
            ))}
          </div>
        </div>

        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={refresh}>
            <RefreshCwIcon />
            Reload
          </Button>
          {/*
            `noopener` because the preview runs code we did not write. Without it the opened page
            can reach back through `window.opener` and navigate this one.
          */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open(data.url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLinkIcon />
            Open
          </Button>
        </div>
      </div>

      <iframe
        // Keyed by URL so a refreshed link remounts the frame. Without the key React keeps the old
        // `src` and the customer stares at an expired page wondering why Reload did nothing.
        key={data.url}
        src={data.url}
        title="Sandbox preview"
        className="h-[70vh] w-full rounded-lg border border-border bg-background"
        sandbox="allow-scripts allow-forms allow-popups"
      />
    </div>
  )
}
