import { useState } from "react"
import { Button } from "@ui/base/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import {
  useIssueOauthClientSecret,
  useOauthClientSecrets,
  useRevokeOauthClientSecret,
} from "@frontends/dashboard/data/oauth-clients"

/**
 * A confidential client's secrets, which can be listed but never re-read.
 *
 * The table shows the last four characters and nothing else, because that is all the platform
 * keeps. Issuing is therefore additive rather than a rotation: you add a second secret, move the
 * application onto it, and revoke the first — which is the only way to rotate without a window
 * where the application cannot authenticate.
 */
export function ClientSecrets({ orgSlug, clientId }: { orgSlug: string; clientId: string }) {
  const [open, setOpen] = useState(false)
  const [issued, setIssued] = useState<string | null>(null)

  const { data, isPending } = useOauthClientSecrets(orgSlug, clientId, open)
  const issue = useIssueOauthClientSecret(orgSlug, clientId)
  const revoke = useRevokeOauthClientSecret(orgSlug, clientId)

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="mt-4"
        onClick={() => {
          setOpen(true)
        }}
      >
        Client secrets
      </Button>
    )
  }

  return (
    <div className="mt-4 rounded-lg border bg-background/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">Client secrets</h4>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={issue.isPending}
            onClick={() => {
              issue.mutate(
                { path: { orgSlug, clientId } },
                {
                  onSuccess: (created) => {
                    setIssued(created.secret)
                  },
                },
              )
            }}
          >
            {issue.isPending ? "Issuing…" : "Issue new secret"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false)
            }}
          >
            Hide
          </Button>
        </div>
      </div>

      {issued !== null && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">
            Copy it now — only the hash is kept, so it cannot be shown again.
          </p>
          <pre className="mt-1.5 overflow-x-auto rounded-md border bg-background p-2 font-mono text-xs break-all">
            {issued}
          </pre>
        </div>
      )}

      {isPending ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : (data?.length ?? 0) === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          None yet. This application cannot obtain a token until it has one.
        </p>
      ) : (
        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead>Secret</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((secret) => (
              <TableRow key={secret.id}>
                <TableCell className="font-mono text-xs">…{secret.lastFour}</TableCell>
                <TableCell className="text-xs">{secret.createdLabel}</TableCell>
                <TableCell className="text-xs">
                  {/* Never used is worth seeing: it usually means the application was never
                      switched onto this secret, which is the step people forget mid-rotation. */}
                  {secret.lastUsedLabel ?? "never"}
                </TableCell>
                <TableCell className="text-right">
                  {secret.revokedLabel === null ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => {
                        revoke.mutate({ path: { orgSlug, clientId, secretId: secret.id } })
                      }}
                    >
                      Revoke
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      revoked {secret.revokedLabel}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
