import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/posting/$id")({
  component: PostingDetail,
})

function PostingDetail() {
  const { id } = Route.useParams()
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Posting {id} (authenticated)</h1>
    </div>
  )
}
