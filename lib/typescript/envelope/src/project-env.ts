import { open, seal } from "./envelope"
import type { SealedValue } from "./types"

/*
  Here rather than in `apps/internal-api`, where it started, because there are now two callers.

  The API seals a value when a customer sets it; the deploy job opens the whole set to materialize a
  revision's environment. Those live in different deployments, and a second copy of the context
  would be a second copy of a rule whose whole purpose is that both sides compute it identically —
  a divergence would present as "this value could not be decrypted" on a variable nobody had
  touched.
*/

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

/**
 * The encryption context every `project_file` value is bound to.
 *
 * The same shape as a variable's and deliberately a *different* `field`, so a ciphertext lifted from
 * `project_env_var` and written into `project_file` fails to open rather than quietly yielding a
 * value under a name nobody set. Both are authenticated — by KMS on the unwrap and as GCM additional
 * data on the decrypt — so this is a real boundary, not a label.
 */
export function projectFileContext(projectId: string, path: string): Record<string, string> {
  return { field: "project_file.contents", path, projectId }
}

export async function sealProjectFileContents(
  projectId: string,
  path: string,
  contents: string,
): Promise<SealedValue> {
  return await seal(contents, projectFileContext(projectId, path))
}

export async function openProjectFileContents(
  projectId: string,
  path: string,
  sealed: SealedValue,
): Promise<string> {
  return await open(sealed, projectFileContext(projectId, path))
}
