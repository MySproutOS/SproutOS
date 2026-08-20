import { useMutation } from "@tanstack/react-query"
import { Button } from "@ui/base/ui/button"
import { Checkbox } from "@ui/base/ui/checkbox"
import { Label } from "@ui/base/ui/label"
import { postV1AuthLogoutMutation } from "@lib/api-client/generated/@tanstack/react-query.gen"
import { createFileRoute } from "@tanstack/react-router"
import { useCallback } from "react"

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  const logoutMutation = useMutation({
    ...postV1AuthLogoutMutation(),
    onSuccess: () => {
      window.location.href = `${import.meta.env.VITE_NEXTJS_URL ?? ""}/`
    },
  })

  const handleLogout = useCallback(() => {
    void logoutMutation.mutateAsync({})
  }, [logoutMutation])

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>
      <div className="max-w-md space-y-6 rounded-lg border bg-card p-6">
        <div className="flex items-center gap-3">
          <Checkbox id="notifications" />
          <Label htmlFor="notifications">Email notifications</Label>
        </div>
        <div className="flex items-center gap-3">
          <Checkbox id="marketing" />
          <Label htmlFor="marketing">Marketing emails</Label>
        </div>
        <div className="flex items-center gap-3">
          <Checkbox id="dark-mode" />
          <Label htmlFor="dark-mode">Dark mode</Label>
        </div>
        <Button>Save Preferences</Button>
      </div>
      <div className="mt-8 max-w-md rounded-lg border border-destructive/50 bg-card p-6">
        <h2 className="mb-2 text-lg font-semibold">Logout</h2>
        <p className="mb-4 text-sm text-muted-foreground">Sign out of your account.</p>
        <Button variant="destructive" disabled={logoutMutation.isPending} onClick={handleLogout}>
          {logoutMutation.isPending ? "Logging out..." : "Logout"}
        </Button>
      </div>
    </div>
  )
}
