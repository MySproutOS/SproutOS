import { attributionLabels } from "@lib/metering"
import { execInPod, type ExecResult } from "./exec"

/**
 * A dev sandbox: TASK 19.
 *
 * A pod that stays up, holding a checkout, that a person opens files in and runs commands against.
 * Different from the Job in `run.ts` in exactly one way that matters — it outlives a single
 * operation — and identical in every isolation property: the tenant's namespace and its
 * NetworkPolicy, no service-account token, no root, no capabilities, hard limits.
 *
 * `runtime_class` defaults to `kata-clh` in the schema, and that default is load-bearing rather
 * than decorative: ADR 0012 puts dev sandboxes and agent sessions on Cloud Hypervisor because
 * Firecracker under Kata has no virtio-fs, so its only rootfs path is a devmapper thin snapshot and
 * anything needing a live filesystem cannot use it. A dev sandbox is nothing *but* a live
 * filesystem.
 *
 * Where no runtime class exists the pod runs under the node's default, which is the same honest
 * reduction `run.ts` documents.
 */

export type DevSandboxSpec = {
  namespace: string
  /** Who pays for the pod. Required, for the reason `SandboxSpec.organizationId` gives. */
  organizationId: string
  /** The project the workspace belongs to. A dev sandbox always has one. */
  projectId: string
  /** The pod's name. `sandbox.pod_name`. */
  name: string
  image: string
  /** `sandbox.runtime_class`; omitted when the cluster has no such class. */
  runtimeClassName?: string
  /** Seconds of inactivity before the reaper stops it. Recorded on the pod for the reaper to read. */
  idleTimeoutSeconds: number
  cpu?: string
  memory?: string
  /** The port a dev server is expected on, surfaced so the platform can route to it. */
  port?: number
}

/** Where the checkout lives, and the only path the file API will touch. */
export const WORKSPACE = "/workspace"

export function devSandboxPod(spec: DevSandboxSpec): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: {
        "app.kubernetes.io/part-of": "sproutos",
        "sproutos.dev/sandbox": "dev",
        // A dev sandbox holds a pod for fifteen minutes past the last keystroke. That is real
        // compute on a real node and it was billed to nobody.
        ...attributionLabels(spec.organizationId, spec.projectId),
      },
      annotations: {
        // Read by the reaper. An annotation rather than a field, because Kubernetes has no notion
        // of "idle" and the timeout belongs to the platform's policy, not to the pod's contract.
        "sproutos.dev/idle-timeout-seconds": String(spec.idleTimeoutSeconds),
      },
    },
    spec: {
      // `Never`: a dev sandbox that restarts silently loses the shell state a person was working
      // in, and looks identical to one that never went away. Stopping is the honest outcome.
      restartPolicy: "Never",
      /*
        The taint a sandbox node carries.

        GKE taints a GKE Sandbox node `sandbox.gke.io/runtime=gvisor:NoSchedule` so ordinary
        workloads do not land on it — the node runs a user-space kernel and everything on it
        pays for that. A pod naming `runtimeClassName: gvisor` without this toleration stays
        Pending forever with no indication that the reason is a taint rather than capacity,
        which is a bad afternoon.

        Unconditional rather than added only when the runtime class is gVisor: a toleration for
        a taint no node carries does nothing at all, and a conditional here would be a second
        place for the two to disagree.
      */
      tolerations: [
        { key: "sandbox.gke.io/runtime", operator: "Equal", value: "gvisor", effect: "NoSchedule" },
      ],
      ...(spec.runtimeClassName === undefined ? {} : { runtimeClassName: spec.runtimeClassName }),
      automountServiceAccountToken: false,
      containers: [
        {
          name: "dev",
          image: spec.image,
          /*
            Sleeps, and does not run the customer's dev command.

            The pod is a place to run things, not a thing that runs. Baking the dev command into the
            pod means a command that exits takes the sandbox with it — and a person debugging a
            crash-on-start has just lost the environment they were debugging it in.
          */
          command: ["sleep", "infinity"],
          workingDir: WORKSPACE,
          ...(spec.port === undefined
            ? {}
            : { ports: [{ containerPort: spec.port, name: "dev" }] }),
          resources: {
            requests: { cpu: spec.cpu ?? "200m", memory: spec.memory ?? "512Mi" },
            limits: { cpu: spec.cpu ?? "1", memory: spec.memory ?? "1Gi" },
          },
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            allowPrivilegeEscalation: false,
            // Not read-only, unlike the Job sandbox: this one exists to hold a filesystem somebody
            // edits. The writable surface is bounded by the volumes below rather than by the image.
            readOnlyRootFilesystem: false,
            capabilities: { drop: ["ALL"] },
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumeMounts: [
            { name: "workspace", mountPath: WORKSPACE },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        // `emptyDir` and not a PVC. A PVC would survive the pod and is what a customer eventually
        // wants; it is also ReadWriteOnce on every cloud's default class, which means a second pod
        // — a file operation, say — cannot mount it while this one holds it. Said here rather than
        // discovered by whoever adds one.
        { name: "workspace", emptyDir: { sizeLimit: "4Gi" } },
        { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
      ],
    },
  }
}

/** Where a pod lives in the API. */
export function podPath(namespace: string, name: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`
}

export class PathEscapesWorkspaceError extends Error {
  override readonly name = "PathEscapesWorkspaceError"

  constructor(readonly path: string) {
    super(`${JSON.stringify(path)} is outside the workspace`)
  }
}

/**
 * A path inside the workspace, or a refusal.
 *
 * The pod already refuses a great deal — no root, no capabilities, its own namespace — and none of
 * that stops a file API being asked for `../../etc/shadow`. Normalised and checked here rather than
 * relying on the container, because the container has files worth not handing out and a customer
 * chose this string.
 *
 * Rejects absolute paths outright rather than rebasing them: `/etc/passwd` rebased to
 * `/workspace/etc/passwd` is a silently different file from the one that was asked for, and silence
 * is what makes a path bug hard to find.
 */
export function resolveWorkspacePath(relative: string): string {
  if (relative === "" || relative.startsWith("/")) throw new PathEscapesWorkspaceError(relative)
  if (relative.includes("\0")) throw new PathEscapesWorkspaceError(relative)

  const parts: string[] = []
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (parts.length === 0) throw new PathEscapesWorkspaceError(relative)
      parts.pop()
      continue
    }
    parts.push(segment)
  }

  if (parts.length === 0) throw new PathEscapesWorkspaceError(relative)
  return `${WORKSPACE}/${parts.join("/")}`
}

export type SandboxTarget = {
  server: string
  token?: () => string
  certificateAuthority?: string
  namespace: string
  pod: string
}

/** Read one file out of the workspace. */
export async function readFile(target: SandboxTarget, path: string): Promise<ExecResult> {
  return await execInPod({
    ...target,
    container: "dev",
    // `--` so a filename beginning with a dash is a filename. `cat` is the whole implementation:
    // there is no shell in this command line, so nothing in the path can become a second one.
    command: ["cat", "--", resolveWorkspacePath(path)],
  })
}

/** Write one file into the workspace, creating its directories. */
export async function writeFile(
  target: SandboxTarget,
  path: string,
  contents: string,
): Promise<ExecResult> {
  const resolved = resolveWorkspacePath(path)
  const directory = resolved.slice(0, resolved.lastIndexOf("/"))

  return await execInPod({
    ...target,
    container: "dev",
    /*
      The content travels as an argument, not on stdin. That is the whole point of this shape.

      It used to be `cat > file` with the bytes written to the stdin channel, which worked — until a
      sandbox ran under gVisor and it did not. **The Kubernetes exec protocol has no way to close
      stdin.** `v4.channel.k8s.io` frames carry a channel byte and data; there is no half-close, and
      the only signal a server gets is the WebSocket closing, which cannot happen while output is
      still wanted. `cat` therefore waits for an EOF that never comes, the exec runs to its timeout,
      and no status frame arrives.

      What made that survivable on the default runtime is that `cat` writes as it reads, so the file
      was already correct when the timeout fired. The write *worked* and reported failure — one more
      thing that looked broken and was not, and one more thing that looked fine and was not.

      Base64 removes stdin from the path entirely. The alphabet is `A-Za-z0-9+/=`, so nothing in it
      needs quoting and no content can escape the argument — which also makes this safer than the
      shape it replaces, where only the *path* was ever quoted.
    */
    command: writeCommand(resolved, directory, contents),
  })
}

/**
 * The argv that writes one file, with the content base64'd into an argument.
 *
 * Separate from `writeFile` so it can be asserted without a cluster: the shape is the part that has
 * to be right, and a test that needs a running pod to check it is a test nobody runs.
 */
export function writeCommand(resolved: string, directory: string, contents: string): string[] {
  const encoded = Buffer.from(contents, "utf8").toString("base64")
  if (encoded.length > MAX_WRITE_ARGUMENT) throw new FileTooLargeError(contents.length)

  return [
    "sh",
    "-c",
    `mkdir -p ${shellQuote(directory)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(resolved)}`,
  ]
}

/**
 * The largest base64 payload that goes in one argument.
 *
 * `ARG_MAX` is 2 MiB on Linux for the whole argument list and 128 KiB for any single argument, and
 * an oversized one fails with `E2BIG` — which surfaces as an exec that could not start, several
 * layers from the file that was too big. Refused here with a sentence instead.
 *
 * 96 KiB of base64 is 72 KiB of file, comfortably inside the single-argument limit. A dev sandbox
 * edits source; something larger belongs in the repository, not in a text field.
 */
export const MAX_WRITE_ARGUMENT = 96 * 1024

export class FileTooLargeError extends Error {
  override readonly name = "FileTooLargeError"

  constructor(readonly bytes: number) {
    super(
      `That file is ${bytes} bytes. A sandbox write is limited to what fits in one command ` +
        `argument — about ${Math.floor((MAX_WRITE_ARGUMENT * 3) / 4 / 1024)} KiB.`,
    )
  }
}

/** List the workspace, one path per line, directories marked with a trailing slash. */
export async function listFiles(target: SandboxTarget, path = "."): Promise<ExecResult> {
  const resolved = path === "." ? WORKSPACE : resolveWorkspacePath(path)
  return await execInPod({
    ...target,
    container: "dev",
    command: ["ls", "-1Ap", "--", resolved],
  })
}

/** Run a command in the workspace. This is the terminal. */
export async function exec(
  target: SandboxTarget,
  command: string[],
  timeoutMs?: number,
): Promise<ExecResult> {
  if (command.length === 0) throw new Error("a command is required")
  return await execInPod({
    ...target,
    container: "dev",
    command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

/** POSIX single-quoting, including the one case people forget. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
