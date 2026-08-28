# Deployment documentation described two orchestrators

**Found:** 2026-08-28, while reconciling the public docs with the App Store and CLI launch plan.

## What looked true

The public workflow guide named the Marketplace action, and the injected coding-agent skill taught
the same YAML. Both were internally consistent with the deploy endpoint. A developer could copy the
workflow without first learning SproutOS internals.

## What was actually true

Those instructions made the action appear to own deployment. The current launch contract has one
orchestrator: the `sprout` CLI backed by `sprout-core`. The action is a pinned wrapper, and the
TypeScript worker reaches the same core through the Node binding. Teaching the action as a separate
system creates two contracts the first time either side changes packaging, upload negotiation, or
terminal-state handling.

The old guide also told an `AGENTS.md` harness to append the entire skill body. That risks replacing
or obscuring repository-specific instructions. A skill should be installed where the harness loads
skills; an `AGENTS.md`-only harness needs only a short pointer to the downloaded file.

Finally, the App Store additions originally proposed discovering deployment instructions from a
file inside an arbitrary upstream repository. That is no longer an authority boundary. Eligibility
and executable template behavior come only from the signed `MySproutOS/Deployment-Templates`
catalogue. A generated `.config/sproutos.toml` is declarative context, not executable authority.

## What stops it recurring

The public GitHub guide and the downloadable skill now name the same ownership graph, local CLI
syntax, OIDC boundary, and catalogue provenance. Tests reject the superseded manifest and mirror
names and assert that local-harness installation and the no-sandbox-charge boundary remain present.

## Historical context

This is a correction to the deployment and skill proposals in `private_notes/groups.md` and
`private_notes/ADDITIONS_1.md`, using the replacement contract in
`private_notes/app_store_upload.md`. It continues the production-parity reporting in
`private_notes/sandbox-handoff.md` and `docs/findings/0018-nothing-ever-deployed.md`.

The launch chain remains the one recorded in
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`. These references preserve why the contract
changed; they are not runtime inputs and are not copied into customer repositories.
