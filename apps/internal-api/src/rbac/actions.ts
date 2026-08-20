/**
 * The one RBAC action catalogue (ADR 0016).
 *
 * Every `requirePermission()` argument in the product comes from here, and every OAuth scope is
 * one of these strings. Adding an action means adding it to this array — nowhere else invents
 * vocabulary, because the wildcard expander below is a single function and two namespaces with
 * different separator conventions would make `service:*` mean different things in different
 * routes.
 *
 * Grammar: `<service>:<verb>` or `<service>:<subject>:<verb>`. `:` is the only separator; there
 * are no dots anywhere in an action string.
 */
export const ACTIONS = [
  "org:read",
  "org:update",
  "org:delete",
  "org:transfer_ownership",

  "member:read",
  "member:invite",
  "member:update",
  "member:remove",

  "role:read",
  "role:create",
  "role:update",
  "role:delete",

  "audit:read",

  "billing:read",
  "billing:write",
  "billing:refund",
  "usage:read",

  "apikey:read",
  "apikey:create",
  "apikey:revoke",
  "credential:read",
  "credential:write",

  "github:read",
  "github:write",

  "project:read",
  "project:create",
  "project:update",
  "project:delete",
  "repository:read",
  "repository:write",

  "deployment:read",
  "deployment:write",
  "deployment:promote",
  "sandbox:read",
  "sandbox:write",

  "workflow:read",
  "workflow:run",
  "workflow:job:read",
  "workflow:job:modify",

  "database:read",
  "database:create",
  "database:delete",
  "database:connect",
  "database:admin",
  "database:branch:create",
  "database:branch:delete",

  "search:read",
  "search:write",
  "cache:read",
  "cache:write",
  "observability:logs:read",
  // Rotating the ingest key is not a read: it invalidates the old one, so every exporter a project
  // has deployed stops sending until it is redeployed with the new one.
  "observability:stream:manage",

  "store:fork",
  "store:listing:publish",
  "store:listing:moderate",

  "oauth_client:read",
  "oauth_client:create",
  "oauth_client:update",
  "oauth_client:delete",

  "infra:read",
  "infra:write",
] as const

export type Action = (typeof ACTIONS)[number]

const ACTION_SET: ReadonlySet<string> = new Set<string>(ACTIONS)

/** Whether a string is an action in the catalogue. Custom roles are validated against this. */
export function isAction(value: string): value is Action {
  return ACTION_SET.has(value)
}

/**
 * The wildcard forms a role could have used to grant `action`, plus the action itself.
 *
 * `workflow:job:read` yields `*`, `workflow:*`, `workflow:job:*`, `workflow:job:read`. A stored
 * grant matches the request when the two arrays overlap, which is one GIN-indexed `&&` rather
 * than a per-row LIKE. Expansion happens on `:` boundaries only, so the set is bounded by the
 * number of segments in the action.
 */
export function expandAction(action: string): string[] {
  const segments = action.split(":")
  const expanded: string[] = ["*"]

  for (let index = 1; index < segments.length; index += 1) {
    expanded.push(`${segments.slice(0, index).join(":")}:*`)
  }
  expanded.push(action)

  return [...new Set(expanded)]
}

/** [[expandAction]] over several actions at once, deduplicated. */
export function expandActions(actions: readonly string[]): string[] {
  return [...new Set(actions.flatMap((action) => expandAction(action)))]
}

/**
 * Whether a string may appear in a role statement a customer authored.
 *
 * Wider than [[isAction]] because a statement is allowed to say `project:*`, and narrower than
 * "any string" because a typo like `project:writ` would be stored, never match anything, and look
 * like a working grant in the roles UI. A `<prefix>:*` form is accepted only when the catalogue
 * actually has an action under that prefix.
 */
export function isGrantableAction(value: string): boolean {
  if (value === "*") return true
  if (isAction(value)) return true
  if (!value.endsWith(":*")) return false

  const prefix = value.slice(0, -1)
  return ACTIONS.some((action) => action.startsWith(prefix))
}

/**
 * Whether a stored grant's `actions` array covers `action`.
 *
 * The application-side twin of the `actions && $expanded` predicate, used when grants have
 * already been fetched — a batch check, or an OAuth token whose scopes must be intersected with
 * the user's live permissions.
 */
export function actionsCover(granted: readonly string[], action: string): boolean {
  const expanded = new Set(expandAction(action))
  return granted.some((entry) => expanded.has(entry))
}
