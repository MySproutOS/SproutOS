# 0019. What a platform admin is, and how support sees a customer's account

- Status: Accepted
- Date: 2026-08-20

## Context

`user.is_admin` has existed since the first migration. It gates the admin SPA and one API route
whose description was copied from an unrelated template, and nothing anywhere said what it grants.
An unbounded privilege that nobody has written down is one whose scope is decided, quietly, by
whoever next needs something.

At the same time there is a real operational need it was never able to meet. Support questions
arrive as "this screen is broken for me" and bugs arrive as "only under this organization's data".
Answering either means seeing what the customer sees.

The three ways to do that:

1. **Read the database directly.** What actually happens when there is no supported path. It is
   unaudited, it is ad hoc, and it puts a `psql` session with write access next to production data.
2. **A god-mode read API** — admin routes that fetch any organization's projects, logs, and settings.
   This duplicates the entire product surface behind a second set of routes, each of which is a new
   place to get authorization wrong, and it still cannot reproduce a rendering bug.
3. **Impersonation** — become the user, in a session that records who is really behind it.

## Decision

**`is_admin` is a boolean, not a role system.** Platform administration is not a tenant's RBAC
problem: the population is a handful of people, and a second permission model to keep in step with
the first is how one of them drifts out of date.

**What it grants is exactly two things:**

- Reading across organizations on the platform surface — finding a user, seeing which organizations
  they belong to. Enough to answer "who is this and where do I look".
- Starting an **impersonated session**, which is how everything else is done.

**It grants no direct write into a customer's data.** There is no admin route that edits a project,
changes a plan, or rotates a credential. Every such change is made _as the customer_, through a
session that records who was behind it — which means it lands in the customer's own audit trail,
visible to them, rather than in a private admin log they cannot see.

### How impersonation works

A separate session is minted for the target user, carrying `session.impersonated_by_user_id`. Not a
flag on the admin's own session with a target passed per request: that puts the burden on every
route to remember, and the route that forgets is the one that writes an unattributed row. Minting a
session for the target makes the impersonated identity the _ordinary_ one — existing routes
authenticate it exactly as they authenticate anybody — and `auditContext()`, which every audited
route already spreads, picks up the impersonator without a single route changing.

Four constraints, each of which is load-bearing:

| Constraint                         | Why                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expires in **60 minutes**          | Support work is minutes. A session that outlives the investigation is a credential for somebody else's account sitting in a browser.                                                                          |
| **No sliding renewal**             | The renewal window is fifteen days, so without an explicit guard the _first request_ would extend a stranger's session to thirty days and the short expiry would be decorative.                               |
| **Cannot reach the admin surface** | Stops chaining — admin becomes user, becomes a third — which turns an audit trail that reads as a pair into one that must be reconstructed as a chain.                                                        |
| **Cannot target another admin**    | An admin's session is the one that reaches the platform surface. Impersonating one would borrow that reach while the trail named somebody else. Support never needs it; an admin with a problem can be asked. |

A **reason** is required to start one. A free-text field is not a control — nobody is stopped by
having to type something. It is a prompt: the moment where someone states what they are about to do
is the moment they notice they should not be doing it, and afterwards it is the difference between a
review that can be read and a list of timestamps.

The impersonated user **sees a banner**, from `GET /v1/user/me/impersonation`, and either party can
end the session from it.

Ending one returns the admin to their own account. That took a second cookie, and finding out why is
worth recording: there is one `session` cookie, so minting the impersonated one replaces it. The
admin's session _row_ is untouched and still valid — but the browser stops holding its token, so the
first version of this signed the admin out entirely, and the design note claiming otherwise was
simply wrong until the flow was driven in a browser. The admin's token is now stashed in
`impersonator_session` and handed back on end, verified against the admin the session records. A
support engineer who has to sign in again afterwards is one who leaves the _next_ impersonated
session open instead, and the sixty-minute expiry only helps if these sessions actually get closed.

### The audit trail

`audit_log.impersonator_user_id`, indexed partially since almost no row has one. Two rows bracket a
session:

- `admin:impersonate:start` — written with `actor_user_id = the admin`, because starting one is an
  act by the admin as themselves. Carries the target and the stated reason.
- `admin:impersonate:end` — written as the target, with the admin in `impersonator_user_id`, like
  everything in between.

"Everything done while impersonating this month" and "everything this admin did as somebody else"
are the two questions an incident review asks, and both are that one index.

## Consequences

- The customer's audit trail stays true. Without the column their own id would appear against
  actions they did not take, which turns the one table that exists to answer _who did this_ into a
  table that answers it wrongly.
- Support cannot silently change anything. Every action is in the customer's own trail, and the
  customer can read it.
- A platform admin who leaves cannot take the evidence with them: both new columns are
  `ON DELETE RESTRICT`, like every other reference to `user`.
- There is no admin write API to build, and no second authorization model to keep correct. That is
  the point — the surface that does not exist cannot be got wrong.
- **Not covered here:** an approval workflow for impersonation (a second admin signing off), and
  notifying the customer by email when their account is impersonated. Both are reasonable and both
  are policy decisions rather than missing mechanism; the audit trail is what either would build on.
