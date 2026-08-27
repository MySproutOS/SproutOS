# Daytona outlived the start request

## What was wrong

A stopped Daytona workspace could finish starting after the SDK's 60-second request timeout. The
provider then held a live, billable workspace while SproutOS marked its row `failed`. The dashboard
waited two minutes for `running`, reported a failure, and the next click unnecessarily ran the full
provision/bootstrap path against an already-complete checkout.

This was observed in the production Chrome acceptance run: Daytona reported `started` immediately
after the dashboard's two-minute error, and the preserved checkout worked on the next attempt.

## Why the checks missed it

The start job test made `driver.start()` either resolve or reject synchronously. It never modeled a
lost mutation response where the provider continues the operation. The Daytona driver deliberately
did not retry mutating calls, but it also did not reconcile them with an idempotent state read.

## What stops it coming back

The driver still never repeats `start`. If its response fails, it polls Daytona's actual state for a
bounded four minutes and accepts only `started` or `running`; otherwise it rethrows the original
error. The dashboard allows five minutes for that provider reconciliation. Tests cover both the
late-success and never-started cases.

## Launch-plan context

This closes the stop/resume uncertainty recorded in both legacy launch plans,
`read-the-readme-md-to-eventual-dusk.md` and `double-sorted-meteor.md`, and in the handoff/reporting
notes `private_notes/groups.md` and `private_notes/sandbox-handoff.md`. It was found by the real
Daytona and production-Chrome workflow those documents required, not by the earlier Docker stub.
