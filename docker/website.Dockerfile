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
COPY packages/db/package.json ./packages/db/
COPY lib/typescript ./lib/typescript
RUN find lib/typescript -mindepth 2 -maxdepth 3 -type d -name src -exec rm -rf {} + || true

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter website...

FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY --from=deps /src ./
COPY . .
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
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/website/server.js"]
