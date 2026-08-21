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

export function environmentSecret(
  projectId: string,
  namespace: string,
  entries: EnvironmentEntry[],
): EnvironmentSecret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: environmentSecretName(projectId, entries),
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "sproutos",
        "sproutos.dev/project": projectId,
      },
    },
    type: "Opaque",
    // `stringData`, not `data`: the API server base64-encodes it, and doing that here would be a
    // second place to get an encoding wrong for no benefit.
    stringData: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
  }
}
