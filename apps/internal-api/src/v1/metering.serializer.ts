import { Type } from "typebox"

export const meteringSchemaResponse = Type.Object({
  /** How many events were stored, after dropping any outside the accepted clock skew. */
  accepted: Type.Integer(),
  /** How many arrived. A gap between the two is a clock that is wrong or a tenant that is gone. */
  received: Type.Integer(),
  /**
   * Organizations named by the batch that this control plane has never heard of, or has deleted.
   *
   * Reported rather than silently dropped: a node steadily submitting usage for an organization
   * that does not exist is a stale pod label, and nothing else would say so.
   */
  unknownOrganizations: Type.Integer(),
  /**
   * Projects named by the batch that do not exist. Those events are still stored and still billed —
   * the organization used the resource — with `project_id` left null.
   */
  unknownProjects: Type.Integer(),
})
