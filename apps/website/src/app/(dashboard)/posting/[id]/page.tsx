export default async function PostingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <div>Posting {id} (unauthenticated). Log in to manage this posting.</div>
}
