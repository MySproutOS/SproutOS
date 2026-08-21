import {
  createKubeClient,
  dockerConfig,
  type KubeConfig,
  inClusterConfig,
  mintRegistryCredential,
  registryKind,
  secretPath,
} from "@lib/deploy"
import { type BuildSettings, BUILD_NAMESPACE, buildSettingsFromEnv } from "./build"
import type { JobHandler } from "./worker"

/**
 * Keep the build namespace's push credential fresh.
 *
 * The credential a build pushes with expires on every cloud this platform targets — about an hour
 * on Google, twelve on AWS — so it is minted and rewritten rather than configured once. See
 * `@lib/deploy`'s `registry-auth` for why a long-lived key is the wrong answer even where one is
 * allowed.
 *
 * Scheduled every ten minutes. That is far more often than either expiry demands, and it is chosen
 * for the failure it prevents rather than for the expiry it tracks: a build that starts thirty
 * seconds before the credential lapses fails at the push, after paying for the whole build, with a
 * 403 that looks exactly like a permissions problem. Rewriting a Secret is one API call.
 *
 * Does nothing at all when the registry needs no credential — a local registry in a test, or a
 * deployment with `BUILD_REGISTRY` unset. Refusing to start would make the whole job runner
 * dependent on a registry it may not have.
 */
export const REGISTRY_CREDENTIAL_KIND = "platform.registry_credential"

/** The Secret `BuildSpec.registryAuthSecret` names, and what the build mounts. */
export const REGISTRY_AUTH_SECRET = "build-registry-auth"

export function registryAuthSecret(
  namespace: string,
  name: string,
  registry: string,
  username: string,
  password: string,
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace,
      labels: { "app.kubernetes.io/part-of": "sproutos" },
      annotations: {
        // Which registry these bytes are for, so a deployment moved between clouds does not leave
        // a credential that authenticates correctly against a host nobody pushes to any more.
        "sproutos.dev/registry": registry,
      },
    },
    type: "kubernetes.io/dockerconfigjson",
    stringData: {
      ".dockerconfigjson": JSON.stringify(dockerConfig(registry, username, password)),
    },
  }
}

export function refreshRegistryCredential(
  config?: KubeConfig,
  settings?: BuildSettings,
): JobHandler {
  return async (_job, _context) => {
    let resolved: BuildSettings
    try {
      resolved = settings ?? buildSettingsFromEnv()
    } catch {
      // No registry configured. Nothing to keep fresh, and this is not a failure — a development
      // job runner has no registry and should not retry five times saying so.
      return
    }

    if (resolved.registryAuthSecret === undefined) return

    if (registryKind(resolved.registry) === "unknown") {
      // Loud, because this is the configuration where a build will fail later for a reason that
      // reads as unrelated. A registry we cannot mint for is one someone has to write a Secret for
      // by hand, and they should be told now rather than by a 403 in a build log.
      throw new Error(
        `BUILD_REGISTRY_AUTH_SECRET is set but "${resolved.registry}" is not a registry this can mint a credential for`,
      )
    }

    const credential = await mintRegistryCredential(resolved.registry)
    const kube = createKubeClient(config ?? inClusterConfig())

    await kube.apply(
      secretPath(BUILD_NAMESPACE, resolved.registryAuthSecret),
      registryAuthSecret(
        BUILD_NAMESPACE,
        resolved.registryAuthSecret,
        resolved.registry,
        credential.username,
        credential.password,
      ),
    )

    console.info(
      `[jobs] refreshed the ${resolved.registry} push credential; valid until ${credential.expiresAt.toISOString()}`,
    )
  }
}
