# 0058: A merged migration was already in the past

## What was wrong

Several launch features were developed as stacked pull requests with migrations named `10_18`,
`10_19`, and `10_20`. Custom-domain migrations `10_22` and `10_23` merged and ran first. When the
OAuth branch later merged, Kysely refused production migration before running any SQL:

> New migrations must always have a name that comes alphabetically after the last executed migration.

A fresh-database test passed because it had never recorded the later migrations first. Rebase order
in Git is not migration execution order in a database that has already deployed main.

## What stops it recurring

The three not-yet-applied stacked migrations are renumbered after the production high-water mark:
OAuth/credentials is `10_24`, grouped workflows is `10_25`, and launch docs/store metadata is
`10_26`. We keep Kysely's ordered-migration guard enabled; turning on unordered migrations would
hide the operational mistake instead of making the deployment sequence explicit.

The deployment itself was fail-safe: migration runs after the idle fleet is healthy and before
cutover, so the refusal left the previously deployed colour serving.
