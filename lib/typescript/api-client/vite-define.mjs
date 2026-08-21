/**
 * The compile-time constants a Vite build of these SPAs needs, and that it does not get on its own.
 *
 * Both entries here were found by building the dashboard and reading the bundle, not by reading
 * documentation. Both were wrong in a way that produced a working page.
 */

/** Vite `mode` values that produce a bundle somebody will serve to a browser over the internet. */
const DEPLOYED_MODES = new Set(["production", "staging"])

export class MissingApiUrlError extends Error {
  name = "MissingApiUrlError"

  constructor(mode) {
    super(
      `NEXT_PUBLIC_API_URL is not set, and \`vite build --mode ${mode}\` produces a bundle that ` +
        "would be served to browsers. Without it every API call goes to the page's own origin and " +
        "the app is silently signed out. Set it to the API's public origin, e.g. " +
        "https://api.example.com.",
    )
  }
}

/**
 * @param {string} mode  Vite's `mode`, from `defineConfig(({ mode }) => …)`.
 * @param {Record<string, string>} env  The result of `loadEnv(mode, dir, "")`.
 * @returns {Record<string, string>} a `define` map.
 *
 * ## `process.env.NODE_ENV`
 *
 * Defined explicitly because **Vite 8 does not replace it in these client bundles**, and React
 * decides which of its two builds to run by reading exactly that expression. Left alone it is not
 * `"production"`, so `vite build` was emitting React's *development* build — the one with the
 * `act(...)` warnings, the key-prop checks, and every invariant message spelled out.
 *
 * Measured on the dashboard, same commit, only this line differing:
 *
 * | bundle                       | bytes     |
 * | ---------------------------- | --------- |
 * | without this define          | 1,252,403 |
 * | with it                      | 1,030,710 |
 *
 * 222 KB, and the difference is not only size: a development React is materially slower and logs
 * warnings to a user's console. Nothing failed, no build warned, and the app rendered correctly the
 * whole time — which is why it survived this long.
 *
 * ## `process.env.NEXT_PUBLIC_API_URL`
 *
 * `@lib/api-client` is shared by the Next.js website and both SPAs, and it reads the API host from
 * this expression. Next.js replaces it natively; Vite replaces `import.meta.env.VITE_*` and leaves
 * anything spelled `process.env` alone, in a bundle where `process` does not exist.
 *
 * Introducing a second name — `VITE_API_URL` beside `NEXT_PUBLIC_API_URL` — would be two names for
 * one fact, and two names drift. Making Vite perform the same substitution keeps it one fact.
 *
 * Missing, it refuses rather than defaults. A default here is a hostname nobody checked, which is
 * how two different strangers' domains ended up compiled into this client's history. Development is
 * exempt: the module branches on `NODE_ENV` and uses `localhost:3001` there, so demanding a value
 * would make `pnpm dev` need configuration to start.
 */
export function viteDefine(mode, env) {
  const url = env.NEXT_PUBLIC_API_URL ?? ""
  if (url === "" && DEPLOYED_MODES.has(mode)) throw new MissingApiUrlError(mode)

  return {
    "process.env.NODE_ENV": JSON.stringify(mode === "development" ? "development" : "production"),
    "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(url),
  }
}
