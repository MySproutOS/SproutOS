import { Button } from "@ui/base/ui/button"
import { Checkbox } from "@ui/base/ui/checkbox"
import { Label } from "@ui/base/ui/label"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/settings")({
  component: AdminSettingsPage,
})

function AdminSettingsPage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Admin Settings</h1>
      <div className="max-w-md space-y-6 rounded-lg border bg-card p-6">
        <div className="flex items-center gap-3">
          <Checkbox id="maintenance" />
          <Label htmlFor="maintenance">Maintenance mode</Label>
        </div>
        <div className="flex items-center gap-3">
          <Checkbox id="registration" defaultChecked />
          <Label htmlFor="registration">Allow new registrations</Label>
        </div>
        <div className="flex items-center gap-3">
          <Checkbox id="audit-log" defaultChecked />
          <Label htmlFor="audit-log">Enable audit logging</Label>
        </div>
        <Button>Save Settings</Button>
      </div>
    </div>
  )
}
