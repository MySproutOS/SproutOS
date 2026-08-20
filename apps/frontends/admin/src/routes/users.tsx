import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import {
  getAdminUsersOptions,
  postAdminUsersImpersonateMutation,
} from "@lib/api-client/admin-generated/@tanstack/react-query.gen"
import type { GetAdminUsersResponse } from "@lib/api-client/admin-generated/types.gen"
import { Button } from "@ui/base/ui/button"
import { Input } from "@ui/base/ui/input"
import { useState } from "react"

export const Route = createFileRoute("/users")({
  component: UsersPage,
})

/**
 * Finding a customer, and becoming one.
 *
 * There is no "add user" here, and no edit. People arrive by signing in with GitHub, and everything
 * a platform admin might want to change about an account is changed *as* the account — through an
 * impersonated session that lands in the customer's own audit trail rather than in a private log
 * they cannot read. See `docs/adr/0019-platform-admin.md`.
 */
function UsersPage() {
  const [term, setTerm] = useState("")
  const [query, setQuery] = useState("")

  // Submitted rather than debounced. A prefix of an email address matches a great many people, and
  // firing a cross-organization scan on every keystroke is a cost with no reader.
  const { data, isPending, isError } = useQuery(
    getAdminUsersOptions({ query: query === "" ? {} : { q: query } }),
  )

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Users</h1>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(term.trim())
          }}
        >
          <Input
            value={term}
            placeholder="Email or GitHub login"
            className="w-72"
            onChange={(event) => {
              setTerm(event.target.value)
            }}
          />
          <Button type="submit">Search</Button>
        </form>
      </div>

      {isError && <p className="text-sm text-destructive">Could not load users.</p>}
      {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data !== undefined && data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {query === "" ? "No users yet." : `Nothing matches “${query}”.`}
        </p>
      )}

      {data !== undefined && data.items.length > 0 && (
        <div className="rounded-lg border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left text-sm font-medium">User</th>
                <th className="px-4 py-3 text-left text-sm font-medium">GitHub</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Teams</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Role</th>
                <th className="px-4 py-3 text-right text-sm font-medium">Support</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((user) => (
                <UserRow key={user.id} user={user} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * Taken from the generated client rather than restated.
 *
 * A hand-written copy was already wrong: the transformers turn `format: date-time` into a real
 * `Date`, so `deletedAt` is not the string the schema describes. Deriving it means the shape cannot
 * drift from what the endpoint actually returns.
 */
type AdminUser = GetAdminUsersResponse["items"][number]

function UserRow({ user }: { user: AdminUser }) {
  const [reason, setReason] = useState("")
  const [open, setOpen] = useState(false)
  const impersonate = useMutation({
    ...postAdminUsersImpersonateMutation(),
    onSuccess: () => {
      // A hard navigation, because the session cookie has just been replaced. Anything softer would
      // leave this SPA rendering an admin view against a customer's session.
      window.location.href = `${import.meta.env.VITE_NEXTJS_URL ?? ""}/dashboard`
    },
  })

  return (
    <>
      <tr className="border-b last:border-b-0">
        <td className="px-4 py-3 text-sm">
          <div>{user.name ?? user.email}</div>
          <div className="text-xs text-muted-foreground">{user.email}</div>
        </td>
        <td className="px-4 py-3 text-sm text-muted-foreground">{user.githubLogin ?? "—"}</td>
        <td className="px-4 py-3 text-sm tabular-nums">{user.organizationCount}</td>
        <td className="px-4 py-3 text-sm">
          <span
            className={`rounded-full px-2 py-1 text-xs font-medium ${user.isAdmin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
          >
            {user.deletedAt !== null ? "Closed" : user.isAdmin ? "Admin" : "Member"}
          </span>
        </td>
        <td className="px-4 py-3 text-right text-sm">
          {/*
            Refused for admins and closed accounts, and disabled here rather than left to fail: a
            button that exists only to return an error teaches people to ignore errors.
          */}
          <Button
            variant="ghost"
            size="sm"
            disabled={user.isAdmin || user.deletedAt !== null}
            onClick={() => {
              setOpen((previous) => !previous)
            }}
          >
            {open ? "Cancel" : "Sign in as"}
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/30 last:border-b-0">
          <td colSpan={5} className="px-4 py-3">
            <label className="text-xs text-muted-foreground" htmlFor={`reason-${user.id}`}>
              Why are you signing in as {user.email}? This is recorded against both of you, and they
              can read it.
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <Input
                id={`reason-${user.id}`}
                value={reason}
                placeholder="Ticket number and what you are checking"
                onChange={(event) => {
                  setReason(event.target.value)
                }}
              />
              <Button
                disabled={reason.trim().length < 10 || impersonate.isPending}
                onClick={() => {
                  impersonate.mutate({ body: { userId: user.id, reason: reason.trim() } })
                }}
              >
                {impersonate.isPending ? "Signing in…" : "Continue"}
              </Button>
            </div>
            {impersonate.isError && (
              <p className="mt-1.5 text-xs text-destructive">Could not start the session.</p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
