import type { Runtime } from "@aws-sdk/client-lambda"
import { WEB_ADAPTER_HANDLER } from "./web-adapter"

/**
 * Which Lambda runtimes a customer may ask for, and what runs their code by default.
 *
 * `publishFunction` used to hardcode `nodejs22.x` and `index.handler`. That is a fine default and a
 * terrible constraint: it pinned every project on the platform to one Node version, so an AWS
 * runtime deprecation became a platform-wide emergency to be resolved by grep, and a Hono API and a
 * Next.js server had to share an entry point neither of them picked.
 *
 * **The allowlist is here rather than in the API route** so there is one answer to "what can we
 * publish", next to the code that publishes it. `Runtime` is AWS's own union and the values are
 * exact: `nodejs22` is not `nodejs22.x`, and Lambda rejects the wrong one at deploy time with a
 * message that does not say which field was wrong. Checking at the API boundary turns that into a
 * 400 that names the field.
 *
 * Deliberately a subset of what Lambda offers. A runtime we have never published is a runtime whose
 * handler convention and bundle layout nobody here has tested, and offering it would be a promise
 * made by an autocomplete list.
 */
export const SUPPORTED_RUNTIMES = [
  "nodejs22.x",
  "nodejs20.x",
  "python3.13",
  "python3.12",
  "provided.al2023",
] as const satisfies readonly Runtime[]

export type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number]

export function isSupportedRuntime(value: string): value is SupportedRuntime {
  return (SUPPORTED_RUNTIMES as readonly string[]).includes(value)
}

/** What the platform publishes when a release does not say. */
export const DEFAULT_RUNTIME: SupportedRuntime = "nodejs22.x"
export const DEFAULT_HANDLER = "index.handler"

/**
 * What each of the deploy action's presets runs.
 *
 * The preset is the one thing the action already knows about the shape of a build, so it is the
 * right place to take a default from — a customer who picked `hono` has said enough. An unknown
 * preset falls back rather than failing: presets are added in the action's repository, which ships
 * separately, and a new one must not be a deploy that cannot start.
 */
const PRESET_DEFAULTS: Record<string, PresetRuntime> = {
  /*
    `next` and `hono` are web servers, not handlers.

    This is the correction to the thing that made every deployment in production fail: the presets
    collect `.next/standalone` and `dist`, both of which contain a program that *listens on a port*,
    and they were published claiming to export `index.handler`. Nothing exports it, so the function
    could only ever answer `Runtime.HandlerNotFound`. See `web-adapter.ts` for why the answer is an
    adapter rather than making every customer write a Lambda entry point.
  */
  next: { runtime: "nodejs22.x", handler: WEB_ADAPTER_HANDLER, webAdapter: true },
  hono: { runtime: "nodejs22.x", handler: WEB_ADAPTER_HANDLER, webAdapter: true },
  /*
    Native executables are web servers too. On Lambda's provided runtime the executable at
    `bootstrap` starts directly, while the adapter layer runs as an extension and owns the Runtime
    API. AWS's own Rust zip examples use this provided.al2023 + bootstrap + layer shape.
  */
  web: { runtime: "provided.al2023", handler: "bootstrap", webAdapter: true },
  /*
    `static` is the exception and stays a handler.

    A static build has no server to adapt; the function's whole job is to serve files out of the
    archive, which is a handler this platform provides rather than one the customer wrote.
  */
  static: { runtime: "nodejs22.x", handler: DEFAULT_HANDLER, webAdapter: false },
}

export type PresetRuntime = {
  runtime: SupportedRuntime
  handler: string
  /** Whether the build is an HTTP server needing the Lambda Web Adapter. */
  webAdapter: boolean
}

export function runtimeForPreset(preset: string): PresetRuntime {
  return (
    PRESET_DEFAULTS[preset] ?? {
      runtime: DEFAULT_RUNTIME,
      handler: DEFAULT_HANDLER,
      webAdapter: false,
    }
  )
}

/** Whether a release still follows its preset's web-server entry-point convention. */
export function webAdapterForRelease(preset: string, handler: string | undefined): boolean {
  const defaults = runtimeForPreset(preset)
  return defaults.webAdapter && (handler === undefined || handler === defaults.handler)
}
