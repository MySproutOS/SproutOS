import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: AdminHome,
})

function AdminHome() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Admin Overview</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">Total Users</p>
          <p className="mt-1 text-3xl font-bold">1,247</p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">Active Sessions</p>
          <p className="mt-1 text-3xl font-bold">83</p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">System Health</p>
          <p className="mt-1 text-3xl font-bold text-green-500">OK</p>
        </div>
      </div>
    </div>
  )
}
