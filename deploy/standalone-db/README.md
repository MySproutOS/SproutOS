# Standalone control-plane Postgres

A control-plane database for a cluster that has no managed one — a trial cluster, a free-tier GKE or
AKS, or any environment where `tofu` has not built RDS.

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
