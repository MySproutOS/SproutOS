import { useMutation, useQuery } from "@tanstack/react-query"
import {
  deleteV1UserMeImpersonationMutation,
  getV1UserMeImpersonationOptions,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import { Button } from "@ui/base/ui/button"

/**
 * A band across the top of every screen when this session is not really yours.
 *
 * The audit trail records who was behind a support session; it does not stop the support engineer
 * forgetting. This does. An admin who loses track of which tab is which is how a session meant for
 * reading becomes an accidental change to a customer's account — and the only place that would ever
 * have said so is the customer's own audit log, read after the fact.
 *
 * Destructive colours on purpose. This is not information, it is a warning, and the amber `--husk`
 * token is reserved for money.
 */
export function ImpersonationBanner() {
  const { data } = useQuery(getV1UserMeImpersonationOptions())
  const end = useMutation({
    ...deleteV1UserMeImpersonationMutation(),
    onSuccess: () => {
      // Hard navigation: the cookie is gone, so every cached query belongs to somebody else.
      window.location.href = `${import.meta.env.VITE_NEXTJS_URL ?? ""}/dashboard`
    },
  })

  if (data?.impersonating !== true) return null

  return (
    <div className="flex items-center justify-between gap-4 border-b border-destructive/40 bg-destructive/12 px-4 py-2">
      <p className="text-xs text-destructive">
        You are signed in as this user for support
        {data.impersonatorEmail === null ? "" : `, as ${data.impersonatorEmail}`}. Everything you do
        is recorded in their audit trail.
      </p>
      <Button
        variant="destructive"
        size="sm"
        disabled={end.isPending}
        onClick={() => {
          end.mutate({})
        }}
      >
        {end.isPending ? "Ending…" : "End session"}
      </Button>
    </div>
  )
}
