# A deployed CloudFront function rejected valid modern JavaScript

**Found:** 2026-08-27, by loading the first production static deployment in Chrome.

## What was true

The first static release completed every control-plane step: GitHub OIDC authenticated, the action
uploaded a content-addressed archive, the publisher expanded it into S3, the CloudFront key-value
store held the hostname pointer, DNS existed, and the deployment row became `ready`. The hostname
still returned CloudFront's 503 page.

Testing the deployed function with `aws cloudfront test-function` named the actual failure:

```text
SyntaxError: Token "{" not supported in this version in 16
```

Line 16 used optional catch binding (`catch {}`). That syntax is valid in the repository's normal
JavaScript toolchain, but CloudFront Functions' `cloudfront-js-2.0` runtime rejected it at execution
time. Terraform accepted and deployed the source, and CloudFront reported the function as
`DEPLOYED`; neither state meant it could run.

## What now stops it

The handler uses an explicit catch binding (`catch (_error)`), which the edge runtime accepts. The
production acceptance must keep both checks: test the live function with a representative event,
then load the real tenant hostname in Chrome. A successful OpenTofu apply, a `DEPLOYED` function,
or a `ready` release row is not evidence that the viewer-request function executed.

This was found while completing Phase 9 of
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`. The surrounding launch audit
remains `/Users/andrew/.claude/plans/double-sorted-meteor.md`, `private_notes/groups.md`, and
`private_notes/sandbox-handoff.md`; this finding records the production-only failure those plans
required us to look for rather than replacing their reporting.
