import { Type } from "typebox"

export const runtimeCatalogueResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: Type.String(),
      language: Type.String(),
      languageLabel: Type.String(),
      version: Type.String(),
      label: Type.String(),
      os: Type.String(),
      executionModel: Type.Union([Type.Literal("managed"), Type.Literal("custom")]),
      deprecatedAt: Type.String({ format: "date" }),
      blockCreateAt: Type.String({ format: "date" }),
      blockUpdateAt: Type.String({ format: "date" }),
      selectionEndsAt: Type.Union([Type.String({ format: "date" }), Type.Null()]),
      status: Type.String(),
      selectable: Type.Boolean(),
      recommended: Type.Boolean(),
      defaultPresets: Type.Array(Type.String()),
      compatiblePresets: Type.Array(Type.String()),
    }),
  ),
})
