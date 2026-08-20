import { Button } from "@ui/base/ui/button"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/profile")({
  component: ProfilePage,
})

function ProfilePage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Profile</h1>
      <div className="max-w-md space-y-4 rounded-lg border bg-card p-6">
        <div>
          <p className="text-sm text-muted-foreground">Name</p>
          <p className="text-lg">John Doe</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Email</p>
          <p className="text-lg">john@example.com</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Role</p>
          <p className="text-lg">Member</p>
        </div>
        <Button variant="outline">Edit Profile</Button>
      </div>
    </div>
  )
}
