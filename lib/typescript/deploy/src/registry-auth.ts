import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr"

/**
 * The credential a build pushes with.
 *
 * `deploy/builds/namespace.yaml` opens by explaining that a build "needs a credential that can
 * *push* to the registry" and why it cannot live in a tenant namespace. It was right about both and
 * **the credential did not exist**: no Secret, no mount, no volumes on the Job. Every build this
 * platform ever ran compiled the application, exported an image, and died asking Artifact Registry
 * for an anonymous token.
 *
 * Minted rather than stored, on both clouds, because on both clouds it expires:
 *
 * - ECR's `GetAuthorizationToken` is valid for 12 hours.
 * - Google's OAuth access tokens are valid for about an hour.
 *
 * A long-lived alternative exists on GCP — a service-account JSON key used as `_json_key` — and it
 * is the wrong one twice over: `constraints/iam.disableServiceAccountKeyCreation` forbids it
 * outright on this project, and a key with push rights to every customer's images is precisely the
 * thing you would least like to leave lying in a Secret. So the platform refreshes.
 *
 * Nothing here touches a tenant. The credential is written into the build namespace, which no
 * tenant workload can read, and the build pod that mounts it is the only reader.
 */

/** What a `kubernetes.io/dockerconfigjson` Secret holds, before base64. */
export type DockerConfig = {
  auths: Record<string, { username: string; password: string; auth: string }>
}

export function dockerConfig(registry: string, username: string, password: string): DockerConfig {
  return {
    auths: {
      [registry]: {
        username,
        password,
        // `auth` as well as the pair, because clients disagree about which they read and a config
        // carrying only one of them authenticates against some registries and not others.
        auth: Buffer.from(`${username}:${password}`, "utf8").toString("base64"),
      },
    },
  }
}

/**
 * Which cloud's registry a host names.
 *
 * From the hostname, not from configuration. A deployment that sets `BUILD_REGISTRY` to an ECR host
 * and a cloud flag to `gcp` has one mistake; making the flag the source of truth turns it into an
 * hour of debugging a 403 that says nothing about either.
 */
export type RegistryKind = "ecr" | "artifact-registry" | "unknown"

export function registryKind(registry: string): RegistryKind {
  if (/\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/.test(registry)) return "ecr"
  if (/(^|\.)(pkg\.dev|gcr\.io)$/.test(registry)) return "artifact-registry"
  return "unknown"
}

export class UnsupportedRegistryError extends Error {
  override readonly name = "UnsupportedRegistryError"

  constructor(registry: string) {
    super(
      `No way to mint a push credential for "${registry}". Recognised: *.dkr.ecr.<region>.amazonaws.com, *.pkg.dev, *.gcr.io.`,
    )
  }
}

/** Google's metadata server, which is how a pod on GKE gets a token without holding a key. */
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

export type MintOptions = {
  /** Injected in tests. Production passes nothing and uses the ambient credential. */
  fetchImpl?: typeof fetch
  ecr?: Pick<ECRClient, "send">
}

/**
 * A username and password for `registry`, valid until it is not.
 *
 * The `expiresAt` is returned rather than assumed by the caller: the two clouds differ by an order
 * of magnitude (one hour against twelve), and a refresh interval hard-coded for one of them either
 * hammers the other's API or lets the credential lapse in the middle of a build.
 */
export type RegistryCredential = {
  username: string
  password: string
  expiresAt: Date
}

export async function mintRegistryCredential(
  registry: string,
  options: MintOptions = {},
): Promise<RegistryCredential> {
  const kind = registryKind(registry)

  if (kind === "artifact-registry") {
    const doFetch = options.fetchImpl ?? fetch
    const response = await doFetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
    })

    if (!response.ok) {
      throw new Error(
        `The metadata server refused a token (${response.status}). On GKE this needs Workload Identity on the node pool, or a node scope of cloud-platform.`,
      )
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number }
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new Error("The metadata server returned no access_token")
    }

    return {
      // The literal username Google's registries expect alongside an OAuth token. Not a placeholder.
      username: "oauth2accesstoken",
      password: body.access_token,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
    }
  }

  if (kind === "ecr") {
    const client = options.ecr ?? new ECRClient({})
    const response = await client.send(new GetAuthorizationTokenCommand({}))
    const entry = response.authorizationData?.[0]

    if (entry?.authorizationToken === undefined) {
      throw new Error("ECR returned no authorization data")
    }

    // ECR hands back `AWS:<password>` base64-encoded, in one field.
    const decoded = Buffer.from(entry.authorizationToken, "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    if (separator === -1) throw new Error("ECR's authorization token was not user:password")

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
      expiresAt: entry.expiresAt ?? new Date(Date.now() + 12 * 60 * 60 * 1000),
    }
  }

  throw new UnsupportedRegistryError(registry)
}
