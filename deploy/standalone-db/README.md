# In-cluster stand-ins for managed data services

`postgres.yaml` — the control plane's own database, standing in for RDS.
`valkey.yaml` — the shared tenant Valkey behind `valkey-proxy`, standing in for ElastiCache.

For a cluster that has no managed equivalents: a trial cluster, a free-tier GKE or AKS, or any
environment where `tofu` has not built them.

**Not part of the default render.** `bin/render-manifests.mjs` skips this directory: applying an
in-cluster Postgres onto a cluster that already points at RDS would give the control plane two
databases and no error. Apply it explicitly:

```bash
kubectl create namespace platform-db
kubectl create secret generic control-plane-postgres -n platform-db --from-literal=password=...
kubectl apply -f deploy/standalone-db/postgres.yaml
```

Then point `DATABASE_URL` at `postgres.platform-db.svc.cluster.local:5432/main` and run the
migrator.

## What this exists to prevent

The first version of this StatefulSet was applied from a scratch file that never entered the
repository, and its data volume was an `emptyDir`. It served the whole end-to-end verification —
sign-in, the store, forking a real repository, workflow runs, the credit ledger, agent sessions,
tenant database provisioning — for nine hours. Then the pod was rescheduled and every row was gone.

There was no alert and no error. The database came back up empty and healthy, `/health` returned
`ok`, and an unauthenticated store query returned `{"data":[]}` — a _correct_ response about an
empty table. The only signal was a 503 on an authenticated route, from a `catch` that reported
"Service unavailable" without the cause.

Two things follow, and both are in the code now:

- A database gets a `volumeClaimTemplates`. `persistentVolumeClaimRetentionPolicy: Retain` above an
  `emptyDir` is not a weaker version of that; it is a line that reads like durability and provides
  none.
- A `catch` that turns an unknown failure into a status code logs what it caught. See
  `apps/internal-api/src/middleware.ts`.

## Two things a cluster this small will do to you

**The `restricted` Pod Security Standard fails at pod creation, not at apply.** `sproutos-system`
enforces it. A StatefulSet whose pod violates it is _created_ — `kubectl apply` prints a warning and
then says the object was configured — and then reports 0/1 forever with the reason only in its own
event log. Both files here carry a full `securityContext` for that reason. Watch for `fsGroup` in
particular: without it the PersistentVolume arrives owned by root and the database cannot write, one
layer removed from the setting that caused it.

**A rolling update needs room to surge.** The default `maxSurge: 25%` rounds up to one extra pod, so
rolling a single-replica Deployment briefly needs twice its CPU request. On two small nodes the new
pod sits Pending with `Insufficient cpu`, the old one is never terminated, and `rollout status`
times out with both still running — nothing broken, nothing rolled out. The manifests in
`deploy/platform/` declare two and three replicas, where the default surge is fine. If you have
scaled them to one for a trial, patch the strategy rather than wondering why deploys hang:

```bash
kubectl patch deploy internal-api -n sproutos-system --type merge \
  -p '{"spec":{"strategy":{"rollingUpdate":{"maxSurge":0,"maxUnavailable":1}}}}'
```
