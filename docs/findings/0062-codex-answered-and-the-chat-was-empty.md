# 0062: Codex answered and the chat was empty

## What was wrong

A real platform-funded Codex turn ran inside Daytona, reached the production LLM proxy, received a
model response, exited zero, and produced correctly attributed token events. The sandbox event
adapter nevertheless emitted no session and no text to the chat.

Current `codex exec --json` starts with `thread.started` and completes an answer as an
`item.completed` whose item is `{ type: "agent_message", text: "..." }`. The adapter recognized
`item.completed` but only read `item.content`; it also recognized only Claude's `system/init`
session shape. It therefore turned a valid response into a successful empty turn. Codex's normal
`Reading additional input from stdin...` notice was simultaneously forwarded as an error, making
the successful empty turn look like a failure.

## Why the existing checks passed

The parser tests used Claude's `message.content` shape for both harnesses. They proved that chunked
JSON was reassembled and that the shared event vocabulary worked for that fixture, but never fed
the adapter an event emitted by the Codex binary in the Daytona snapshot. The proxy and metering
tests were also green because the request really did complete; neither boundary can prove that the
answer survived the last translation into the browser's event stream.

## What stops it recurring

- `thread.started.thread_id` is translated into the existing session event.
- `item.completed` agent messages read their current `item.text` field while retaining the older
  content-shaped handling.
- The one known informational stdin line is ignored only for Codex; every other stderr diagnostic
  remains an error.
- The regression fixture is the exact four-event shape observed from the live Daytona turn and
  includes its stderr notice.
- The repaired adapter was rerun through Daytona and the production proxy: the same platform model
  marker appeared as chat text, a session was emitted, the terminal event was successful, and the
  disposable sandbox was absent from Daytona after cleanup.
