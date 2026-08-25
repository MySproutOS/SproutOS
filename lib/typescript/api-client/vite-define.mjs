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

export class LocalhostInDeployedBuildError extends Error {
  name = "LocalhostInDeployedBuildError"

  constructor(mode, name, value) {
    super(
      `${name} is ${JSON.stringify(value)} in a \`--mode ${mode}\` build. It is inlined into the ` +
        "bundle, so every browser that loads this app would be sent to a machine that is not the " +
        "one serving it. This is what the repo-root .env holds for local development, and " +
        "`envDir: REPO_ROOT` is why the build sees it — override it in the build's environment.",
    )
  }
}

/** Hosts that are correct in development and wrong in anything a browser reaches over a network. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"])

/**
 * @param {string} mode
 * @param {string} name
 * @param {string} value
 */
function rejectLocalhost(mode, name, value) {
  if (!DEPLOYED_MODES.has(mode) || value === "") return
  const host = URL.canParse(value) ? new URL(value).hostname : value
  if (LOCAL_HOSTS.has(host.replace(/^\[|\]$/g, ""))) {
    throw new LocalhostInDeployedBuildError(mode, name, value)
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
  rejectLocalhost(mode, "NEXT_PUBLIC_API_URL", url)
  /*
    `VITE_NEXTJS_URL` is the control plane's own origin, and it is what both SPAs send an
    unauthenticated visitor to: `${VITE_NEXTJS_URL}/login?next=…`. The repo-root `.env` holds
    `http://localhost:3000` for development, `envDir` points the build at that file, and so a
    deployed dashboard sent every signed-out visitor to their own machine. Observed on
    app.selloutjobs.com: sign-in with GitHub completed, the user and session rows were written, and
    the browser landed on `http://localhost:3000/login?next=/dashboard`.

    Checked rather than defined, because it is read through `import.meta.env` — Vite substitutes it
    on its own once the value is right, and adding a second substitution here would be a second
    place for it to be wrong.
  */
  rejectLocalhost(mode, "VITE_NEXTJS_URL", env.VITE_NEXTJS_URL ?? "")

  return {
    "process.env.NODE_ENV": JSON.stringify(mode === "development" ? "development" : "production"),
    "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(url),
    /*
      Stripe's publishable key, for the dashboard's Add-credit dialog.

      Substituted rather than read through `import.meta.env`, because the name already exists: it is
      `STRIPE_PUBLIC_KEY` in `.template.env`, in `bin/put-app-secrets.sh` and in
      `tofu/user-data.sh.tftpl`. Adding a `VITE_`-prefixed twin so Vite would expose it natively
      would give one value two names, and the failure that produces is the pair disagreeing — a
      dashboard confirming payments against one Stripe account while the API creates them in
      another, which surfaces to the customer as a declined card.

      Empty is a supported state and not an error: the dialog disables its own button with a reason
      when the key is missing, so a deployment without Stripe still serves a readable billing page.
    */
    "process.env.STRIPE_PUBLIC_KEY": JSON.stringify(env.STRIPE_PUBLIC_KEY ?? ""),
  }
}

export class DevelopmentProductionBuildError extends Error {
  name = "DevelopmentProductionBuildError"

  constructor(mode, nodeEnv) {
    super(
      `\`vite build --mode ${mode}\` resolved isProduction=false (process.env.NODE_ENV is ` +
        `${JSON.stringify(nodeEnv)}). Vite takes a NODE_ENV supplied through \`envDir\` over its ` +
        "own mode, so this build would emit the development JSX transform and load React's " +
        "development build — 222 KB larger, slower, and white-screening as soon as the runtime is " +
        "correctly told it is production. Remove NODE_ENV from the .env file this app's `envDir` " +
        "points at, or set NODE_ENV=production in the build's environment.",
    )
  }
}

/**
 * A plugin that refuses a deployed-mode build Vite does not consider production.
 *
 * The `define` above fixes what the *runtime* believes. It cannot fix what the *transform* did:
 * `@vitejs/plugin-react` reads `config.isProduction` to choose between `jsx` and `jsxDEV`, and by
 * the time this module runs that decision is made. Correcting only the runtime turns a silently
 * oversized bundle into a blank page, which is a worse failure than the one it replaced — unless
 * the build stops here and says why.
 *
 * `configResolved` rather than `config`: `isProduction` does not exist until Vite has merged the
 * mode, the environment, and every `.env` file it decided to read.
 */
export function assertProductionBuild() {
  return {
    name: "sproutos:assert-production-build",
    /**
     * Annotated rather than left implicit. Vite's own types are not reachable from a `.mjs` with no
     * `@type` import, so `config` is `any` and the type-aware lint rejects every read off it — the
     * two fields used are named here instead, which is both what silences it and what documents the
     * only part of the resolved config this cares about.
     *
     * @param {{ mode: string, isProduction: boolean }} config
     */
    configResolved(config) {
      if (DEPLOYED_MODES.has(config.mode) && !config.isProduction) {
        throw new DevelopmentProductionBuildError(config.mode, process.env.NODE_ENV)
      }
    },
  }
}
