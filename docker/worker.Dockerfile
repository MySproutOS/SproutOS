# The background job worker. Same image contents as the API — different entry point, because a long job holding an event-loop turn inside the API delays every request behind it.
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
COPY apps/internal-api/package.json ./apps/internal-api/
COPY packages/db/package.json ./packages/db/
COPY lib/typescript ./lib/typescript
RUN find lib/typescript -mindepth 2 -maxdepth 3 -type d -name src -exec rm -rf {} + || true

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @api/internal...

FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY --from=deps /src ./
COPY . .
RUN pnpm --filter @api/internal run build

# The runtime tree, containing only the production dependencies this app actually declares.
# `--legacy` because the workspace is not using injected dependencies; without it pnpm 10 refuses.
#
# This matters more than it looks. The app is bundled, so the only thing `node_modules` still has
# to supply is the handful of non-workspace packages esbuild left external. Copying the build
# stage's `node_modules` instead shipped every dev dependency in the monorepo — 1.6 GB of
# TypeScript, vitest, esbuild and three frontend toolchains — into an image that runs one bundled
# file. That is pulled onto every node, on every deploy.
RUN pnpm deploy --filter=@api/internal --prod --legacy /out

FROM node:24-alpine AS runtime
# `tini` as PID 1. Node does not reap zombies and does not forward SIGTERM to children, so without
# it a rolling deploy waits out the full termination grace period on every pod.
RUN apk add --no-cache tini
WORKDIR /app

COPY --from=build /out/node_modules ./node_modules
# The bundle, and nothing else from the app: esbuild has already inlined every workspace package,
# so `lib/` and `packages/` have no runtime reader left.
COPY --from=build /src/apps/internal-api/build ./build

# `node`, the image's own unprivileged user. Same reasoning as the Rust images: an image that only
# runs as non-root because the orchestrator said so runs as root everywhere else.
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/worker.js"]
