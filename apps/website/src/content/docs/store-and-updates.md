---
slug: store-and-updates
title: Install apps and receive upstream updates
summary: Create a repository-backed copy from a reviewed listing, complete setup inputs, and review maintenance pull requests.
audience: user
category: Apps and updates
order: 40
---

The SproutOS App Store starts from reviewed open-source listings. Installing a web listing resolves
an exact catalogue commit and plugin digest, creates your destination repository and declared
services, and preserves the upstream project as provenance.

## Review before installing

Check the listing's source, description, required services, setup fields, deployment target, and
privacy expectations. Secret setup values are used for provisioning and must not be committed to
the generated repository.

SproutOS applies only the signed catalogue recipe. It does not execute instructions discovered in
an arbitrary upstream repository. The generated `.config/sproutos.toml`, when present, is a
declarative description for people and agents; it is not executable catalogue authority.

## Own the resulting project

The installed application is your repository-backed project, not a shared mutable copy. You can
customize it with the hosted Agent or a local coding agent, add services, and deploy it through the
same production controls as any other project.

Public App Store provenance does not make a personalized fork public. Store publication and review
are separate from creating a private organizational project.

## Receive upstream changes safely

Upstream maintenance opens a proposal branch and pull request so repository CI and branch
protection can evaluate the change. **Suggest** leaves the reviewed pull request for a person to
merge. **Auto merge** merges only after the configured checks and protections pass. A merge
conflict is bounded conflict-resolution work; it is not permission to bypass the pull-request gate.

Choose a cadence appropriate to the application's risk and review capacity. Turning on automatic
maintenance does not automatically deploy every merged change unless your GitHub Actions workflow
deploys that branch.

Deleting the SproutOS project never deletes the GitHub repository, including an App Store fork.
Manage the source repository separately in GitHub.
