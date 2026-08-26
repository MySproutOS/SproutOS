import { Link, createFileRoute } from "@tanstack/react-router"
import {
  ArrowLeftIcon,
  BotIcon,
  CircleAlertIcon,
  MessageSquarePlusIcon,
  SendIcon,
  WrenchIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { Spinner } from "@ui/base/ui/spinner"
import { Textarea } from "@ui/base/ui/textarea"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import {
  type AgentEvent,
  streamAgentTurn,
  useAgentSessions,
  useCreateAgentSession,
} from "@frontends/dashboard/data/agent-chat"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/agent")({
  component: AgentChat,
})

/** What the transcript is made of. Tool calls are collapsed into one line each. */
type Bubble =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "failed"; message: string }

function AgentChat() {
  const { orgSlug, projectId } = Route.useParams()
  const sessions = useAgentSessions(orgSlug, projectId)
  const { createSession } = useCreateAgentSession(orgSlug, projectId)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [prompt, setPrompt] = useState("")
  const [running, setRunning] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const tail = useRef<HTMLDivElement>(null)

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  // A run outlives a keystroke but not the page. Leaving one streaming into an unmounted
  // component would keep burning tokens against a balance nobody is watching.
  useEffect(() => () => abort.current?.abort(), [])

  const send = async () => {
    const text = prompt.trim()
    if (text === "" || running) return

    setRunning(true)
    setPrompt("")
    setBubbles((prior) => [...prior, { kind: "you", text }])

    const controller = new AbortController()
    abort.current = controller

    try {
      const id = sessionId ?? (await createSession())
      setSessionId(id)

      await streamAgentTurn(
        { orgSlug, projectId, sessionId: id, prompt: text },
        (event) => {
          setBubbles((prior) => append(prior, event))
        },
        controller.signal,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "The agent could not start"
      setBubbles((prior) => [...prior, { kind: "failed", message }])
    } finally {
      setRunning(false)
      abort.current = null
      tail.current?.scrollIntoView({ behavior: "smooth" })
    }
  }

  return (
    <>
      <PageHeader title="Agent">
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/orgs/$orgSlug/projects/$projectId" params={{ orgSlug, projectId }} />}
        >
          <ArrowLeftIcon />
          Project
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={running || bubbles.length === 0}
          onClick={() => {
            setSessionId(null)
            setBubbles([])
          }}
        >
          <MessageSquarePlusIcon />
          New chat
        </Button>
      </PageHeader>

      <PageBody>
        {sessions.isError && (
          <ListError
            title="Could not load past sessions"
            onRetry={() => {
              void sessions.refetch()
            }}
          />
        )}
        {sessions.isPending && <ListSkeleton rows={1} />}

        <div className="flex flex-col gap-3">
          {bubbles.length === 0 && !running && (
            <EmptyState>
              <EmptyStateIcon>
                <BotIcon />
              </EmptyStateIcon>
              <EmptyStateTitle>Describe the change you want</EmptyStateTitle>
              <EmptyStateDescription>
                {/*
                  Says what actually happens now.

                  It read "leaves as a pull request — nothing is pushed to your branch", which was
                  true of a commit path that did not exist: the agent's edits died with the
                  temporary checkout. They are pushed to a `sproutos/agent-…` branch, and your own
                  branch is still untouched — which is the part that mattered and is worth keeping
                  accurate rather than reassuring.
                */}
                The agent works in a checkout of this project's repository. It reads and edits
                files, and anything it changes is pushed to a new `sproutos/agent-…` branch — never
                to your production branch.
              </EmptyStateDescription>
            </EmptyState>
          )}

          {bubbles.map((bubble, index) => (
            // Bubbles are append-only and never reordered, so the index is a stable identity —
            // there is no id on a streamed text fragment to key on instead.
            // oxlint-disable-next-line no-array-index-key
            <BubbleView key={index} bubble={bubble} />
          ))}

          {running && (
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" />
              Working…
            </span>
          )}
          <div ref={tail} />
        </div>

        <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-background pt-3">
          <Textarea
            rows={3}
            className="resize-none"
            placeholder="Add a shopping list that groups everything by supermarket aisle."
            value={prompt}
            disabled={running}
            onChange={(event) => {
              setPrompt(event.target.value)
            }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line. A prompt is usually one sentence, and
              // reaching for the mouse to send it is the wrong default.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">
              Enter to send, Shift+Enter for a new line.
            </span>
            <Button
              size="sm"
              disabled={running || prompt.trim() === ""}
              onClick={() => {
                void send()
              }}
            >
              <SendIcon />
              Send
            </Button>
          </div>
        </div>
      </PageBody>
    </>
  )
}

/**
 * Fold one event into the transcript.
 *
 * Consecutive text events are merged into the bubble they are extending, because the agent emits
 * a block at a time and a bubble per block would shred a paragraph into a column of fragments.
 */
function append(bubbles: Bubble[], event: AgentEvent): Bubble[] {
  switch (event.type) {
    case "text": {
      const last = bubbles.at(-1)
      if (last?.kind === "agent") {
        return [...bubbles.slice(0, -1), { kind: "agent", text: last.text + event.text }]
      }
      return [...bubbles, { kind: "agent", text: event.text }]
    }
    case "tool_use":
      return [...bubbles, { kind: "tool", name: event.name }]
    case "error":
      return [...bubbles, { kind: "failed", message: event.message }]
    default:
      // tool_result, thinking, session, done — state the transcript does not show.
      return bubbles
  }
}

function BubbleView({ bubble }: { bubble: Bubble }) {
  if (bubble.kind === "you") {
    return (
      <div className="self-end rounded-lg rounded-br-sm border border-primary/35 bg-primary/8 px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
        {bubble.text}
      </div>
    )
  }

  if (bubble.kind === "tool") {
    return (
      <Badge variant="muted" className="self-start gap-1.5 font-mono text-[11px]">
        <WrenchIcon className="size-3" />
        {bubble.name}
      </Badge>
    )
  }

  if (bubble.kind === "failed") {
    return (
      <div className="flex items-start gap-2 self-start rounded-lg border border-destructive/40 bg-destructive/8 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        {bubble.message}
      </div>
    )
  }

  return (
    <div className="self-start rounded-lg rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
      {bubble.text}
    </div>
  )
}
