import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugServicesByServiceIdMutation,
  getV1OrgsByOrgSlugServicesOptions,
  getV1OrgsByOrgSlugServicesQueryKey,
  postV1OrgsByOrgSlugServicesByServiceIdConnectionMutation,
  postV1OrgsByOrgSlugServicesByServiceIdRotateMutation,
  postV1OrgsByOrgSlugServicesMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

/**
 * The kinds the API accepts. Only `postgres` is implemented; the others say so when chosen.
 *
 * `object_storage` is here because the API returns it, not because the picker offers it. The list
 * was three long while `ServiceKind` on the wire was four, so a row of that kind arriving from the
 * API had a `kind` this file's type said was impossible — which the compiler only noticed once the
 * generated client was regenerated. A UI type narrower than its API is a runtime `undefined` in a
 * label lookup, not a caught error.
 */
export const SERVICE_KINDS = ["postgres", "valkey", "elasticsearch", "object_storage"] as const

export type ServiceKind = (typeof SERVICE_KINDS)[number]

export const KIND_LABELS: Record<ServiceKind, string> = {
  postgres: "Postgres",
  valkey: "Valkey",
  elasticsearch: "Elasticsearch",
  object_storage: "Object storage",
}

/*
  Which engines this deployment can actually hand out, and none of it is a product decision.

  **This duplicates something only the server knows, and it was wrong in both directions.** Every
  driver refuses with `ServiceNotConfiguredError` when its own variables are missing, and the route
  turns that into a 503 naming the variable — so the deployment is already the authority here and
  this list is a second copy of the answer, maintained by hand, in a different repository layer.
  It should become something the API reports; until it does, it is at least written down that it is
  a copy.

  Both directions, measured against production rather than assumed:

  - `elasticsearch` was `false` because OpenSearch was bound to `127.0.0.1` on the OVH host and the
    split in front of it had no address. Both are now true: the cluster is published behind an
    allowlist and a password, and `search.<domain>` reaches `search-proxy` on the router.
  - `postgres` was `true` and has never worked. It needs `SERVICE_POSTGRES_PUBLIC_HOST`, which is
    the address of the Postgres listener, and `NEON_API_KEY`, which nothing in this repository can
    obtain. Every Postgres service in the list is in `error` for that reason, which is what a `true`
    here buys: a customer allowed to ask for something that cannot be delivered.

  `object_storage` is genuinely not wired to a bucket yet.
*/
export const KIND_AVAILABLE: Record<ServiceKind, boolean> = {
  postgres: false,
  valkey: false,
  elasticsearch: true,
  object_storage: false,
}

/**
 * What the new-database dialog opens on.
 *
 * Derived rather than named, so that a deployment which cannot offer the first engine in the list
 * opens on one it can, instead of on a disabled option with the explanation in small grey text.
 * Falls back to the first kind when nothing is available at all — the dialog is then honest about
 * every option, which is the right outcome and not one worth a second code path.
 */
export const FIRST_AVAILABLE_KIND: ServiceKind =
  SERVICE_KINDS.find((kind) => KIND_AVAILABLE[kind]) ?? SERVICE_KINDS[0]

export type BackendService = {
  id: string
  name: string
  kind: ServiceKind
  status: string
  projectId: string | null
  /** Everything about the connection except the secret. */
  host: string | null
  port: number | null
  database: string | null
  username: string | null
  createdLabel: string
}

const CREATED_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

export function useBackendServices(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugServicesOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.data.map((service): BackendService => ({
      id: service.id,
      name: service.name,
      kind: service.kind,
      status: service.status,
      projectId: service.projectId,
      host: service.host,
      port: service.port,
      database: service.database,
      username: service.username,
      // The generated type says Date; without transformers.gen.ts it is an ISO string.
      createdLabel: CREATED_FORMAT.format(new Date(service.createdAt)),
    })),
  }
}

function useServiceInvalidation(orgSlug: string) {
  const client = useQueryClient()
  return () =>
    client.invalidateQueries({
      queryKey: getV1OrgsByOrgSlugServicesQueryKey({ path: { orgSlug } }),
    })
}

/**
 * Creating returns the connection URI **once**.
 *
 * It is not stored anywhere the UI can read it again — revealing costs a separate audited request —
 * so the caller has to show it to the person now or lose it.
 */
export function useCreateBackendService(orgSlug: string) {
  const invalidate = useServiceInvalidation(orgSlug)
  const mutation = useMutation(postV1OrgsByOrgSlugServicesMutation())

  return {
    ...mutation,
    createService: async (input: { name: string; kind: ServiceKind }): Promise<string> => {
      const created = await mutation.mutateAsync({ path: { orgSlug }, body: input })
      await invalidate()
      return created.connectionUri
    },
  }
}

/**
 * Revealing and rotating are mutations, never queries.
 *
 * Both write an `audit_log` row, so a cached read would make the trail claim one look when there
 * were five. Neither result enters the query cache — the URI lives in the component that asked for
 * it and goes away when that unmounts.
 */
export function useRevealConnection(orgSlug: string) {
  const mutation = useMutation(postV1OrgsByOrgSlugServicesByServiceIdConnectionMutation())
  return {
    ...mutation,
    reveal: async (serviceId: string): Promise<string> =>
      (await mutation.mutateAsync({ path: { orgSlug, serviceId } })).connectionUri,
  }
}

export function useRotateConnection(orgSlug: string) {
  const invalidate = useServiceInvalidation(orgSlug)
  const mutation = useMutation(postV1OrgsByOrgSlugServicesByServiceIdRotateMutation())
  return {
    ...mutation,
    rotate: async (serviceId: string): Promise<string> => {
      const result = await mutation.mutateAsync({ path: { orgSlug, serviceId } })
      await invalidate()
      return result.connectionUri
    },
  }
}

export function useDeleteBackendService(orgSlug: string) {
  const invalidate = useServiceInvalidation(orgSlug)
  const mutation = useMutation(deleteV1OrgsByOrgSlugServicesByServiceIdMutation())
  return {
    ...mutation,
    deleteService: async (serviceId: string) => {
      await mutation.mutateAsync({ path: { orgSlug, serviceId } })
      await invalidate()
    },
  }
}
