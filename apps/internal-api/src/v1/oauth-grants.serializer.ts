import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

/**
 * A database an application created while acting for this user.
 *
 * Listed on the grant so that revoking consent can ask what should happen to each one, rather than
 * silently picking. Both answers destroy something a person may care about: deleting takes data the
 * user may want, and keeping leaves them owning — and paying for — a database they did not
 * knowingly create. Only they can say which.
 */
export const oauthGrantsSchemaService = Type.Object({
  id: UUID7String,
  name: Type.String(),
  kind: Type.String(),
  status: Type.String(),
  createdAt: Type.String(),
})

export const oauthGrantsSchemaGrant = Type.Object({
  id: UUID7String,
  clientId: UUID7String,
  clientName: Type.String(),
  clientHomepage: Nullable(Type.String()),
  /** `true` where the platform published the client itself, which the UI marks differently. */
  firstParty: Type.Boolean(),
  scopes: Type.Array(Type.String()),
  createdAt: Type.String(),
  /** The databases this application provisioned. Empty for an application that only reads. */
  services: Type.Array(oauthGrantsSchemaService),
})

export const oauthGrantsSchemaListResponse = Type.Object({
  data: Type.Array(oauthGrantsSchemaGrant),
})

/**
 * What to do with each database the application created.
 *
 * Every one of them has to be named. An omitted service is refused rather than defaulted, because
 * both defaults are wrong in a way the user cannot undo — and a request that silently deleted a
 * database because a client forgot a field is the worst possible reading of "revoke access".
 */
export const oauthGrantsSchemaRevokeRequest = Type.Object({
  services: Type.Array(
    Type.Object({
      id: UUID7String,
      action: Type.Union([Type.Literal("keep"), Type.Literal("delete")]),
    }),
  ),
})

export const oauthGrantsSchemaRevokeResponse = Type.Object({
  /**
   * Kept databases. A newly issued user URI is shown exactly once.
   *
   * An existing user credential is never rotated merely because an OAuth grant is revoked. The URI
   * is present only when the application created the service before the user had a credential.
   */
  kept: Type.Array(
    Type.Object({
      id: UUID7String,
      name: Type.String(),
      kind: Type.String(),
      connectionUri: Type.Optional(
        Type.String({ description: "Present only when a user credential had to be issued." }),
      ),
      keyPrefix: Type.Optional(Type.String()),
    }),
  ),
  deleted: Type.Array(Type.Object({ id: UUID7String, name: Type.String(), kind: Type.String() })),
})
