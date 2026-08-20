import { open, seal, type SealedValue } from "@lib/envelope"

/**
 * The encryption context every `project_env_var` value is bound to.
 *
 * `projectId` and the key name are both authenticated — by KMS on the unwrap and as GCM
 * additional data on the decrypt — so a ciphertext lifted out of one row and written into another
 * fails to open rather than quietly yielding the wrong secret. Without the key name, moving
 * `DATABASE_URL`'s ciphertext onto the `STRIPE_KEY` row inside the same project would work.
 *
 * The target is deliberately not in the context: promoting a preview variable to production is a
 * row edit, and binding it would make that a re-encrypt for no security gain.
 */
export function envVarContext(projectId: string, key: string): Record<string, string> {
  return { field: "project_env_var.value", key, projectId }
}

export async function sealEnvVarValue(
  projectId: string,
  key: string,
  value: string,
): Promise<SealedValue> {
  return await seal(value, envVarContext(projectId, key))
}

export async function openEnvVarValue(
  projectId: string,
  key: string,
  sealed: SealedValue,
): Promise<string> {
  return await open(sealed, envVarContext(projectId, key))
}
