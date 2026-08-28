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

# Immutable supply-chain tools used by the worker. The Cosign image is pinned by its multi-arch
# index digest; this build is linux/arm64, so BuildKit selects the attested arm64 executable. The
# GitHub CLI archive is pinned by GitHub's published asset digest rather than downloaded by tag.
FROM ghcr.io/sigstore/cosign/cosign:v3.0.2@sha256:b29487e48205d875c324c79583e2806d9d269c0fa299e0861bbec023d8430c8b AS cosign

FROM node:24.14.0-slim AS worker-tools
ADD --checksum=sha256:cf689084f3a3618f7eae4a2420d335d74626d65f5e594b9828d125d69f800d86 \
    https://github.com/cli/cli/releases/download/v2.98.0/gh_2.98.0_linux_arm64.tar.gz \
    /tmp/gh.tar.gz
RUN tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -o root -g root -m 0755 /tmp/gh_2.98.0_linux_arm64/bin/gh /usr/local/bin/gh

# A native GNU addon, built inside the same arm64/glibc family as the Node runtime that loads it.
# Building it on the developer's macOS host would produce a valid `.node` file for the wrong ABI.
FROM rust:1.93.0-slim-bookworm AS sprout-node-build
WORKDIR /src
RUN apt-get update && apt-get install --yes --no-install-recommends file && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --locked --release -p sprout-node \
    && mkdir -p /out \
    && install -m 0755 target/release/libsprout_node.so \
      /out/sprout-node.linux-arm64-gnu.node \
    && file /out/sprout-node.linux-arm64-gnu.node | grep -Eq 'ELF 64-bit LSB.*(ARM aarch64|ARM64)'

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
COPY apps/dbmigrator/package.json apps/dbmigrator/
COPY packages/db/package.json packages/db/
COPY lib/typescript/ lib/typescript/
COPY packages/ packages/

RUN pnpm install --frozen-lockfile

COPY . .
# Override any host artifact in the build context with the one built for the image's exact ABI.
COPY --from=sprout-node-build /out/sprout-node.linux-arm64-gnu.node \
  /src/packages/sprout-node/sprout-node.linux-arm64-gnu.node
# The native addon was built in the Rust stage above. `--only` prevents Turbo from trying to run
# its Cargo-backed package script again in this intentionally Node-only stage.
RUN pnpm run build --filter=website --filter=@api/internal --only

# The production dependency tree, resolved here so it is resolved for *this* platform. A tree built
# on a developer's macOS laptop puts `darwin-arm64` binaries into an image bound for Linux, and
# nothing fails until something tries to run one.
RUN pnpm --filter=@api/internal deploy --prod --legacy \
      --config.node-linker=hoisted /prod/api

# The deploy-time programs are part of the image they migrate for.
#
# The legacy release assembled these in the workflow tarball, but the container image originally
# carried only the two servers and the worker. That left an ECS rollout with two bad choices: run
# migrations from the old EC2 colour, whose code can predate the schema being deployed, or update
# the service first and briefly run new code against an old schema. Keep the providers' scanned
# migration/seed files next to their bundles for the same path contract as the tarball release.
RUN mkdir -p /prod/migrator/migrations /prod/migrator/seeds \
    && (cd apps/dbmigrator && node ../internal-api/build.mjs src/cli.ts /prod/migrator/migrate.mjs) \
    && pnpm --filter=dbmigrator exec esbuild "src/migrations/*.ts" \
      --platform=node --format=esm --target=node24 \
      --outdir=/prod/migrator/migrations \
    && (cd apps/dbmigrator && node ../internal-api/build.mjs src/seed-entry.ts /prod/migrator/seed.mjs) \
    && pnpm --filter=dbmigrator exec esbuild "src/seeds/*.ts" \
      --bundle --packages=external \
      --platform=node --format=esm --target=node24 \
      --outdir=/prod/migrator/seeds \
    && (cd apps/dbmigrator && node ../internal-api/build.mjs src/clickhouse-entry.ts /prod/migrator/clickhouse.mjs)

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

# `git` prepares the upstream checkout. Bubblewrap is the root-owned namespace boundary for the
# only executable the Rust core launches. No package-manager Cosign/GitHub CLI versions are used:
# both verified binaries come from the immutable stages above.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends bubblewrap ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(stat -c '%u:%a' /usr/bin/bwrap)" = "0:755"
COPY --from=cosign --chown=0:0 --chmod=0755 /ko-app/cosign /usr/local/bin/cosign
COPY --from=worker-tools --chown=0:0 --chmod=0755 /usr/local/bin/gh /usr/local/bin/gh
RUN test "$(stat -c '%u:%a' /usr/local/bin/cosign)" = "0:755" \
    && test "$(stat -c '%u:%a' /usr/local/bin/gh)" = "0:755" \
    && cosign version >/dev/null \
    && gh version >/dev/null

COPY --from=build /src/apps/website/.next/standalone/ ./
# `.next/static` and `public/` are excluded from standalone output on purpose — Next assumes a CDN
# serves them. They are copied in anyway so the image is correct standing alone; when the CDN is in
# front, it is an optimisation rather than a dependency.
COPY --from=build /src/apps/website/.next/static ./apps/website/.next/static
COPY --from=build /src/apps/website/public ./apps/website/public
COPY --from=build /src/apps/internal-api/build/ ./api/
COPY --from=build /prod/api/node_modules ./api/node_modules
COPY --from=build /prod/migrator/ ./api/
# Rollout-only ECS isolation proof. Nothing imports this during normal startup; the security gate
# invokes this exact root-owned path through audited SSM before catalogue execution is enabled.
COPY --from=build --chown=0:0 --chmod=0555 /src/apps/internal-api/isolation-proof.mjs \
  ./api/isolation-proof.mjs
RUN node ./api/isolation-proof.mjs --self-test \
    && test "$(stat -c '%u:%a' ./api/isolation-proof.mjs)" = "0:555"

# Amazon's RDS certificate authority. Node does not ship it, so `sslmode=require` connects and then
# fails verification with "self-signed certificate in certificate chain" — which reads as a broken
# database rather than a missing root.
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /etc/ssl/rds-global-bundle.pem
# BuildKit applies the file mode to a newly materialised parent directory too. Without restoring
# traversal on `/etc/ssl`, the non-root process cannot read either OpenSSL's own configuration or
# the RDS bundle: all three ECS containers exit 13 before application code starts.
RUN chmod 0755 /etc/ssl && chmod 0644 /etc/ssl/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem

COPY --chmod=0755 apps/website/docker-entrypoint.sh /usr/local/bin/entrypoint

# The `node` user ships with the base image and owns nothing here. Running as root would give a
# process that only serves HTTP the ability to rewrite its own code.
USER node

# Assert the property that matters as the actual runtime user. A root-owned build check would pass
# even when directory traversal is missing and reproduce the production-only failure.
RUN node -e 'require("node:crypto").randomBytes(1)'

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
