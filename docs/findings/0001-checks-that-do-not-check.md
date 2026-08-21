# 0001. Checks that could not fail

Every one of these reported success continuously while checking nothing. None was found by reading
the configuration; each was found by deliberately breaking the thing it was supposed to protect and
noticing that nothing went red.

## `pnpm run build` never typechecked either SPA

`vite build` strips types rather than checking them, so both frontends could be committed with type
errors and the build stayed green.

**Guard:** a `check-types` turbo task, run in CI.

## `tflint` accepted instance types and engines that do not exist

With the AWS ruleset enabled, `m8g.metal-nonsense` and `not-a-real-engine` both passed. The deep
rules do not cover those resource types.

**Guard:** none. Documented in `tofu/README.md` instead, because a guard that only appears to work
would be a second instance of this same finding.

## `kubectl --dry-run=client` validates nothing without a cluster

It was being used as the manifest check. It parses YAML and stops.

**Guard:** `kubeconform -strict`, which carries the schemas. `-strict` matters: a typo in a field
name is silently ignored by the API server, so `readOnlyRootFilesytem` applies cleanly and does
nothing.

## 28 tests skipped silently in CI, including all 8 KMS envelope-encryption tests

A skipped test is reported identically to a passing one. CI had never once executed the suite that
protects OAuth tokens and database credentials.

**Guard:** `bin/check-skipped-tests.mjs`, which treats the known skips as a ceiling and fails the
build when anything new starts skipping. Each entry records what it is waiting for.

## `kubeconform` counted six CRDs as validated while never looking at them

The External Secrets resources are custom resources. The job did not pass
`-ignore-missing-schemas` — deliberately — and resolved CRD schemas from a community catalogue, so
this one was doing real work. It still could not catch that the resources declared
`external-secrets.io/v1beta1`, which the installed operator does not serve at all: **a schema
catalogue happily validates a deprecated API version forever.**

**Guard:** a CI job that installs the real operator and applies the manifests, so the admission
webhook — the code that will actually read them in production — is what decides.

## `kind`'s default CNI accepts NetworkPolicy objects and ignores them

This is the worst one, because the thing not being checked was a security boundary.

Every possible tenant ingress rule "passed" — including deleting the policy outright. On that
evidence I concluded, twice, and wrote a comment asserting, that the gateway was the component
whose access mattered. On a cluster that enforces policy the answer is the opposite: the
**activator** is what connects to the revision, and allowing only the gateway leaves a tenant
application unreachable.

**Guard:** `.github/kind-cluster.yaml` disables the default CNI and CI installs Calico. The tenant
test asserts **both** directions — the app must answer through the gateway, and must _not_ answer a
direct request to its pod IP. The negative half is what keeps the positive half honest; without it
the test passes just as happily on a cluster that ignores NetworkPolicy entirely.

## What these have in common

The failure mode is not "the check was missing". In every case a check existed, ran, and was
reported. The question worth asking of any check is not whether it passes but **what would have to
be true for it to fail** — and then making that true, once, to watch it happen.

## `drop constraint if exists` is a silent no-op against an index

A migration replaced `region`'s unique index on `code` with one on `(provider, code)`, so that the
same region code can exist on two clouds. It used `alter table region drop constraint if exists
region_code_key`.

On that database `region_code_key` was an **index**, not a constraint. `drop constraint` does not
touch an index, and `if exists` turns the mismatch into silence. The migration applied cleanly,
reported success, left the old index in place, and went on rejecting the second cloud's `us-east-1` —
which is the entire thing it exists to permit.

It was caught by trying the insert the migration was written to allow. It would not have been caught
by reading the migration, by the migration succeeding, or by the schema having the new index —
because it does have the new index. It has both.

The related trap sits one step away: `ON CONFLICT (code)` in the region seed kept working for exactly
as long as the stale index survived, and `ON CONFLICT` with no matching unique index is a _planning_
error, so it fails on every row rather than on a duplicate.

**Guard:** the down migration recreates `region_code_key` as an index, so `up` now drops both forms.
A down-and-up cycle is what proves it — after one cycle the thing being dropped is no longer the
thing the schema started with.
