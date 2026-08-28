# Architecture Decision Records

Records **0001–0019** are the decisions taken in **Phase 0** of the SproutOS build plan, before any
code was written. Records **0020 and up** were taken later, forced by something that only became
visible once code ran — two of them amend a Phase 0 record whose reasoning was right and whose
mechanism did not exist. What made them necessary is catalogued in [`../findings/`](../findings/).

Thirteen research areas designed thirteen subtly incompatible systems: two API locations, two
tenancy nouns, two metering pipelines, two GitHub identity models, two hypervisor assumptions, three
apex domains, two component libraries. Each conflict was load-bearing in several areas and cheap to
settle up front — and a rewrite later. Records 0001–0019 are that settlement. Every later phase
cites them rather than relitigating them.

The raw research is in `private_notes/PLANNING_INITIAL_NOTES.md`. It is a scratchpad, not a
specification: several of its load-bearing claims are wrong (GitHub PKCE support, the balance-cache
sequence ordering, the metal cost baseline), and where it conflicts with an ADR, the ADR wins.

## Format

Each record has Context, Decision, Consequences, and Alternatives considered. The Context section
quotes both sides where two areas designed incompatible systems, so the disagreement is legible
rather than merely resolved.

## The records

| #                                                        | Title                                                                      | Settles             |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------- |
| [0001](0001-api-lives-in-apps-internal-api.md)           | The API is a separate app at `apps/internal-api`                           | API location        |
| [0002](0002-tenancy-noun-is-organization.md)             | The tenancy table is `organization`; the UI says "Team"                    | Tenancy noun        |
| [0003](0003-orgs-url-prefix.md)                          | Org-scoped URLs use the `/orgs/$orgSlug/` prefix                           | URL prefix          |
| [0004](0004-last-org-in-user-preference.md)              | Last-visited org is stored in `user_preference.last_org_id`                | Last-org storage    |
| [0005](0005-both-oauth-app-and-github-app.md)            | Register both a GitHub OAuth App and a GitHub App                          | GitHub identity     |
| [0006](0006-single-github-webhook-receiver.md)           | One GitHub webhook receiver, dispatching by event type                     | Webhook fan-out     |
| [0007](0007-github-installation-is-org-scoped.md)        | `github_installation` is org-scoped                                        | Installation shape  |
| [0008](0008-base-ui-only.md)                             | Base UI is the only component library; no Radix                            | UI library          |
| [0009](0009-fontsource-variable-fonts.md)                | Fonts ship as `@fontsource-variable/*` in all three apps                   | Font delivery       |
| [0010](0010-dark-only-theme.md)                          | The theme is dark-only, with tokens on bare `:root`                        | Theme               |
| [0011](0011-arm64-tenant-architecture.md)                | Tenant compute is arm64 (Graviton metal)                                   | Tenant architecture |
| [0012](0012-two-kata-runtime-classes.md)                 | Two Kata runtime classes: `kata-fc` and `kata-clh`                         | Hypervisor          |
| [0013](0013-metal-via-fixed-asg.md)                      | Metal nodes come from a fixed-size ASG, not Karpenter                      | Metal provisioning  |
| [0014](0014-one-metering-pipeline.md)                    | One metering pipeline; money never rides the telemetry path                | Metering path       |
| [0015](0015-store-table-is-store-listing.md)             | The store table is `store_listing`                                         | Store table name    |
| [0016](0016-one-rbac-action-catalogue.md)                | One RBAC action catalogue, colon separators only, SRN resources everywhere | RBAC grammar        |
| [0017](0017-soft-delete-on-billing-referenced-tables.md) | Soft delete (`deleted_at`) on anything billing history references          | Delete semantics    |
| [0018](0018-domains.md)                                  | `sproutos.dev` is the control plane; `sproutos.run` is tenant traffic      | Domains             |

## Adding a record

Number sequentially, name the file `NNNN-kebab-title.md`, keep the four sections, and add a row to
the table above. A decision that supersedes an earlier one says so in both records, and the earlier
one's Status becomes `Superseded by NNNN`.

The consolidated schema that these decisions produce is in [`../schema/TABLES.md`](../schema/TABLES.md).
| [0020](0020-build-images-on-the-target-platform.md) | Images build on the target platform rather than cross-compiling | Build architecture |
| [0021](0021-builds-run-in-their-own-namespace.md) | Builds run in `sproutos-builds`, never a tenant namespace | Build isolation |
| [0022](0022-tenant-hostnames-carry-a-discriminator.md) | Tenant hostnames carry a project discriminator (amends 0018) | Hostname collisions |
| [0023](0023-metering-attribution-from-the-api-server.md) | Metering attribution is listed from the API server (amends 0014) | Usage attribution |
| [0028](0028-kafka-clickhouse-metering.md) | Kafka and ClickHouse are the durable raw metering path (supersedes 0014 storage) | Metering path |
| [0030](0030-daytona-egress-uses-the-platform-proxy.md) | Daytona sandbox HTTP egress uses the platform proxy | Sandbox egress |

## Later records

0020–0023 exist because something ran and disagreed with a comment. Each names what it amends, and
none of them deletes the reasoning it replaces — where a superseded argument was sound, it is kept
alongside what bounds it now. A record that quietly drops the case against itself is a record that
cannot be re-litigated when circumstances change back.
