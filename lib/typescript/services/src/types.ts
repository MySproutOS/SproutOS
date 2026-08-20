/**
 * One interface for everything a customer can provision.
 *
 * TASK 37 asks for connection URIs to individual backend services, and the same abstraction covers
 * a service attached to a project and one standing on its own — `backend_service.project_id` is
 * nullable for exactly that reason. Postgres, Valkey, and Elasticsearch differ in almost every
 * detail and in none of the five things a control plane needs to do to them.
 */
export type ServiceKind = "postgres" | "valkey" | "elasticsearch"

export type ServiceStatus = "provisioning" | "active" | "suspended" | "deleting" | "error"

export type ProvisionInput = {
  backendServiceId: string
  organizationId: string
  projectId: string | null
  /** The customer's name for it, already validated. Drivers derive real identifiers from the id. */
  name: string
}

/**
 * What a driver hands back, exactly once.
 *
 * The password is in here and nowhere else the caller can reach without asking again, because the
 * URI is the one moment a plaintext credential legitimately exists outside KMS.
 */
export type ProvisionResult = {
  connectionUri: string
  host: string
  port: number
  database: string
  username: string
}

/** Everything but the secret. What a list or a detail page is allowed to show. */
export type ConnectionDetails = Omit<ProvisionResult, "connectionUri">

export type ServiceDriver = {
  kind: ServiceKind
  provision: (input: ProvisionInput) => Promise<ProvisionResult>
  /** Re-read the URI. Audited by the caller — this is a credential leaving the system. */
  connectionUri: (backendServiceId: string) => Promise<string>
  details: (backendServiceId: string) => Promise<ConnectionDetails>
  /** A new password, invalidating the old URI. The only recovery from a leaked one. */
  rotateCredentials: (backendServiceId: string) => Promise<string>
  suspend: (backendServiceId: string) => Promise<void>
  destroy: (backendServiceId: string) => Promise<void>
}

export class ServiceKindUnavailableError extends Error {
  override readonly name = "ServiceKindUnavailableError"

  constructor(readonly kind: string) {
    super(`${kind} services are not available yet`)
  }
}

export class ServiceNotProvisionedError extends Error {
  override readonly name = "ServiceNotProvisionedError"

  constructor(readonly backendServiceId: string) {
    super(`Backend service ${backendServiceId} has no provisioned instance`)
  }
}
