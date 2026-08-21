# 0005 — The product was never in the image

Found by pointing a real domain at the platform and trying to sign in. Everything up to that point
had been checked: manifests validated, pods Running, probes passing, a conformance script green
across three clouds. None of it touched the product.

Four defects, each of which left a system that looked deployed.

---

## 1. There was no way in

`deploy/platform/apps.yaml` declares `website` and `internal-api` as **ClusterIP** Services.
`tofu/` provisions no load balancer for them. Kourier has a public address but only reconciles
Knative's own `Ingress` CRD, so it never looks at a plain Deployment.

There was no Ingress, no Gateway, and no LoadBalancer anywhere in `deploy/` or `tofu/`.

**How it looked:** every manifest applied, every pod Ready, `kubectl get svc` listed both services
with sensible ports. From inside the cluster, `curl http://website.sproutos-system:3000` returned
the marketing page. From the internet there was nothing to connect to, and nothing said so.

**Why nothing caught it:** the smoke script asserts pods reach `Running` and Services have
endpoints. Both were true. Reachability from outside the cluster is not a property any in-cluster
check can observe — you have to be outside.

**Fixed by** `deploy/platform/ingress.yaml`, plus `ingress-nginx` and `cert-manager` in the cluster
bootstrap. Two ingress paths now exist deliberately: nginx for the control plane, which must not
scale to zero, and Kourier for tenant apps, which should.

---

## 2. The authenticated product was not in the image

`apps/website/src/proxy.ts` rewrites every authenticated request to `/dashboard/index.html` or
`/admin/index.html` **on its own origin**. Its comment says so: "the SPAs are served by this
deployment."

Nothing built them. `docker/website.Dockerfile` ran `pnpm --filter website run build` and copied
`apps/website/public`, which was an **empty directory**. The dashboard and the admin SPA existed
only as source and as a `dist/` on a developer's laptop.

**How it looked:** the marketing site rendered perfectly. Logging in redirected to `/dashboard`,
which returned Next.js's 404 page. In development it works, because `rewriteToSpa` targets
`localhost:3002` where `vite dev` is listening — so the entire authenticated product had never once
been exercised as it ships.

**Why nothing caught it:** a smoke test that fetches `/` gets the landing page and passes. The
authenticated routes need a valid session cookie, so an unauthenticated probe cannot reach them and
an authenticated probe was never written.

**Fixed by** building both SPAs in the image and placing each where its own `base` expects:
dashboard's `index.html` under `public/dashboard/` with its assets at `public/assets/`, admin's
whole `dist` under `public/admin/`. The Dockerfile now `test`s for all three, so this cannot rot
back into an empty directory.

---

## 3. Every production SPA bundle was React's development build

Measured, on the dashboard, same commit, one line of `define` differing:

| bundle                                                | bytes     |
| ----------------------------------------------------- | --------- |
| as it shipped                                         | 1,252,403 |
| with `process.env.NODE_ENV` defined as `"production"` | 1,030,710 |

222 KB, and the size is the least of it: the shipped bundle contained React's `act(...)` warning,
the duplicate-key check, and the full invariant message table. A development React is materially
slower and logs to a user's console.

**Cause:** Vite 8 did not replace `process.env.NODE_ENV` in these client bundles, and React's entry
picks its build by reading exactly that expression.

**How it looked:** `vite build` printed a normal production summary. The app rendered correctly.
Nothing warned. This had been true for every build the repo has ever produced.

**Why nothing caught it:** there is no check anywhere that asserts a bundle is a production bundle.
The only way to find it is to grep the output for strings that should not be there — which is what
finally did.

**Fixed by** `lib/typescript/api-client/vite-define.mjs`, which sets it explicitly and carries the
measurement above so the next person to remove it knows the cost.

---

## 4. The API host was a compile-time constant, and it was somebody else's

`lib/typescript/api-client/src/index.ts` held `const API_HOST = "https://api.sproutos.dev"` —
inlined into all three browser bundles at build time. Before that it held
`https://api.nextjs-spa-split.andrewcwang.com`, the upstream template author's domain, inherited
when this repo was copied.

Every production build of all three apps sent authenticated requests, with cookies, to a host
nobody controlled. `api.sproutos.dev` at least does not resolve; the one before it did.

**Why a constant is wrong here specifically:** this platform is deliberately deployed to more than
one cloud and more than one domain. A constant cannot be right for two deployments.

**Fixed by** reading `NEXT_PUBLIC_API_URL`, inlined by Next.js natively and by Vite through the same
`define`. Unset, it is the empty string — requests go to the page's own origin, which is wrong,
immediately visible in the network panel, and incapable of sending a session cookie to a stranger.
The SPA builds refuse a production build without it.

---

## 5. The cookie was scoped where the API could not receive it

`cookieDomain()` derived `"." + hostname(NEXT_PUBLIC_HOST_URL)`. Correct for a website on the apex
with the API at `api.example.com`. On `app.selloutjobs.com` it yields `.app.selloutjobs.com`, and
`api.selloutjobs.com` is not under that — so every authenticated request arrives with no cookie and
the app looks signed out, with no error anywhere.

The function's own comment described this exact limitation. It had been read and left.

There were also **two copies** of it — one in the website, one in the API. The website sets the
cookie; the API clears it. Two copies of a cookie's `Domain` is a sign-out that silently does
nothing, waiting for one copy to be edited.

**Fixed by** `@utils/cookies`: one implementation, `SESSION_COOKIE_DOMAIN` as the explicit
mechanism, the derivation kept as an apex convenience. The registrable domain cannot be computed
without the Public Suffix List, so asking is better than guessing.

---

## What these have in common

Three of the five were **build-time** facts wearing runtime clothing: `NODE_ENV`, the API host, and
the SPA bundles are all decided when an image is built and cannot be changed by a pod's environment.
Every check the repo had ran against source or against a cluster. Nothing looked inside an image.

The two checks now in place that would have caught these:

- The website Dockerfile `test`s for the SPA files it copied. A build that produces no dashboard
  fails at build.
- `viteDefine` throws when `NEXT_PUBLIC_API_URL` is missing from a deployed-mode build.

And the check that found them, which no script can replace: point a real domain at it and try to
use it.
