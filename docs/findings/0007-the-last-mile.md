# 0007 — The last mile

Found by using the features, one at a time, on the deployed platform: create a workflow, run it,
add a model credential, talk to the agent, send a second message.

Nine defects. Every one of them sat behind an earlier one, so each was only reachable after the
previous was fixed — which is the reason they had never been seen. There is no way to find the
eighth bug in a chain except by fixing the first seven.

---

## The chain

| #   | What happened                                               | Why it was invisible                                                             |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `driverFor` dispatched only `postgres`                      | `valkeyDriver` and `searchDriver` existed, tested, referenced by nothing         |
| 2   | Nothing could start a workflow run                          | `workflow_run` was read in five places, written in none                          |
| 3   | The executor wrote a status the CHECK constraint forbids    | Run stranded at `running`; the conditional claim made every retry a no-op        |
| 4   | A failed run said nothing about why                         | `workflow_run.error` written by the runner, dropped by the serializer            |
| 5   | Settings had no way to add a model credential               | The API and the generated client both had all three operations                   |
| 6   | Adding a credential did not select it                       | `agent_config.agent_credential_id` stayed null; the agent still said `no_config` |
| 7   | The agent refused a repo the caller had just forked         | Required an App installation; the caller's own `repo` token was right there      |
| 8   | `git` was not in the image the agent shells out to git from | And the pod had no writable filesystem to clone into                             |
| 9   | The SDK was bundled, so it could not find its native binary | The musl package was in the image the whole time                                 |
| 10  | Every session accepted exactly one message                  | `coalesce(max(seq), 0)` — right by accident for the first turn                   |
| 11  | The agent had a shell in the control-plane pod              | The shell failed on its own, because Alpine has no bash                          |

---

## Three that are worth reading properly

### `coalesce(max(seq), 0)`

`openTurn` derived a turn's sequence as the existing maximum. On an empty session that is 0 — right,
by accident, for the first turn. For the second it returns the maximum that already exists, collides
with `agent_turn_session_seq_key`, and 500s.

**Every agent session accepted exactly one message.** Nobody writes a test for that, because nobody
would design it. The fix is `max(seq) + 1`, which is NULL on an empty set and therefore gives 0 for
the first turn and n+1 for every one after.

The comment above it said the loser of a concurrent insert "retries". Nothing retried.

### The bundler externalised the app's dependencies and inlined its libraries'

`build.mjs` computed its external list from `apps/internal-api`'s own `dependencies`. A workspace
package is _bundled in_, so `@lib/agent`'s dependency on `@anthropic-ai/claude-agent-sdk` was
neither declared there nor externalised — esbuild inlined it, and an inlined SDK cannot find the
sibling package holding its native binary, because after bundling there is no sibling.

The error was `Native CLI binary for linux-x64 not found`: a message about the wrong libc, from a
bundler problem, three layers from its cause. The correct musl package was in the image throughout.

The rule was already written in that file — _"Real npm dependencies must stay external … they break
when moved."_ It was simply only applied to the direct ones. Making the walk transitive took the
external list from ten to sixteen, and the six that appeared included `pg` and
`@aws-sdk/client-kms`: the database driver and the client the envelope encryption runs on, both
being bundled, both exactly what that sentence warns about.

### The security boundary that was holding by accident

The agent turn runs in the `internal-api` pod. `agentSubprocessEnv` replaces the subprocess's
environment wholesale, which keeps the API's secrets out of `process.env` — genuine, deliberate
work, and not sufficient. The subprocess runs as the same uid, so `/proc/1/environ` returns the
parent's environment in full: `DATABASE_URL`, the AWS keys, the metering HMAC key. The
service-account token is a file on disk.

The agent had `Bash`.

It was not exploitable, and only because the image is Alpine and the tool could not find a POSIX
shell — the model reported `no suitable POSIX shell is available` and gave up. **An accident is not
a control.** Bash, BashOutput, KillShell, WebFetch and Task are now refused explicitly, until an
agent turn runs in the Kata sandbox ADR 0012 describes.

---

## And one I wrote myself

Six test files derived "unique" slugs from `uuid.slice(0, 8)`. A UUIDv7 opens with 48 bits of
millisecond timestamp, so two ids minted in the same millisecond share those eight characters
exactly. The suite failed about one run in three with
`duplicate key value violates unique constraint "organization_slug_live_key"` — from a value chosen
precisely because it was supposed to be unique.

Worth recording next to the rest, because it is the same shape as everything above: a thing that
reads as obviously correct, is correct most of the time, and is wrong in a way nothing reports.
