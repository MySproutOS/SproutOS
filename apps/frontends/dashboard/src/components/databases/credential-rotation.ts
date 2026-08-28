import type { BackendService } from "@frontends/dashboard/data/databases"

export function credentialRotationGuidance(service: Pick<BackendService, "id" | "status">): {
  canRotate: boolean
  tooltipCopy: string
  tooltipId: string
} {
  const canRotate = service.status === "active"
  return {
    canRotate,
    tooltipId: `rotate-credential-${service.id}-description`,
    tooltipCopy: canRotate
      ? "Replace the current password and show a new connection URI once. The current URI stops working immediately."
      : "Credentials can be rotated after this database becomes active.",
  }
}
