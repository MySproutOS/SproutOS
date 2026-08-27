/**
 * Deleting one tenant's indices from the shared OpenSearch cluster.
 *
 * Unlike the Valkey keys, this one is not optional. A revoked credential makes an index
 * unreachable, but an index that exists holds shards whether anyone can reach it or not, and shards
 * — not disk, not documents — are the resource a shared cluster runs out of. A cluster that keeps
 * every deleted customer's indices stops accepting new ones long before it runs out of anything a
 * bill would show.
 *
 * Plain `fetch` rather than an OpenSearch client library: this issues two request shapes, neither
 * with a body, and a dependency whose transport, retry and sniffing behaviour we would have to
 * configure buys nothing at that size.
 */

export type SearchAdminConfig = {
  /** The cluster itself, never the proxy. The proxy exists to stop a tenant naming another's
   * indices, and this is the one caller that legitimately names all of them. */
  url: string
  username?: string
  password?: string
}

export function searchAdminConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SearchAdminConfig {
  const url = env.SEARCH_ADMIN_URL ?? env.SEARCH_PROXY_UPSTREAM
  if (url === undefined || url === "") {
    throw new Error("SEARCH_ADMIN_URL is not set; deleted indices cannot be reaped")
  }
  return {
    url: url.replace(/\/+$/, ""),
    ...(env.SEARCH_ADMIN_USER === undefined ? {} : { username: env.SEARCH_ADMIN_USER }),
    ...(env.SEARCH_ADMIN_PASSWORD === undefined ? {} : { password: env.SEARCH_ADMIN_PASSWORD }),
  }
}

export class SearchAdminError extends Error {
  override readonly name = "SearchAdminError"

  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`OpenSearch answered ${status}: ${body.slice(0, 500)}`)
  }
}

/**
 * Delete every index under one tenant's prefix.
 *
 * Two steps rather than one `DELETE /<prefix>*`, for two reasons. A cluster with
 * `action.destructive_requires_name` set — which is the setting an operator turns on precisely so
 * that a wildcard cannot delete an index by accident — refuses the wildcard form outright. And
 * naming each index means the result says what was deleted, which is the difference between an
 * audit record and a number.
 *
 * The prefix is re-checked on every name the cluster returns. `_cat/indices/t01…_*` cannot match
 * another tenant, but this is the code path that deletes other customers' data if that ever stops
 * being true, so it does not take the cluster's word for it.
 */
export async function purgeTenantIndices(
  config: SearchAdminConfig,
  prefix: string,
): Promise<string[]> {
  if (prefix === "") throw new RangeError("Refusing to purge indices under an empty prefix")

  const listed = await request<{ index: string }[]>(
    config,
    "GET",
    // `expand_wildcards=all` so a closed index is found too. A closed index still holds its shards
    // on disk and in the cluster state, so leaving one behind leaves exactly the cost this exists
    // to reclaim.
    `/_cat/indices/${encodeURIComponent(`${prefix}*`)}?format=json&h=index&expand_wildcards=all`,
  )

  const names = listed.map((row) => row.index).filter((name) => name.startsWith(prefix))

  for (const name of names) {
    await request(config, "DELETE", `/${encodeURIComponent(name)}`)
  }

  return names
}

/** Delete both the tenant's data and the Security-plugin identity that could reach it. */
export async function purgeTenantSearch(
  config: SearchAdminConfig,
  prefix: string,
  username: string,
): Promise<string[]> {
  if (username === "") throw new RangeError("Refusing to purge an empty search username")

  const names = await purgeTenantIndices(config, prefix)
  const role = `tenant_${prefix.replace(/_$/, "")}`

  // User first: after this succeeds there is no credential that can use the role while the other
  // two idempotent deletes finish. A partial failure leaves the service unstamped for the next pass.
  await request(
    config,
    "DELETE",
    `/_plugins/_security/api/internalusers/${encodeURIComponent(username)}`,
  )
  await request(
    config,
    "DELETE",
    `/_plugins/_security/api/rolesmapping/${encodeURIComponent(role)}`,
  )
  await request(config, "DELETE", `/_plugins/_security/api/roles/${encodeURIComponent(role)}`)

  return names
}

async function request<T>(
  config: SearchAdminConfig,
  method: "GET" | "DELETE",
  path: string,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" }
  if (config.username !== undefined) {
    const auth = Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")
    headers.authorization = `Basic ${auth}`
  }

  const response = await fetch(`${config.url}${path}`, { method, headers })
  const body = await response.text()

  // 404 on a DELETE means someone else already removed it, which is the outcome we wanted.
  if (response.status === 404 && method === "DELETE") return [] as T
  if (!response.ok) throw new SearchAdminError(response.status, body)

  return (body === "" ? [] : JSON.parse(body)) as T
}
