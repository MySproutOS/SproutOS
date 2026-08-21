import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const sandboxSchemaSandbox = Type.Object({
  id: UUID7String,
  state: Type.String(),
  /** Present once the pod exists. Absent while it is being created. */
  podName: Nullable(Type.String()),
  namespace: Nullable(Type.String()),
  /** The VM boundary, when the cluster has one. Null says plainly that it does not. */
  runtimeClass: Nullable(Type.String()),
  idleTimeoutSeconds: Type.Integer(),
  alwaysOn: Type.Boolean(),
  lastActivityAt: Type.String({ format: "date-time" }),
  createdAt: Type.String({ format: "date-time" }),
})

export const sandboxSchemaProjectParam = Type.Object({
  orgSlug: Type.String(),
  projectId: UUID7String,
})

export const sandboxSchemaFileQuery = Type.Object({
  /** Relative to the workspace. Absolute paths and `..` are refused, not rebased. */
  path: Type.String({ minLength: 1, maxLength: 1024 }),
})

/** Listing takes an optional path; absent means the workspace root. */
export const sandboxSchemaTreeQuery = Type.Object({
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
})

export const sandboxSchemaFileResponse = Type.Object({
  path: Type.String(),
  contents: Type.String(),
})

export const sandboxSchemaWriteRequest = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  contents: Type.String({ maxLength: 1_000_000 }),
})

export const sandboxSchemaListResponse = Type.Object({
  path: Type.String(),
  /** One entry per line from `ls -1Ap`; a trailing slash marks a directory. */
  entries: Type.Array(Type.String()),
})

export const sandboxSchemaExecRequest = Type.Object({
  /**
   * Argument vector, not a command line.
   *
   * There is no shell between this and `execve`, so nothing in an argument can become a second
   * command. A string would have to be split by something, and every splitter is a quoting bug.
   */
  command: Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 64 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
})

export const sandboxSchemaExecResponse = Type.Object({
  stdout: Type.String(),
  stderr: Type.String(),
  /** From the exec channel's status stream. Null when the stream closed without one. */
  exitCode: Nullable(Type.Integer()),
})
