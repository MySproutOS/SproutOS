import type { Runtime } from "@aws-sdk/client-lambda"
import { WEB_ADAPTER_HANDLER } from "./web-adapter"

export const DEPLOYMENT_PRESETS = ["next", "hono", "web", "function", "static", "android"] as const
export type DeploymentPreset = (typeof DEPLOYMENT_PRESETS)[number]
export type RuntimeLanguage = "node" | "python" | "java" | "dotnet" | "ruby" | "custom"
export type RuntimeStatus = "recommended" | "supported" | "deprecated"

export type RuntimeCatalogueEntry = {
  id: Runtime
  language: RuntimeLanguage
  languageLabel: string
  version: string
  label: string
  os: "Amazon Linux 2" | "Amazon Linux 2023"
  executionModel: "managed" | "custom"
  deprecatedAt: string
  blockCreateAt: string
  blockUpdateAt: string
  selectionEndsAt?: string
  status: RuntimeStatus
  recommended: boolean
  defaultPresets: readonly string[]
  compatiblePresets: readonly string[]
}

const nodePresets = ["next", "hono", "web", "function"] as const
const functionPresets = ["function"] as const
const customRuntimePresets = ["web", "function"] as const

const RUNTIME_DEFINITIONS = [
  {
    id: "nodejs24.x",
    language: "node",
    languageLabel: "Node.js",
    version: "24",
    label: "Node.js 24",
    os: "Amazon Linux 2023",
    deprecatedAt: "2028-04-30",
    blockCreateAt: "2028-06-01",
    blockUpdateAt: "2028-07-01",
    status: "recommended",
    recommended: true,
    compatiblePresets: nodePresets,
  },
  {
    id: "nodejs22.x",
    language: "node",
    languageLabel: "Node.js",
    version: "22",
    label: "Node.js 22",
    os: "Amazon Linux 2023",
    deprecatedAt: "2027-04-30",
    blockCreateAt: "2027-06-01",
    blockUpdateAt: "2027-07-01",
    status: "supported",
    recommended: false,
    compatiblePresets: nodePresets,
  },
  {
    id: "python3.14",
    language: "python",
    languageLabel: "Python",
    version: "3.14",
    label: "Python 3.14",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-06-30",
    blockCreateAt: "2029-07-31",
    blockUpdateAt: "2029-08-31",
    status: "recommended",
    recommended: true,
    compatiblePresets: functionPresets,
  },
  {
    id: "python3.13",
    language: "python",
    languageLabel: "Python",
    version: "3.13",
    label: "Python 3.13",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-06-30",
    blockCreateAt: "2029-07-31",
    blockUpdateAt: "2029-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "python3.12",
    language: "python",
    languageLabel: "Python",
    version: "3.12",
    label: "Python 3.12",
    os: "Amazon Linux 2023",
    deprecatedAt: "2028-10-31",
    blockCreateAt: "2028-11-30",
    blockUpdateAt: "2029-01-10",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "python3.11",
    language: "python",
    languageLabel: "Python",
    version: "3.11",
    label: "Python 3.11",
    os: "Amazon Linux 2",
    deprecatedAt: "2027-06-30",
    blockCreateAt: "2027-07-31",
    blockUpdateAt: "2027-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "python3.10",
    language: "python",
    languageLabel: "Python",
    version: "3.10",
    label: "Python 3.10",
    os: "Amazon Linux 2",
    deprecatedAt: "2026-10-31",
    blockCreateAt: "2027-02-01",
    blockUpdateAt: "2027-03-03",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "java25",
    language: "java",
    languageLabel: "Java",
    version: "25",
    label: "Java 25",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-06-30",
    blockCreateAt: "2029-07-31",
    blockUpdateAt: "2029-08-31",
    status: "recommended",
    recommended: true,
    compatiblePresets: functionPresets,
  },
  {
    id: "java21",
    language: "java",
    languageLabel: "Java",
    version: "21",
    label: "Java 21",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-06-30",
    blockCreateAt: "2029-07-31",
    blockUpdateAt: "2029-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "java17.al2023",
    language: "java",
    languageLabel: "Java",
    version: "17",
    label: "Java 17 (AL2023)",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-06-30",
    blockCreateAt: "2029-07-31",
    blockUpdateAt: "2029-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "java11.al2023",
    language: "java",
    languageLabel: "Java",
    version: "11",
    label: "Java 11 (AL2023)",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-06-30",
    blockCreateAt: "2029-07-31",
    blockUpdateAt: "2029-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "java8.al2023",
    language: "java",
    languageLabel: "Java",
    version: "8",
    label: "Java 8 (AL2023)",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-06-30",
    blockCreateAt: "2029-07-31",
    blockUpdateAt: "2029-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "java17",
    language: "java",
    languageLabel: "Java",
    version: "17",
    label: "Java 17 (AL2)",
    os: "Amazon Linux 2",
    deprecatedAt: "2027-06-30",
    blockCreateAt: "2027-07-31",
    blockUpdateAt: "2027-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "java11",
    language: "java",
    languageLabel: "Java",
    version: "11",
    label: "Java 11 (AL2)",
    os: "Amazon Linux 2",
    deprecatedAt: "2027-06-30",
    blockCreateAt: "2027-07-31",
    blockUpdateAt: "2027-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "java8.al2",
    language: "java",
    languageLabel: "Java",
    version: "8",
    label: "Java 8 (AL2)",
    os: "Amazon Linux 2",
    deprecatedAt: "2027-06-30",
    blockCreateAt: "2027-07-31",
    blockUpdateAt: "2027-08-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "dotnet10",
    language: "dotnet",
    languageLabel: ".NET",
    version: "10",
    label: ".NET 10",
    os: "Amazon Linux 2023",
    deprecatedAt: "2028-11-14",
    blockCreateAt: "2028-12-14",
    blockUpdateAt: "2029-01-15",
    status: "recommended",
    recommended: true,
    compatiblePresets: functionPresets,
  },
  {
    id: "dotnet8",
    language: "dotnet",
    languageLabel: ".NET",
    version: "8",
    label: ".NET 8",
    os: "Amazon Linux 2023",
    deprecatedAt: "2026-11-10",
    blockCreateAt: "2027-02-01",
    blockUpdateAt: "2027-03-03",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "ruby4.0",
    language: "ruby",
    languageLabel: "Ruby",
    version: "4.0",
    label: "Ruby 4.0",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-03-31",
    blockCreateAt: "2029-04-30",
    blockUpdateAt: "2029-05-31",
    status: "recommended",
    recommended: true,
    compatiblePresets: functionPresets,
  },
  {
    id: "ruby3.4",
    language: "ruby",
    languageLabel: "Ruby",
    version: "3.4",
    label: "Ruby 3.4",
    os: "Amazon Linux 2023",
    deprecatedAt: "2028-03-31",
    blockCreateAt: "2028-04-30",
    blockUpdateAt: "2028-05-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "ruby3.3",
    language: "ruby",
    languageLabel: "Ruby",
    version: "3.3",
    label: "Ruby 3.3",
    os: "Amazon Linux 2023",
    deprecatedAt: "2027-03-31",
    blockCreateAt: "2027-04-30",
    blockUpdateAt: "2027-05-31",
    status: "supported",
    recommended: false,
    compatiblePresets: functionPresets,
  },
  {
    id: "provided.al2023",
    language: "custom",
    languageLabel: "Custom",
    version: "AL2023",
    label: "Custom runtime (AL2023)",
    os: "Amazon Linux 2023",
    deprecatedAt: "2029-06-30",
    blockCreateAt: "2029-07-31",
    blockUpdateAt: "2029-08-31",
    status: "recommended",
    recommended: true,
    compatiblePresets: customRuntimePresets,
  },
] as const satisfies readonly Omit<RuntimeCatalogueEntry, "executionModel" | "defaultPresets">[]

export const RUNTIME_CATALOGUE: readonly RuntimeCatalogueEntry[] = RUNTIME_DEFINITIONS.map(
  (entry) => ({
    ...entry,
    executionModel: entry.language === "custom" ? "custom" : "managed",
    defaultPresets:
      entry.id === "nodejs24.x"
        ? ["next", "hono", "function"]
        : entry.id === "provided.al2023"
          ? ["web"]
          : [],
  }),
)

export const SUPPORTED_RUNTIMES = RUNTIME_CATALOGUE.map((entry) => entry.id)
export type SupportedRuntime = (typeof RUNTIME_DEFINITIONS)[number]["id"]

export function runtimeCatalogueEntry(value: string): RuntimeCatalogueEntry | undefined {
  return RUNTIME_CATALOGUE.find((entry) => entry.id === value)
}

export function isSupportedRuntime(value: string, at = new Date()): value is SupportedRuntime {
  const entry = runtimeCatalogueEntry(value)
  if (entry === undefined) return false
  return entry.selectionEndsAt === undefined || at < new Date(`${entry.selectionEndsAt}T00:00:00Z`)
}

export function isRuntimeCompatible(preset: string, runtime: string): boolean {
  const entry = runtimeCatalogueEntry(runtime)
  return entry !== undefined && entry.compatiblePresets.includes(preset)
}

export const DEFAULT_RUNTIME: SupportedRuntime = "nodejs24.x"
export const DEFAULT_HANDLER = "index.handler"

const PRESET_DEFAULTS: Record<string, PresetRuntime> = {
  next: { runtime: DEFAULT_RUNTIME, handler: WEB_ADAPTER_HANDLER, webAdapter: true },
  hono: { runtime: DEFAULT_RUNTIME, handler: WEB_ADAPTER_HANDLER, webAdapter: true },
  web: { runtime: "provided.al2023", handler: "bootstrap", webAdapter: true },
  function: { runtime: DEFAULT_RUNTIME, handler: DEFAULT_HANDLER, webAdapter: false },
  static: { runtime: DEFAULT_RUNTIME, handler: DEFAULT_HANDLER, webAdapter: false },
}

export type PresetRuntime = { runtime: SupportedRuntime; handler: string; webAdapter: boolean }

export function runtimeForPreset(preset: string): PresetRuntime {
  return (
    PRESET_DEFAULTS[preset] ?? {
      runtime: DEFAULT_RUNTIME,
      handler: DEFAULT_HANDLER,
      webAdapter: false,
    }
  )
}

export function handlerForPreset(preset: string, runtime: string): string {
  if (preset === "web") return runtime.startsWith("provided.") ? "bootstrap" : WEB_ADAPTER_HANDLER
  return runtimeForPreset(preset).handler
}

export function webAdapterForRelease(preset: string, handler: string | undefined): boolean {
  const defaults = runtimeForPreset(preset)
  return (
    defaults.webAdapter &&
    (handler === undefined ||
      handler === defaults.handler ||
      (preset === "web" && (handler === "bootstrap" || handler === WEB_ADAPTER_HANDLER)))
  )
}
