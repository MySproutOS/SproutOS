import { createHash } from "node:crypto"

/**
 * A revision's environment, as a Kubernetes Secret.
 *
 * **This is the half of environment variables that did not exist.** `project_env_var` stored them,
 * the API sealed, listed, revealed and counted them, `listSealedForProject` carried the comment
 * "for the deploy path that has to materialize an environment" — and nothing called it. The Knative
 * renderer emitted no `env` block at all, so every variable a customer set was written to a database
 * and delivered nowhere. The backlog item was marked done because the table existed.
 *
 * ## Why a Secret rather than inline `env`
 *
 * A Knative Service's pod spec is readable by anything with `get` on the Service, and a revision is
 * kept forever as the record of what ran. Inline values would put every customer's API keys in an
 * object that is listed, watched, and printed by `kubectl get ksvc -o yaml`. A `secretRef` puts them
 * in the one object kind the cluster is configured to encrypt at rest and to treat as sensitive in
 * logs.
 *
 * ## Why the name carries a hash
 *
 * Knative cuts a new revision when the *pod spec* changes. A Secret referenced by a fixed name is
 * the same pod spec whatever is inside it — so changing a variable would update the Secret,
 * Knative would see no change, and the running revision would keep the old environment until
 * something unrelated forced a redeploy. The customer would have set a value, seen it saved, and
 * watched their site not use it.
 *
 * Hashing the content into the name makes an environment change a pod-spec change. It also makes the
 * old Secret still exist, which is what a rollback to an earlier revision needs: revisions are
 * historical facts here, and one that rolled back into an environment it never ran with would not be
 * the thing being rolled back to.
 */
export type EnvironmentEntry = { key: string; value: string }

export type EnvironmentSecret = {
  apiVersion: "v1"
  kind: "Secret"
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  type: "Opaque"
  stringData: Record<string, string>
}

/**
 * The Secret's name: `env-<project discriminator>-<content hash>`.
 *
 * Truncated to twelve hex characters. That is 48 bits, and the only thing a collision has to be
 * unlikely against is *another environment of the same project* — not a global namespace — so this
 * is far more margin than it needs, and short enough to read in `kubectl get secrets`.
 */
export function environmentSecretName(projectId: string, entries: EnvironmentEntry[]): string {
  const discriminator = projectId.replaceAll("-", "").slice(-6)
  return `env-${discriminator}-${environmentDigest(entries)}`
}

/**
 * A digest over the sorted key/value pairs.
 *
 * Sorted, so two identical environments that came back from the database in a different order
 * produce the same name and therefore no spurious revision. Length-prefixed rather than delimited,
 * because `A=1,B=2` and `A=1,B` + `=2` are the same string under any separator a value could
 * contain — and a customer whose value contains the separator would silently share a name with a
 * different environment.
 */
export function environmentDigest(entries: EnvironmentEntry[]): string {
  const hash = createHash("sha256")
  for (const entry of [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    hash.update(`${entry.key.length}:${entry.key}${entry.value.length}:${entry.value}`)
  }
  return hash.digest("hex").slice(0, 12)
}

/**
 * Keys Kubernetes will accept in a Secret, which is not every key a customer can type.
 *
 * A Secret key must match `[-._a-zA-Z0-9]+`. The API server rejects the whole object otherwise, so
 * one variable named with a space would make every other variable undeliverable — and the failure
 * arrives as a 422 on the Secret, several steps from the variable that caused it.
 *
 * Dropped rather than sanitised: a variable renamed on the way through is a variable the customer's
 * code does not read, which looks exactly like the platform ignoring it. The deploy job reports what
 * it dropped.
 */
export function isDeliverableKey(key: string): boolean {
  return /^[-._a-zA-Z0-9]+$/.test(key)
}

/**
 * Variables only. A thin call through {@link configSecret}, so there is one implementation of the
 * naming and one of the encoding — two would be two places for a hash to drift.
 */
export function environmentSecret(
  projectId: string,
  namespace: string,
  entries: EnvironmentEntry[],
): EnvironmentSecret {
  return configSecret(projectId, namespace, entries, [])
}

/**
 * A config file the container needs at an absolute path.
 *
 * The second half of "configuration", and the half that did not exist. `glance` — forked, built and
 * pushed by this platform — exited with
 * `parsing config: reading /app/config/glance.yml: no such file or directory`. Everything the
 * platform claims had worked; the application wanted a *file*. Most self-hostable software is
 * configured that way and reads nothing from the environment, and a platform whose premise is "fork
 * this and deploy it without knowing how to code" cannot answer that with "add a Dockerfile stage".
 */
export type ConfigFile = { path: string; contents: string }

/**
 * The Secret key one file's contents are stored under.
 *
 * **Not the path.** A Secret key must match `[-._a-zA-Z0-9]+`, so `/app/config/glance.yml` is not a
 * legal key and any flattening that maps `/` to a legal character collides: `a/b` and `a.b` become
 * the same key, and the second file silently overwrites the first. A digest of the full path cannot
 * collide by construction, and the mount carries the real path anyway.
 */
export function configFileKey(path: string): string {
  return `f-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`
}

/**
 * Whether a path can be mounted into a container.
 *
 * Absolute, no traversal, and a filename after the last separator. `..` is refused not because a
 * customer should not overwrite files in their own container — that is their business — but because
 * a `subPath` containing it is rejected by the kubelet at mount time, which fails the pod with a
 * message about the volume rather than about the file.
 *
 * The same rule is a check constraint on the column, so a row written by a migration or by hand
 * cannot get past it either.
 */
export function isMountablePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.includes("..") &&
    path.length > 1 &&
    path.length <= 4096
  )
}

export type FileVolume = { name: string; secret: { secretName: string } }
export type FileMount = { name: string; mountPath: string; subPath: string; readOnly: boolean }

/**
 * The volume and mounts that put a project's files where the container expects them.
 *
 * ## `subPath`, one per file
 *
 * Mounting a Secret at a directory *replaces* that directory: everything the image shipped in
 * `/app/config` disappears, which for most projects means the defaults their config was meant to
 * sit beside. A `subPath` mount projects a single file into an existing directory and leaves its
 * neighbours alone.
 *
 * The cost is that a `subPath` mount does not receive updates when the Secret changes. That costs
 * nothing here: the Secret is named after its contents, so it never changes — a different
 * configuration is a different Secret and therefore a different revision.
 *
 * ## `readOnly`
 *
 * The container may not write its own config back. That is not a restriction the platform imposes
 * for its own sake: a writable mount would let an application persist changes that vanish on the
 * next revision, which is worse than not being able to write at all because it looks like it worked.
 */
export function fileVolume(secretName: string): FileVolume {
  return { name: "sproutos-config", secret: { secretName } }
}

export function fileMounts(files: ConfigFile[]): FileMount[] {
  return files.map((file) => ({
    name: "sproutos-config",
    mountPath: file.path,
    subPath: configFileKey(file.path),
    readOnly: true,
  }))
}

/**
 * One Secret holding both a revision's environment and its files.
 *
 * Together rather than two objects, because they are one thing — the configuration this revision
 * ran with — and splitting them would mean two names, two hashes, and the possibility of a revision
 * pinned to one half of a configuration.
 */
export function configSecret(
  projectId: string,
  namespace: string,
  entries: EnvironmentEntry[],
  files: ConfigFile[] = [],
): EnvironmentSecret {
  // The key is a digest of the path, so the path is inside the name's digest too — two files with
  // identical contents at different paths are different configurations, and produce different
  // Secrets and therefore different revisions.
  const fileEntries: EnvironmentEntry[] = files.map((file) => ({
    key: configFileKey(file.path),
    value: file.contents,
  }))

  const all = [...entries, ...fileEntries]
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: environmentSecretName(projectId, all),
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "sproutos",
        "sproutos.dev/project": projectId,
      },
    },
    type: "Opaque",
    // `stringData`, not `data`: the API server base64-encodes it, and doing that here would be a
    // second place to get an encoding wrong for no benefit.
    stringData: Object.fromEntries(all.map((entry) => [entry.key, entry.value])),
  }
}
