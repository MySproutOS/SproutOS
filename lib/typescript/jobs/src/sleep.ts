/**
 * A pause a handler can be woken out of.
 *
 * The obvious version — `setTimeout(...).unref()` — was wrong in a way that only showed up when a
 * handler was driven from a short-lived process: an unreferenced timer does not hold the event loop
 * open, so Node exits mid-wait and the handler simply never resumes. Inside the worker it survives
 * only because the database pool happens to keep a socket referenced, which is not a guarantee
 * anyone wrote down.
 *
 * So the timer is referenced, and shutdown responsiveness comes from the signal instead: the worker
 * aborts it on SIGTERM and the wait ends immediately rather than sitting out its full interval.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    function onAbort() {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
