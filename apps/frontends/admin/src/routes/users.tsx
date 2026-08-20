import { Button } from "@ui/base/ui/button"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/users")({
  component: UsersPage,
})

const mockUsers = [
  { id: "1", name: "Alice Johnson", email: "alice@example.com", isAdmin: true },
  { id: "2", name: "Bob Smith", email: "bob@example.com", isAdmin: false },
  { id: "3", name: "Carol White", email: "carol@example.com", isAdmin: false },
  { id: "4", name: "Dave Brown", email: "dave@example.com", isAdmin: true },
]

function UsersPage() {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Users</h1>
        <Button>Add User</Button>
      </div>
      <div className="rounded-lg border">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left text-sm font-medium">Name</th>
              <th className="px-4 py-3 text-left text-sm font-medium">Email</th>
              <th className="px-4 py-3 text-left text-sm font-medium">Role</th>
              <th className="px-4 py-3 text-left text-sm font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {mockUsers.map((user) => (
              <tr key={user.id} className="border-b last:border-b-0">
                <td className="px-4 py-3 text-sm">{user.name}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{user.email}</td>
                <td className="px-4 py-3 text-sm">
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${user.isAdmin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                  >
                    {user.isAdmin ? "Admin" : "Member"}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm">
                  <Button variant="ghost" size="sm">
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
