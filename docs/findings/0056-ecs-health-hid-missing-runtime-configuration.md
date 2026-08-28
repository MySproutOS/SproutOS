# 0056: ECS health hid missing runtime configuration

## What was wrong

The ECS task definition moved the website, API, and worker out of the EC2 release without moving
the production environment contract with them. It injected the RDS secret into the API and worker,
but omitted the website's database configuration and almost every application parameter from all
three containers.

The task still became healthy. Next.js and Hono can bind their ports without OAuth, KMS, Kafka,
Daytona, Neon, or the tenant Valkey. The worker also starts before a scheduled handler first touches
its missing credential.

The externally visible symptoms were unrelated-looking:

- browser API calls failed CORS because `NEXT_PUBLIC_HOST_URL` was absent;
- OAuth/database-backed website routes failed only when used;
- metering and queue-memory jobs retried because `KAFKA_BROKERS` and
  `SERVICE_VALKEY_ADMIN_URL` were absent.

## Why the existing checks passed

ALB health checks proved only that the two HTTP ports answered. The image smoke test proved that a
non-root Node process could start and serve `/healthz`. Neither compared the task definition with
the environment produced by `user-data.sh.tftpl`, and no test exercised a credential-backed route
inside the final task definition.

The service was also registered into the same green target groups as a legacy EC2 release. Once the
fixed host ports made ECS healthy, production could randomly alternate between a fully configured
EC2 process and an underconfigured container while every target remained green.

## What stops it recurring

- The task definition now carries the plain deployment values each process needs and injects an
  explicit per-container allowlist from Parameter Store.
- The ECS execution role, which performs secret injection before container start, can read only the
  application parameter path and decrypt it only through SSM.
- Google OAuth keys are part of the template, upload allowlist, EC2 allowlist, and ECS website
  allowlist together.
- Production rollout keeps ECS at zero until the corrected task has been tested off-traffic and the
  legacy/ECS target-group transition is deliberate.
