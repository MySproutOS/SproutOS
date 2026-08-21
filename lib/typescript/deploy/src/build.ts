/**
 * A `deployment` row rendered as a BuildKit Job.
 *
 * Pure, like `knativeService`. What an image is called, what a build is allowed to consume, and how
 * long it may run are decisions worth testing without a cluster.
 */

/** A build that will not finish costs money for as long as it runs. */
const DEFAULT_TIMEOUT_S = 20 * 60

export type BuildSpec = {
  deploymentId: string
  gitSha: string
  /** `https://github.com/owner/repo.git`, without credentials. */
  repositoryUrl: string
  /** Where the image goes: an ECR host in production. */
  registry: string
  /** The repository path within the registry, e.g. `acme/myapp`. */
  imageRepository: string
  /** Set when the registry speaks plain HTTP — a local test registry, never production. */
  insecureRegistry?: boolean
  /**
   * A `kubernetes.io/dockerconfigjson` Secret in the build namespace, mounted as the build's
   * Docker config so BuildKit can push what it built.
   *
   * **The build had no credential at all.** `deploy/builds/namespace.yaml` opens by explaining that
   * a build "needs a credential that can *push* to the registry" and why that credential cannot
   * live in a tenant namespace — and no Secret was ever created, nothing mounted one, and the Job
   * spec had no volumes. Every build ran to completion, exported an image, and died asking the
   * registry for an anonymous token:
   *
   *     failed to authorize: failed to fetch anonymous token: … 403 Forbidden
   *
   * Optional because a local registry with `insecureRegistry` needs none, which is exactly the
   * configuration the tests run in — so the tests could not have caught this.
   */
  registryAuthSecret?: string
  /**
   * The directory within the repository to build, from `project.root_dir`.
   *
   * That column has existed since the first migration. It is settable on create, settable on
   * update, part of the uniqueness key that decides whether two projects are the same target, and
   * shown in the UI — and **nothing read it**. A customer pointing a project at `apps/web` got a
   * build of the repository root, and the only symptom was a Dockerfile-not-found for a Dockerfile
   * that was right there in the directory they named.
   */
  contextSubdir?: string
  /**
   * The Dockerfile's path, relative to the build context.
   *
   * Defaulted rather than assumed. BuildKit's `dockerfile.v0` frontend looks for `Dockerfile` and
   * nothing else, which is most of why the store's own catalogue could not be deployed: of six
   * listed applications only two keep one at the repository root, and the rest are perfectly
   * ordinary projects that put it in `docker/` or name it for a variant.
   */
  dockerfilePath?: string
  timeoutSeconds?: number
}

export type BuildJob = {
  apiVersion: "batch/v1"
  kind: "Job"
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: Record<string, unknown>
}

/**
 * The image a build produces.
 *
 * Tagged with the commit, never `latest`. A deployment records the exact `image_uri` it ran, and a
 * moving tag would make that record a lie the first time anything was rebuilt — which is precisely
 * when somebody is trying to work out what changed.
 */
export function imageUri(spec: BuildSpec): string {
  return `${spec.registry}/${spec.imageRepository}:${spec.gitSha}`
}

/** One build per deployment, named so a retried job addresses the same Job rather than a second one. */
export function buildJobName(deploymentId: string): string {
  return `build-${deploymentId}`
}

/**
 * BuildKit's git context, as one string.
 *
 * The `#<ref>:<subdir>` form is BuildKit's own syntax for building a subdirectory of a git
 * repository, so the subdirectory never becomes a separate clone or a `cd` in a shell wrapper. An
 * empty or `.` subdir is omitted rather than written as `#sha:.`, which BuildKit accepts but which
 * makes every context string in the logs read as though something unusual was configured.
 */
export function buildContext(spec: BuildSpec): string {
  const subdir = spec.contextSubdir
  const suffix = subdir === undefined || subdir === "" || subdir === "." ? "" : `:${subdir}`
  return `${spec.repositoryUrl}#${spec.gitSha}${suffix}`
}

export function buildJob(spec: BuildSpec, namespace: string): BuildJob {
  const output = [
    "type=image",
    `name=${imageUri(spec)}`,
    "push=true",
    ...(spec.insecureRegistry === true ? ["registry.insecure=true"] : []),
  ].join(",")

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: buildJobName(spec.deploymentId),
      namespace,
      labels: {
        "app.kubernetes.io/part-of": "sproutos",
        "sproutos.dev/deployment": spec.deploymentId,
      },
    },
    spec: {
      // No retries. A build that failed will fail the same way again, and each attempt is minutes
      // of billed compute; the deployment is retried at the job layer where there is a policy about
      // how often, not silently here.
      backoffLimit: 0,
      activeDeadlineSeconds: spec.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
      // Kept after it finishes so the handler can read the exit code and the logs. Deleted by the
      // handler once recorded, rather than by a TTL that might beat it to the evidence.
      template: {
        metadata: {
          labels: { "sproutos.dev/deployment": spec.deploymentId },
        },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "buildkit",
              image: "moby/buildkit:master-rootless",
              // Rootless BuildKit builds inside its own user namespace, which is what makes running
              // a customer's `RUN` lines survivable. It needs these two profiles unconfined to
              // create that namespace — which is why builds have their own `privileged` namespace
              // rather than this exemption being granted anywhere a tenant runs.
              securityContext: {
                seccompProfile: { type: "Unconfined" },
                appArmorProfile: { type: "Unconfined" },
                runAsUser: 1000,
                runAsGroup: 1000,
              },
              command: ["buildctl-daemonless.sh"],
              args: [
                "build",
                "--frontend=dockerfile.v0",
                // BuildKit fetches the git context itself. No clone step, no shared volume, and the
                // credential never touches a filesystem the build can read after it is done.
                `--opt=context=${buildContext(spec)}`,
                `--opt=filename=${spec.dockerfilePath ?? "Dockerfile"}`,
                `--output=${output}`,
              ],
              env: [
                { name: "BUILDKITD_FLAGS", value: "--oci-worker-no-process-sandbox" },
                /*
                  Where BuildKit looks for the config.

                  The image runs as uid 1000 with `HOME=/home/user`, and `buildctl` reads
                  `$DOCKER_CONFIG/config.json` before `$HOME/.docker/config.json`. Naming it
                  explicitly means the mount path and the lookup path cannot drift apart, and a
                  future base image that changes `HOME` does not silently un-authenticate the build.
                */
                ...(spec.registryAuthSecret === undefined
                  ? []
                  : [{ name: "DOCKER_CONFIG", value: "/home/user/.docker" }]),
              ],
              /*
                Burstable, and deliberately so.

                The request is what the scheduler reserves and the limit is what the build may
                actually use. A build is I/O-bound while it fetches the git context and pulls base
                layers, and CPU-bound only while it compiles — so reserving the compile-time figure
                keeps a build off a cluster that could have run it perfectly well.

                Observed: `0/3 nodes are available: 2 Insufficient cpu`, on a three-node cluster
                whose real CPU usage was under 10%. The build was retried five times against a
                condition that does not change in seconds and dead-lettered under a message that
                implied it had run.

                The limit is unchanged, so a build on a cluster with headroom is exactly as fast.
              */
              resources: {
                requests: { cpu: "250m", memory: "1Gi" },
                limits: { cpu: "2", memory: "4Gi" },
              },
              volumeMounts:
                spec.registryAuthSecret === undefined
                  ? []
                  : [{ name: "registry-auth", mountPath: "/home/user/.docker", readOnly: true }],
            },
          ],
          volumes:
            spec.registryAuthSecret === undefined
              ? []
              : [
                  {
                    name: "registry-auth",
                    secret: {
                      secretName: spec.registryAuthSecret,
                      // `.dockerconfigjson` is the key a `kubernetes.io/dockerconfigjson` Secret
                      // uses; `config.json` is the name the client looks for. The rename happens
                      // here rather than by storing the same bytes under a second key, so the
                      // Secret stays the standard type that `kubectl create secret docker-registry`
                      // produces and every registry's documentation describes.
                      items: [{ key: ".dockerconfigjson", path: "config.json" }],
                    },
                  },
                ],
        },
      },
    },
  }
}
