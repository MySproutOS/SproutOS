---
slug: organizations-and-access
title: Organizations and access
summary: Understand the ownership boundary for projects, services, billing, credentials, and team permissions.
audience: user
category: Getting started
order: 3
---

An organization is the top-level ownership boundary in SproutOS. Its members share access to the
projects and services they are allowed to manage, while its billing ledger and model credentials
remain isolated from every other organization.

## What belongs to an organization

An organization owns:

- repository groups and deployable projects;
- standalone and project-attached backend services;
- visual workflow definitions and workflow repositories;
- hosted Agent credentials and configuration;
- domains, usage records, credit, and billing history.

Switching organizations changes all of these views. If a project or database appears to be missing,
check the organization switcher before recreating it.

## Give people the least access they need

Permissions are enforced for the organization and, where applicable, for individual resources.
Someone who can view a workflow does not necessarily have permission to edit its graph, start a
run, or inspect a queued job payload. Owners should reserve credential, billing, destructive, and
job-edit permissions for trusted operators.

Model credentials are organization-scoped. They are not shared with another organization and are
not copied into project environment variables. Backend service credentials are also tenant-scoped;
do not reuse them across organizations or publish them in a repository.

## GitHub is a separate authorization boundary

SproutOS can only see repositories granted to its GitHub App installation. A SproutOS organization
membership does not grant GitHub access, and GitHub access alone does not grant SproutOS access.
Keep both sets of permissions current when someone joins or leaves a team.

Deployments from GitHub Actions use a short-lived repository-bound OIDC credential. They do not
require a long-lived organization token stored in GitHub.

## Deletion and retained records

Deleting a project tears down platform resources and prevents new use while preserving the billing
and audit records that explain past activity. SproutOS never deletes the GitHub repository. If you
also want the source repository deleted, perform that separately in GitHub after reviewing its
branches, pull requests, and any other consumers.

See [Understand billing](/docs/billing) for the credit and retained-data boundary.
