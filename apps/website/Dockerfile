# The website and the API, as one image.
#
# They ship together because they release together: the site calls the API over HTTP, the two are
# built from one commit, and `cutover.sh` already had to move both listener rules at once because
# they are the same instances. Two images with one lifecycle is bookkeeping without a benefit.
#
# The worker runs from this image too, as a third container in the same task with a different
# command. One image, three containers, one instance — see `tofu/ecs.tf`. The free tier is 750
# instance-hours a month in aggregate, which is one instance running continuously, so three
# processes share it rather than three instances sitting mostly idle.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:24.14.0-slim AS build

# `--mount=type=cache` is deliberately not used: this builds in GitHub Actions where the cache is
# cold every run, and the mount would add a layer of indirection for nothing.
WORKDIR /src
RUN corepack enable

# Dependencies before source, which is the whole reason this is a Dockerfile and not a tarball.
#
# Everything below this line changes on every commit; everything above changes when a dependency
# does. Copying the manifests first means a code-only deploy reuses the installed layer — the
# difference between pushing ~15 MB and pushing the ~300 MB dependency tree on every release.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/website/package.json apps/website/
COPY apps/internal-api/package.json apps/internal-api/
COPY packages/db/package.json packages/db/
COPY lib/typescript/ lib/typescript/
COPY packages/ packages/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build --filter=website --filter=@api/internal

# The production dependency tree, resolved here so it is resolved for *this* platform. A tree built
# on a developer's macOS laptop puts `darwin-arm64` binaries into an image bound for Linux, and
# nothing fails until something tries to run one.
RUN pnpm --filter=@api/internal deploy --prod --legacy \
      --config.node-linker=hoisted /prod/api

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
FROM node:24.14.0-slim AS runtime

# Everything the instances used to be missing.
#
# The EC2 release was a tarball, and each of these had to be arranged by hand on a stock Amazon
# Linux image — a runtime that was not installed, static assets Next deliberately excludes, and a
# home directory a dynamic user did not have. Each one built, packaged and shipped cleanly and then
# failed on the box. In an image they are not steps that can be forgotten; they are the artifact.
ENV NODE_ENV=production \
    PORT=8080 \
    API_PORT=3001 \
    HOME=/home/node

WORKDIR /opt/sproutos

COPY --from=build /src/apps/website/.next/standalone/ ./
# `.next/static` and `public/` are excluded from standalone output on purpose — Next assumes a CDN
# serves them. They are copied in anyway so the image is correct standing alone; when the CDN is in
# front, it is an optimisation rather than a dependency.
COPY --from=build /src/apps/website/.next/static ./apps/website/.next/static
COPY --from=build /src/apps/website/public ./apps/website/public
COPY --from=build /src/apps/internal-api/build/ ./api/
COPY --from=build /prod/api/node_modules ./api/node_modules

# Amazon's RDS certificate authority. Node does not ship it, so `sslmode=require` connects and then
# fails verification with "self-signed certificate in certificate chain" — which reads as a broken
# database rather than a missing root.
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /etc/ssl/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem

COPY --chmod=0755 apps/website/docker-entrypoint.sh /usr/local/bin/entrypoint

# The `node` user ships with the base image and owns nothing here. Running as root would give a
# process that only serves HTTP the ability to rewrite its own code.
USER node

EXPOSE 8080 3001

# One process per container, and the task definition says which.
#
# There is no shell supervising two children here, which is what the EC2 release did. That shape
# gave one log stream for two processes, one memory limit for both, and a `wait -n` that had to be
# got exactly right or a dead process went unnoticed. Three containers give ECS the job instead:
# separate logs, separate reservations, and a crash that is visible as a container exit rather than
# inferred from a health check.
#
# The default is the website, so `docker run` on this image does the obvious thing.
ENTRYPOINT ["entrypoint"]
CMD ["node", "/opt/sproutos/apps/website/server.js"]
