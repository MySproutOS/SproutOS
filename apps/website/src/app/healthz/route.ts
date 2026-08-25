/**
 * Liveness for the load balancer, and nothing else.
 *
 * The target group calls this every fifteen seconds and requires a 200. Without it the path fell
 * through `proxy.ts` to the dashboard branch and answered **307 to /login** — a perfectly correct
 * response to an unauthenticated request for an authenticated route, and one the ALB reads as a
 * failed health check. Every instance served traffic happily and was marked unhealthy.
 *
 * It answers for the process only: no database, no Valkey, no upstream. That is the same split
 * `apps/internal-api/src/health.ts` documents at length — a liveness probe that checks a dependency
 * turns a dependency outage into a restart loop that outlives its own cause. The API's own
 * readiness is checked separately, on its own target group.
 */
export const dynamic = "force-dynamic"

export function GET(): Response {
  return new Response("ok", {
    status: 200,
    headers: {
      "content-type": "text/plain",
      // Nothing should ever serve this from a cache — a cached 200 is a health check that passes
      // for a process that has stopped.
      "cache-control": "no-store",
    },
  })
}
