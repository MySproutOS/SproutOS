# The API signed uploads for a bucket it did not know

**Found:** 2026-08-28, by deploying a marked static artifact with the released CLI against the
production `Static Launch Smoke` project.

## What looked true

The tenant build bucket existed, the worker received `SERVICE_BUILD_BUCKET`, the API returned a
valid presigned URL, and the normal control-plane health checks were green. Static assets used the
parallel `TENANT_STATIC_BUCKET` contract successfully.

## What was actually true

The API process is what creates the primary build upload URL, but its ECS environment omitted
`SERVICE_BUILD_BUCKET`. `deploy.ts` therefore used its local-development fallback,
`sproutos-dev-artifacts`. That bucket does not exist in production, so the signed PUT returned 404
and every CLI or GitHub Action deployment stopped before a deployment row was created.

The worker's correctly configured bucket could not help: it runs only after the API has accepted an
uploaded artifact. Repository checks saw the variable somewhere in the task definition and did not
prove that it reached the process which reads it.

## What stops it recurring

The API container now receives the exact OpenTofu-managed tenant build bucket. The application
configuration check also binds `SERVICE_BUILD_BUCKET` specifically to the API container, rather
than treating a value supplied to any sibling process as sufficient.

The production acceptance remains the decisive check: use the released CLI to upload a uniquely
marked artifact, wait for the deployment to become ready, and load that marker through the public
tenant hostname in Chrome.
