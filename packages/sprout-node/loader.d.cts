export function artifactNameFor(
  platform: NodeJS.Platform,
  architecture: string,
  glibc?: boolean,
): string
export function loadNative(): {
  applyTemplateJson(inputJson: string): Promise<string>
  nativeRuntimeStatusJson(): string
}
