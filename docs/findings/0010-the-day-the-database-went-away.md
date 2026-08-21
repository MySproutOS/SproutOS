# 0010 — The day the database went away

Written after finishing TASK 19 (dev sandboxes), which is where all of this surfaced.

## What happened

Nine hours of end-to-end verification — GitHub sign-in, the store, forking a real repository,
sandboxed workflow runs, the credit ledger, a 23-turn agent session, tenant Postgres through
`pg-proxy` with cross-tenant isolation proven — ran against a control-plane Postgres whose data
volume was an `emptyDir`.

The pod was rescheduled onto another node. Every row went with it.

Nothing reported a problem. The StatefulSet came back Running, `/health` returned `{"status":"ok"}`,
and `GET /v1/store/listings` returned `{"data":[],"nextCursor":null}` — a correct response about an
empty table. The only symptom anywhere was a 503 on an authenticated route.

That 503 came from this:

```typescript
} catch {
  // Typically this means we're unable to connect to the database
  return throwHTTPException(503, ErrorCode.ServiceUnavailable, "Service unavailable")
}
```

The comment guessed right about the category and the code discarded the evidence. Finding out that
`session` no longer existed took a `psql` prompt and a `\dt`.

## The manifest

```yaml
persistentVolumeClaimRetentionPolicy:
  whenDeleted: Retain
  whenScaled: Retain
# ...
volumes:
  - emptyDir: {}
    name: data
```

A retention policy for a PersistentVolumeClaim that did not exist, eleven lines above the line
saying the storage was the node's scratch space. Everything a reviewer scans for as evidence of
durability was present. The one line that decided it was the one that looked like plumbing.

The StatefulSet was applied from a scratch file that never entered the repository, which is why no
review ever happened. It is now `deploy/standalone-db/postgres.yaml`, with a `volumeClaimTemplates`,
and `bin/render-manifests.mjs` explicitly skips that directory so it cannot be applied onto a cluster
that already has RDS.

## What the rebuild then exposed

A fresh database is an excellent test. Four defects had been sitting behind data that already
existed, and all four surfaced within twenty minutes of each other.

### The tenant namespace nobody created

`deploy/tenant/network-policy.yaml` has described tenant isolation since the compute phase. Nothing
in the repository ever applied it, and nothing ever created a tenant namespace either. Every code
path that runs customer code computed `tenantNamespace(organizationId)` and applied a workload into
it, assuming somebody had prepared it.

On the trial cluster somebody had — me, by hand, while verifying the workflow sandbox, followed by
the policy a minute later. So **the isolation test passed and proved a property of one hand-made
namespace rather than of the system.** The second organization to open a sandbox got
`namespaces "tenant-…" not found`.

The two failure modes are not equally loud, and the quiet one is the dangerous one:

- the namespace is missing — the apply fails, somebody looks;
- the namespace exists **without** its policies — customer code runs with unrestricted egress, and
  nothing anywhere reports a problem.

`ensureTenantNamespace` now applies the namespace *and* all three policies before every workload, in
deny-first order so a partial apply fails closed. It is not "create if missing": a namespace that
exists is not evidence that it is fenced.

The objects are defined in TypeScript and `tenant-namespace.test.ts` renders the YAML and asserts
they are deeply equal — the same one-source-two-assertions discipline the SRN grammar and the
metering event schema get, for the same reason.

### A type that claimed to match a constraint and matched nothing

```typescript
/** `sandbox.state`, matching the CHECK constraint. */
export type SandboxState = "starting" | "running" | "stopping" | "stopped" | "error"
```

The constraint permits `starting`, `running`, `idle`, `stopped`, `failed`. The union invented
`stopping` and `error`, and omitted `idle` and `failed`. A comment claiming two things match is not
a check that they do.

So the compiler agreed when the pod-create failure path wrote `state: "error"`, and the database did
not. The update threw inside a `catch`, and **the constraint violation replaced the error being
handled** — the reason the pod had failed to create was gone, and the only thing in the log was
Postgres complaining about a column value.

This is the second time. `workflow_run_step` got `blocked` the same way, for the same reason, and
`workflow-run.test.ts` already carried a test reading the permitted values out of `pg_constraint`.
That test was never extended to the next table. It is now, and it compares in **both directions** —
a subset check passes on the union that started this.

### A column that could not hold the truth

`sandbox.runtime_class` was `not null default 'kata-clh'` with a check permitting only `kata-fc` and
`kata-clh`. Both values assert a hardware-virtualized boundary. This cluster has no Kata runtime
class installed, `SANDBOX_RUNTIME_CLASS` is unset, and `devSandboxPod` correctly names none — so
every row claimed a VM that no pod had, purely from the default, and writing the truth failed the
constraint.

`runtime_class` is exactly the column someone queries to answer whether a customer's code ran in a
VM. The migration adds `none` and drops the default, because a default is the wrong mechanism for a
fact about a pod that does not exist yet.

And the serializer never read the column at all:

```typescript
runtimeClass: sandboxRuntimeClass() ?? null,
```

It reported the serving process's own environment variable for every sandbox it described. It gave
the right answer only because the row was guaranteed wrong.

### A validator that reshapes rather than refuses

`hono-typebox-openapi` runs `Value.Convert` before `Check`. Against
`Type.Array(Type.String(), { minItems: 1, maxItems: 64 })`:

| body | after Convert | result |
| --- | --- | --- |
| `{"command": ["ls","-la"]}` | `["ls","-la"]` | 200 |
| `{"command": "ls -la"}` | `["ls -la"]` | 200 |
| `{"command": 42}` | `["42"]` | 200 |
| `{"command": []}` | `[]` | 400 |

Only the empty array is refused — by `minItems`. **That is what made the validation look like it was
working.** Everything else is silently reshaped, and the handler cannot tell, because by the time it
reads `c.req.valid("json")` the original is gone.

For an argv the consequence is specific: `["ls -la"]` asks `execve` for a binary whose filename
contains a space, and in the Kubernetes exec protocol that failure arrives on the status channel
rather than on stderr. The caller receives `{"stdout":"","stderr":"","exitCode":1}` — which reads as
"your command ran and failed silently".

`requireArray` guards the one field where the difference is load-bearing. **The behaviour is not
specific to that field or that route**: any array-typed body field on any route accepts a scalar the
same way. A general fix belongs at the validator.

## The frame that was not a frame

Separately, and the reason TASK 19 looked broken for an hour: every sandbox operation reported
`exitCode: 1` while returning correct output. `node src/hello.js` printed `from the sandbox` and came
back a failure.

A WebSocket close frame carries a two-byte status code, and the normal one is 1000 — `0x03 0xE8`.
The frame reader did not check the opcode, so a close frame was read as a data frame on channel
**3**, the error stream, with `0xE8` and any reason text as its payload. Unparseable as JSON, so
`exitCodeFrom` returned 1 for every command that had just succeeded.

One comparison fixes it. The test asserts on the exact bytes, because the payload really does begin
with the error channel's number and that is why the opcode has to be the thing that is checked.

## What ties these together

Every one of them is a statement that was true of the artifact and false of the system.

- A retention policy that retained nothing, above an `emptyDir`.
- A NetworkPolicy manifest describing isolation nothing applied, next to an isolation test that
  passed because I had applied it by hand an hour earlier.
- A TypeScript union documented as matching a constraint it contradicted in four of five values.
- A column whose default asserted a VM boundary, and a serializer that answered from the environment
  instead of the row.
- A validator that enforced `minItems` and not the type, so the one thing it refused was the one
  case nobody sends.
- A close frame that looked exactly like an error, on the channel errors arrive on.

And a `catch` at each layer that turned the evidence into a status code. The database failure, the
pod-create failure, and the exec failure were each reported as something that had gone wrong
somewhere, with the cause discarded. Three logging statements would have collapsed a day into
minutes; they are all in place now.

## What changed

| Change | Why |
| --- | --- |
| `deploy/standalone-db/postgres.yaml` with `volumeClaimTemplates` | the control-plane database was on node scratch space |
| `bin/render-manifests.mjs` skips `standalone-db` | applying it beside RDS gives two databases and no error |
| `middleware.ts` logs the cause of a 503 | the only symptom of a wiped database was a status code |
| `lib/typescript/sandbox/src/tenant-namespace.ts` | nothing created a tenant namespace or applied its policies |
| `tenant-namespace.test.ts` renders the YAML and asserts equality | two definitions of one security boundary |
| `ensureTenantNamespace` in `runInSandbox`, `deployRevision`, the sandbox route | every path that runs customer code |
| `SANDBOX_STATES` / `SANDBOX_RUNTIME_CLASSES` as arrays, asserted against `pg_constraint` both ways | a union that claimed to match a constraint and did not |
| `2026_08_29…_sandbox_runtime_class_none` | the schema could not say "no VM boundary" |
| the sandbox serializer reads the row | it reported the server's environment for every sandbox |
| `requireArray` + `docs` on the coercion | `minItems` was the only thing being enforced |
| opcode check in `readFrame` | a close frame was read as an error-channel payload |
| `console.error` before the failure is recorded, in the pod-create path | the recording threw and ate the cause |
