import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const userSchemaPreferencesResponse = Type.Object({
  lastOrganizationId: Nullable(UUID7String),
  lastOrganizationSlug: Nullable(Type.String()),
  sidebarCollapsed: Type.Boolean(),
  navPinnedProjectIds: Type.Array(UUID7String),
})
