# The router dropped API Gateway v2 response cookies

**Found:** 2026-08-27, while testing username/password registration on the production Reddit clone.

## What was true

Registration completed, but the visitor was not logged in on the next request. The customer
function used the API Gateway HTTP API v2 response shape and returned its session cookies in the
top-level `cookies` array. That is the v2 representation for repeated `Set-Cookie` fields.

The router's request translator deliberately spoke v2, but its `Reply` type did not retain
`cookies`. Serde silently ignored the array, and `serve.rs` forwarded only the entries in
`headers`. The Lambda invocation therefore succeeded and the application could report a successful
registration while the browser received no session cookie. This was a router response-translation
failure, not CORS and not a mismatch between the customer web and API subdomains.

## What now stops it

`Reply` retains the v2 `cookies` array, and the response boundary appends one `Set-Cookie` field for
each value. It does not comma-fold them and does not replace a `Set-Cookie` supplied through
`headers`. A regression test carries two v2 cookies plus an existing header cookie through the
actual response builder and asserts that all three survive independently; another proves one
malformed cookie does not discard the response or its valid cookie.

Production acceptance still has to register through the deployed Reddit clone in Chrome and prove
the immediately following authenticated request succeeds. A successful Lambda invocation or a
successful registration JSON body is not that evidence.

This production check is part of the launch chain recorded in
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`. It also corrects the verification record in
`private_notes/groups.md` and `private_notes/sandbox-handoff.md`: a deployed customer application
was not proof that the router preserved the framework adapter's authentication response.
