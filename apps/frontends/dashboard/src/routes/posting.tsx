import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/posting")({
  component: PostingList,
})

function PostingList() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Postings (authenticated)</h1>
    </div>
  )
}
