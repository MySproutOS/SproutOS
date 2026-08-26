import { daytonaConfigFromEnv, daytonaDriver } from "./daytona"
import { dockerConfigFromEnv, dockerDriver } from "./docker"
import type { SandboxDriver } from "./types"

export const SANDBOX_DRIVERS = ["daytona", "docker"] as const
export type SandboxDriverName = (typeof SANDBOX_DRIVERS)[number]

/**
 * Which driver runs sandboxes, from configuration rather than from a constant.
 *
 * Four call sites each built `daytonaDriver(daytonaConfigFromEnv())` inline, so the vendor was
 * chosen four times and could only ever be one. That is the shape of failure this repository keeps
 * finding: a default sitting where configuration belongs, invisible until the day the default is
 * wrong for everyone.
 *
 * `SANDBOX_DRIVER` is required rather than inferred. Guessing "docker if no Daytona key" would mean
 * a production box that lost its key silently starts running customer code in a local container,
 * which is a security posture change arrived at by omission. A missing value is an error naming
 * both options instead.
 */
export function sandboxDriverName(env: NodeJS.ProcessEnv = process.env): SandboxDriverName {
  const name = env.SANDBOX_DRIVER
  if (name === undefined || name === "") {
    throw new Error(
      "SANDBOX_DRIVER is not set. Set it to 'daytona' (rented sandboxes, what production runs) or " +
        "'docker' (a local container, for development). There is no safe default: inferring one " +
        "from whether a Daytona key happens to be present would let a lost key quietly move " +
        "customer code onto this machine.",
    )
  }

  if (!(SANDBOX_DRIVERS as readonly string[]).includes(name)) {
    throw new Error(
      `SANDBOX_DRIVER is '${name}', which is not a driver. Expected one of: ${SANDBOX_DRIVERS.join(", ")}.`,
    )
  }

  return name as SandboxDriverName
}

/**
 * The configured driver.
 *
 * Construction is deferred to the call, not cached, because both configs read the environment and a
 * cached driver would outlive a rotated key — the failure being an authentication error long after
 * the rotation that caused it.
 */
export function sandboxDriverFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxDriver {
  switch (sandboxDriverName(env)) {
    case "docker":
      return dockerDriver(dockerConfigFromEnv(env))
    case "daytona":
      return daytonaDriver(daytonaConfigFromEnv(env))
  }
}
