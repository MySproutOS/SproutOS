# The Next.js site: SEO pages, the OAuth callbacks, and the proxy that splits traffic to the SPAs.
#
# A pnpm workspace, which is the whole difficulty: `pnpm install` in a subdirectory does not work,
# and copying the whole repo into the build context invalidates the dependency layer on every source
# change. `--filter ... --prod --legacy` produces a directory holding only what this app needs.
FROM node:24-alpine AS deps

RUN corepack enable
WORKDIR /src

# Every manifest, no source. This layer is cached until a dependency actually changes, which on a
# monorepo of this size is the difference between a thirty-second build and a five-minute one.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/website/package.json ./apps/website/
COPY apps/frontends/dashboard/package.json ./apps/frontends/dashboard/
COPY apps/frontends/admin/package.json ./apps/frontends/admin/
COPY packages/db/package.json ./packages/db/
COPY lib/typescript ./lib/typescript
RUN find lib/typescript -mindepth 2 -maxdepth 3 -type d -name src -exec rm -rf {} + || true

# Three apps, not one. The two SPAs *are* the authenticated product, and this image is what serves
# them — see the build stage below.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter website... --filter dashboard... --filter admin...

FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY --from=deps /src ./
COPY . .

# The API's public origin, compiled into all three bundles.
#
# `NEXT_PUBLIC_*` is a build-time substitution in every one of these bundlers, so this cannot be a
# pod env var: by the time a container starts, the string is already in the JavaScript. An image is
# therefore specific to the domain it was built for, which is worth knowing before wondering why
# staging talks to production.
#
# No default. `lib/typescript/api-client/vite-define.mjs` throws when it is empty, so a build that
# forgets this fails here rather than shipping an app whose every request goes to its own origin
# and comes back 404.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# The control plane's own origin, inlined into both SPAs.
#
# It is where a signed-out visitor is sent — `${VITE_NEXTJS_URL}/login?next=…` — and the repo-root
# `.env` holds `http://localhost:3000` for development. Without this the deployed dashboard bounced
# every visitor to their own machine, after a sign-in that had otherwise completely succeeded.
#
# `NEXT_PUBLIC_HOST_URL` is the same fact under the name the server side already uses; the two are
# derived from one build argument so they cannot disagree about where this deployment lives.
ARG NEXT_PUBLIC_HOST_URL
ENV NEXT_PUBLIC_HOST_URL=$NEXT_PUBLIC_HOST_URL
ENV VITE_NEXTJS_URL=$NEXT_PUBLIC_HOST_URL

# The two SPAs, into this app's `public/`.
#
# **This is how the authenticated product reaches a browser, and it was missing.** `proxy.ts`
# rewrites every authenticated request to `/dashboard/index.html` or `/admin/index.html` on this
# same origin — its own comment says "the SPAs are served by this deployment" — and nothing built
# them or put them there. `apps/website/public/` was empty, so the deployed image answered every
# one of those rewrites with a 404. The marketing site rendered perfectly, which is exactly what a
# smoke test that fetches `/` would have reported.
#
# The two layouts differ because the two `base` settings differ, and each is right for where it is
# mounted:
#
#   * dashboard — `base: "/"`, so its `index.html` points at `/assets/…`. The assets go to
#     `public/assets/` at the root and the entry document to `public/dashboard/index.html`.
#   * admin — `base: "/admin/"`, so the whole `dist` drops into `public/admin/` unchanged.
#
# Getting this wrong does not fail the build: the document loads, the script 404s, and the user
# sees a blank page with no error but one in the network panel.
RUN pnpm --filter dashboard --filter admin run build \
 && mkdir -p apps/website/public/dashboard apps/website/public/admin apps/website/public/assets \
 && cp apps/frontends/dashboard/dist/index.html apps/website/public/dashboard/index.html \
 && cp -R apps/frontends/dashboard/dist/assets/. apps/website/public/assets/ \
 && cp -R apps/frontends/admin/dist/. apps/website/public/admin/ \
 && test -f apps/website/public/dashboard/index.html \
 && test -f apps/website/public/admin/index.html \
 && test "$(ls apps/website/public/assets | wc -l)" -gt 0

RUN pnpm --filter website run build

# Repair what the output tracer got wrong.
#
# `@vercel/nft` follows static `import`/`require`. Next's own server reaches `@swc/helpers` through
# the package's `exports` map at runtime, so the tracer copies only the two CJS files the compiled
# output names literally — 3 of 452 — and leaves the ESM build behind. The image builds clean and
# the server dies on its first request with MODULE_NOT_FOUND for
# `@swc/helpers/esm/_interop_require_default.js`.
#
# `outputFileTracingIncludes` does not reach this: it applies to per-route traces, and the missing
# module is loaded by the server itself. So the package is completed here, where the result is
# checkable. `cp -RL` dereferences pnpm's symlink farm; the version glob avoids pinning a hash.
#
# The `[ -d ]` guard is deliberate: if a future Next release traces this correctly and the
# directory is not there to complete, that should be a silent no-op, not a failed build. The
# `test` on the following line is what keeps this honest — it fails the build if the repair did
# not produce a usable package, so this cannot rot into a no-op that nobody notices.
RUN set -eu; \
    for pkg in /src/node_modules/.pnpm/@swc+helpers@*; do \
      dest="/src/apps/website/.next/standalone/node_modules/.pnpm/$(basename "$pkg")/node_modules/@swc/helpers"; \
      [ -d "$dest" ] || continue; \
      cp -RL "$pkg/node_modules/@swc/helpers/." "$dest/"; \
    done; \
    test -f /src/apps/website/.next/standalone/node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/esm/_interop_require_default.js

FROM node:24-alpine AS runtime
# `tini` as PID 1. Node does not reap zombies and does not forward SIGTERM to children, so without
# it a rolling deploy waits out the full termination grace period on every pod.
RUN apk add --no-cache tini
WORKDIR /app

# Standalone output, not the build tree. Next traces the modules the server actually reaches and
# writes a self-contained tree rooted at `outputFileTracingRoot` — so `/src/node_modules`,
# `/src/lib` and `/src/packages` are already inside it, in the shape the workspace had them.
# Copying the build tree instead would ship the full dev dependency graph, hundreds of megabytes
# of it, to run a server that needs a fraction.
COPY --from=build /src/apps/website/.next/standalone ./
# Two things the trace cannot see, because nothing imports them: the client bundles the browser
# fetches by URL, and the public assets.
COPY --from=build /src/apps/website/.next/static ./apps/website/.next/static
COPY --from=build /src/apps/website/public ./apps/website/public

# `node`, the image's own unprivileged user. Same reasoning as the Rust images: an image that only
# runs as non-root because the orchestrator said so runs as root everywhere else.
# See the note in deploy/platform/apps.yaml: Next's standalone server binds whatever HOSTNAME says,
# and every container runtime sets HOSTNAME to the container's own name. Left alone it binds one
# interface and refuses localhost. Set here as well as in the pod spec so `docker run` behaves too.
ENV HOSTNAME=0.0.0.0
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/website/server.js"]
