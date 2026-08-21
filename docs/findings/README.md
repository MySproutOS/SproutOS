# Findings

Things that were wrong, how they looked while they were wrong, and what now stops them coming back.

Every entry here shares one property: **it passed every check that existed.** Not one was found by
reading code, reviewing a diff, or thinking carefully. Each was found by running something and
watching it fail — and in several cases the failure was silent, so it was found by deliberately
breaking something and noticing that nothing broke.

That is the reason this directory exists separately from `../adr/`. An ADR records a decision taken
with the information available. These record the information that was _not_ available until
something ran, which is a different thing and a more uncomfortable one: most of these had a comment
next to them confidently describing the behaviour they did not have.

## The shape they keep taking

Four patterns account for nearly all of them.

**A check that cannot fail.** A test that skips, a validator with no schema, a CNI that accepts
NetworkPolicy objects and ignores them, a linter whose rule does not cover the resource type. These
are worse than no check, because the green tick is read as evidence.

**A partial failure read as a success.** Two of four images built, so the pin looked fine. A
`-q` build failed and the old tag still resolved, so the container that started looked like the one
just built. The two that worked were taken as evidence about the two that did not.

**A document describing something that was never built.** Three separate times a comment or README
described a mechanism in the present tense that no code implemented — pod discovery, fork upkeep,
a production entrypoint. Each read as a description of reality because it was written as one.

**A default that is wrong here specifically.** Knative's domain template, Knative's `Ready`
condition, the user-defined priority ceiling, a build that fetches its own git context. Nothing
about these is a bug in the upstream project; each is a default that does not survive contact with
this platform's constraints, and none announces itself.

## The records

| #                                         | Title                                      | Found by                     |
| ----------------------------------------- | ------------------------------------------ | ---------------------------- |
| [0001](0001-checks-that-do-not-check.md)  | Checks that could not fail                 | Breaking things deliberately |
| [0002](0002-images-that-had-never-run.md) | Every image was broken                     | Building and running them    |
| [0003](0003-manifests-never-applied.md)   | Manifests that had never met an API server | `kubectl apply`              |
| [0004](0004-defaults-that-do-not-fit.md)  | Upstream defaults that do not survive here | Running Knative and GKE      |

## Running it on more than one cloud

`bin/cloud-smoke.sh` runs the whole of this against any cluster, so "it works on AWS" and "it works
on GCP" mean the same thing. It was written after doing the same sequence by hand on GKE and AKS,
and the reason it exists is in the table above: **the differences between clouds are never where
anyone expects.**

Not one of them was a manifest problem. A Pod Security Standard on one, a ResourceQuota forbidding a
priority class on another, a CNI that accepts NetworkPolicy and ignores it on a third, a node service
account that cannot pull from the registry in the same project. Each was found by applying the same
files somewhere new and watching a different thing break.
