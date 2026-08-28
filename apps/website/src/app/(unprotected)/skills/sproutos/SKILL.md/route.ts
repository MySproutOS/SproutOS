export function GET(): Response {
  const api = process.env.NEXT_PUBLIC_API_URL ?? "https://api.sproutos.me"
  return Response.redirect(`${api}/v1/sproutos-skill`, 307)
}
