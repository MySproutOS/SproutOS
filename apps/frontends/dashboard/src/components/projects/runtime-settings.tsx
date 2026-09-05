import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/base/ui/select"
import { useCallback, useMemo, type ChangeEvent } from "react"

export type DeploymentPreset = "next" | "hono" | "web" | "function" | "static" | "android"

export type RuntimeEntry = {
  id: string
  language: string
  languageLabel: string
  label: string
  os: string
  status: string
  selectable: boolean
  deprecatedAt: Date
  selectionEndsAt: Date | null
  compatiblePresets: string[]
}

export function compatibleRuntimes(runtimes: RuntimeEntry[], preset: DeploymentPreset) {
  return runtimes.filter((entry) => entry.selectable && entry.compatiblePresets.includes(preset))
}

export function preferredRuntime(
  runtimes: RuntimeEntry[],
  preset: DeploymentPreset,
): string | null {
  if (["static", "android"].includes(preset)) return null
  const candidates = compatibleRuntimes(runtimes, preset)
  return (
    (preset === "web"
      ? candidates.find((entry) => entry.id === "provided.al2023")?.id
      : undefined) ??
    candidates.find((entry) => entry.status === "recommended")?.id ??
    candidates[0]?.id ??
    null
  )
}

export function RuntimeSettings({
  preset,
  runtime,
  handler,
  runtimes,
  onPresetChange,
  onRuntimeChange,
  onHandlerChange,
}: {
  preset: DeploymentPreset
  runtime: string | null
  handler: string
  runtimes: RuntimeEntry[]
  onPresetChange: (preset: DeploymentPreset) => void
  onRuntimeChange: (runtime: string | null) => void
  onHandlerChange: (handler: string) => void
}) {
  const lambdaBacked = !["static", "android"].includes(preset)
  const compatible = useMemo(() => compatibleRuntimes(runtimes, preset), [preset, runtimes])
  const selected = compatible.find((entry) => entry.id === runtime)
  const language = selected?.language ?? compatible[0]?.language ?? null
  const languages = [...new Map(compatible.map((entry) => [entry.language, entry.languageLabel]))]
  const handlePresetChange = useCallback(
    (value: DeploymentPreset | null) => {
      if (value !== null) onPresetChange(value)
    },
    [onPresetChange],
  )
  const handleLanguageChange = useCallback(
    (value: string | null) => {
      const recommendation = compatible.find(
        (entry) => entry.language === value && entry.status === "recommended",
      )
      const first = compatible.find((entry) => entry.language === value)
      onRuntimeChange(recommendation?.id ?? first?.id ?? null)
    },
    [compatible, onRuntimeChange],
  )
  const handleHandlerChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onHandlerChange(event.target.value)
    },
    [onHandlerChange],
  )

  return (
    <div className="grid gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-1.5">
        <Label>Framework preset</Label>
        <Select value={preset} onValueChange={handlePresetChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="next">Next.js</SelectItem>
            <SelectItem value="hono">Hono</SelectItem>
            <SelectItem value="web">Web server</SelectItem>
            <SelectItem value="function">Function</SelectItem>
            <SelectItem value="static">Static site</SelectItem>
            <SelectItem value="android">Android</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {lambdaBacked && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Language</Label>
            <Select value={language} onValueChange={handleLanguageChange}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a language" />
              </SelectTrigger>
              <SelectContent>
                {languages.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Version</Label>
            <Select value={runtime} onValueChange={onRuntimeChange}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a version" />
              </SelectTrigger>
              <SelectContent>
                {compatible
                  .filter((entry) => entry.language === language)
                  .map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {selected?.os === "Amazon Linux 2" && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          This version uses Amazon Linux 2. Prefer an AL2023 version for a longer support window.
        </p>
      )}
      {selected !== undefined && (
        <p
          className={
            selected.status === "deprecated"
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {selected.status === "deprecated"
            ? `${selected.label} is deprecated.`
            : `AWS currently schedules ${selected.label} for deprecation on ${selected.deprecatedAt.toLocaleDateString()}.`}
          {selected.selectionEndsAt === null
            ? ""
            : ` New selections end ${selected.selectionEndsAt.toLocaleDateString()}.`}
        </p>
      )}
      {preset === "function" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="function-handler">Function handler</Label>
          <Input
            id="function-handler"
            value={handler}
            onChange={handleHandlerChange}
            placeholder="index.handler"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Advanced: the handler exported by the finished Lambda package.
          </p>
        </div>
      )}
    </div>
  )
}
