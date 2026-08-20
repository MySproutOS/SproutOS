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

FROM node:24-alpine AS runtime
# `tini` as PID 1. Node does not reap zombies and does not forward SIGTERM to children, so without
# it a rolling deploy waits out the full termination grace period on every pod.
RUN apk add --no-cache tini
WORKDIR /app

COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/website ./apps/website
COPY --from=build /src/lib ./lib
COPY --from=build /src/packages ./packages

# `node`, the image's own unprivileged user. Same reasoning as the Rust images: an image that only
# runs as non-root because the orchestrator said so runs as root everywhere else.
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/website/server.js"]
