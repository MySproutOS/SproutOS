import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const sandboxSchemaSandbox = Type.Object({
  id: UUID7String,
  state: Type.String(),
  /** Who is running it. `daytona` today; the driver interface exists so that can change. */
  provider: Type.String(),
  /**
   * Null until the provider has actually created it.
   *
   * Not an error state — a row exists before the container does, so a create that dies mid-flight
   * is still attributable and still reapable rather than an orphan nobody bills.
   */
  externalId: Nullable(Type.String()),
  /** `container` or `android`. What kind of machine, not what isolates it. */
  sandboxClass: Type.String(),
  cpu: Type.Integer(),
  memoryGib: Type.Integer(),
  diskGib: Type.Integer(),
  /**
   * The port a preview link points at, once something is listening.
   *
   * There is deliberately no `runtimeClass` here any more. The column recorded a Kubernetes
   * RuntimeClass and, per ADR 0012's amendment, spent its life claiming `kata-clh` while the pod
   * had none. Under a rented provider the isolation is theirs and we cannot observe it, so the
   * honest thing is to say nothing rather than to say `none` in a field whose name promises more.
   */
  previewPort: Nullable(Type.Integer()),
  idleTimeoutSeconds: Type.Integer(),
  alwaysOn: Type.Boolean(),
  lastActivityAt: Type.String({ format: "date-time" }),
  createdAt: Type.String({ format: "date-time" }),
})

/** A signed, short-lived URL into a port on the sandbox. */
export const sandboxSchemaPreviewResponse = Type.Object({
  url: Type.String(),
  port: Type.Integer(),
  expiresAt: Type.String({ format: "date-time" }),
})

export const sandboxSchemaPreviewQuery = Type.Object({
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
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
   *
   * **This schema alone does not enforce that.** The validator runs `Value.Convert` before
   * `Check`, and Convert wraps a scalar into a one-element array: `"ls -la"` arrives here as
   * `["ls -la"]` and passes, then `execve` looks for a binary whose name contains a space, fails,
   * and reports an exit code with nothing on stderr — because the "not found" goes to the exec
   * protocol's status channel rather than the process's. `42` arrives as `["42"]`. Only `[]` is
   * refused, by `minItems`, which is what made the validation look like it was working.
   *
   * `requireArgv` on the route rejects the scalar before it becomes an argv. The guard is there and
   * not here because the coercion happens inside the validator, so by the time a handler sees the
   * value the evidence is gone.
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
