import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  ArrowLeftIcon,
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  MessageSquarePlusIcon,
  SendIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/base/ui/dialog"
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
import { SandboxPreviewPanel } from "@frontends/dashboard/components/sandbox/preview-panel"
import {
  type AgentEvent,
  ensureSandboxRunning,
  latestRestorableAgentSession,
  loadAgentTranscript,
  streamAgentTurn,
  useAgentSandbox,
  useAgentSessions,
  useCreateAgentSession,
  useFinishSandbox,
} from "@frontends/dashboard/data/agent-chat"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/agent")({
  validateSearch: (search: Record<string, unknown>): { session?: string; prompt?: string } => ({
    ...(typeof search.session === "string" ? { session: search.session } : {}),
    ...(typeof search.prompt === "string" ? { prompt: search.prompt } : {}),
  }),
  component: AgentChatRoute,
})

function AgentChatRoute() {
  return <AgentChat />
}

/** What the transcript is made of. Tool calls are collapsed into one line each. */
type Bubble =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "platform"; message: string; hostname: string | null }
  | { kind: "failed"; message: string }

function AgentChat() {
  const { orgSlug, projectId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const sessions = useAgentSessions(orgSlug, projectId)
  const sandbox = useAgentSandbox(orgSlug, projectId)
  const { createSession } = useCreateAgentSession(orgSlug, projectId)
  const finishSandbox = useFinishSandbox(orgSlug, projectId)

  const [sessionId, setSessionId] = useState<string | null>(search.session ?? null)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [prompt, setPrompt] = useState(search.prompt ?? "")
  const [running, setRunning] = useState(false)
  const [confirmingFinish, setConfirmingFinish] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const sessionIdRef = useRef<string | null>(search.session ?? null)
  const adoptedExistingSession = useRef(search.session !== undefined)
  const routeScope = useRef(`${orgSlug}/${projectId}`)
  const tail = useRef<HTMLDivElement>(null)

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  useEffect(() => () => abort.current?.abort(), [])

  /*
    A session belongs in the URL so reload, Back, and Forward restore the same conversation. Do
    not key the component by that URL value: the first send creates the session and then updates
    the URL, and remounting at that point aborts the stream that is still writing the first turn.

    `selectSession` updates the ref before navigation, so its own URL update is a no-op here. A
    browser-history change has a different value and restores the selected durable transcript.
  */
  useEffect(() => {
    const nextSessionId = search.session ?? null
    if (sessionIdRef.current === nextSessionId) return
    sessionIdRef.current = nextSessionId
    setSessionId(nextSessionId)
    setBubbles([])
  }, [search.session])

  useEffect(() => {
    const nextScope = `${orgSlug}/${projectId}`
    if (routeScope.current === nextScope) return
    routeScope.current = nextScope
    adoptedExistingSession.current = false
    sessionIdRef.current = null
    setSessionId(null)
    setBubbles([])
  }, [orgSlug, projectId])

  /*
    Route navigation unmounts this component, so bubbles cannot be the source of conversation
    identity. Adopt the newest durable session once per mount. `New chat` flips the same guard by
    leaving it true, so the sessions query cannot immediately undo the user's choice.
  */
  useEffect(() => {
    if (sessions.isPending || adoptedExistingSession.current) return
    adoptedExistingSession.current = true
    const latest = latestRestorableAgentSession(sessions.data)
    if (latest === undefined) return
    void navigate({
      to: "/orgs/$orgSlug/projects/$projectId/agent",
      params: { orgSlug, projectId },
      search: { session: latest.id },
      replace: true,
    })
  }, [navigate, orgSlug, projectId, sessions.data, sessions.isPending])

  useEffect(() => {
    if (sessionId === null) return
    let cancelled = false
    const refresh = async () => {
      if (abort.current !== null) return
      try {
        const transcript = await loadAgentTranscript({ orgSlug, projectId, sessionId })
        if (cancelled) return
        const restored: Bubble[] = []
        for (const turn of transcript.turns) {
          if (turn.role === "user" && turn.inputText !== null) {
            restored.push({ kind: "you", text: turn.inputText })
          }
          for (const event of transcript.events.filter((event) => event.agentTurnId === turn.id)) {
            appendInPlace(restored, event.payload)
          }
          if (turn.error !== null) restored.push({ kind: "failed", message: turn.error })
        }
        setBubbles(restored)
        setRunning(transcript.session.status === "active")
      } catch {
        if (!cancelled)
          setBubbles([{ kind: "failed", message: "The conversation could not be loaded" }])
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [orgSlug, projectId, sessionId])

  function selectSession(id: string | null) {
    sessionIdRef.current = id
    setSessionId(id)
    setBubbles([])
    void navigate({
      to: "/orgs/$orgSlug/projects/$projectId/agent",
      params: { orgSlug, projectId },
      search: id === null ? {} : { session: id },
      replace: false,
    })
  }

  const send = async () => {
    const text = prompt.trim()
    if (text === "" || running) return

    setRunning(true)
    setPrompt("")
    setBubbles((prior) => [...prior, { kind: "you", text }])

    const controller = new AbortController()
    abort.current = controller

    try {
      await ensureSandboxRunning({ orgSlug, projectId }, controller.signal)
      await sandbox.refetch()
      const id = sessionId ?? (await createSession())
      selectSession(id)

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
          disabled={running || sessionId === null}
          onClick={() => {
            selectSession(null)
          }}
        >
          <MessageSquarePlusIcon />
          New chat
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={running || finishSandbox.isPending || sandbox.data === undefined}
          onClick={() => {
            setFinishError(null)
            setConfirmingFinish(true)
          }}
        >
          <Trash2Icon />
          Done
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

        <div className="grid min-h-[32rem] gap-4 xl:grid-cols-[13rem_minmax(0,1fr)_minmax(22rem,0.9fr)]">
          <aside className="flex flex-col gap-2 border-r border-border pr-3">
            <span className="eyebrow">History</span>
            {(sessions.data ?? []).map((session) => (
              <Button
                key={session.id}
                variant={session.id === sessionId ? "secondary" : "ghost"}
                size="sm"
                className="h-auto justify-start py-2 text-left"
                onClick={() => {
                  selectSession(session.id)
                }}
              >
                <span className="min-w-0 truncate">{session.title ?? "New chat"}</span>
              </Button>
            ))}
          </aside>
          <div className="flex min-w-0 flex-col gap-3">
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
                  files, and anything it changes is pushed to a new `sproutos/agent-…` branch —
                  never to your production branch.
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
          <div className="hidden min-w-0 xl:block">
            <SandboxPreviewPanel orgSlug={orgSlug} projectId={projectId} />
          </div>
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

      <Dialog open={confirmingFinish} onOpenChange={setConfirmingFinish}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this agent workspace?</DialogTitle>
            <DialogDescription>
              Use this when you are completely done. SproutOS will delete the Daytona sandbox and
              its temporary database branch. Changes already pushed to GitHub are kept.
            </DialogDescription>
          </DialogHeader>

          {finishError === null ? null : (
            <p className="mt-3 text-xs text-destructive">{finishError}</p>
          )}

          <DialogFooter className="mt-6">
            <DialogClose render={<Button variant="outline">Keep working</Button>} />
            <Button
              variant="destructive"
              disabled={finishSandbox.isPending}
              onClick={() => {
                setFinishError(null)
                void finishSandbox
                  .finish()
                  .then(() => {
                    setConfirmingFinish(false)
                    selectSession(null)
                  })
                  .catch((cause: unknown) => {
                    setFinishError(
                      cause instanceof Error
                        ? cause.message
                        : "The workspace could not be deleted.",
                    )
                  })
              }}
            >
              {finishSandbox.isPending ? "Deleting…" : "Delete workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    case "platform_action":
      return [
        ...bubbles,
        { kind: "platform", message: event.message, hostname: event.primaryHostname },
      ]
    default:
      // tool_result, thinking, session, done — state the transcript does not show.
      return bubbles
  }
}

function appendInPlace(bubbles: Bubble[], event: AgentEvent): void {
  const next = append(bubbles, event)
  bubbles.splice(0, bubbles.length, ...next)
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

  if (bubble.kind === "platform") {
    return (
      <div className="flex items-start gap-2 self-start rounded-lg border border-primary/35 bg-primary/8 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
        <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          {bubble.message}
          {bubble.hostname === null ? null : (
            <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
              {bubble.hostname}
            </span>
          )}
        </span>
      </div>
    )
  }

  return (
    <div className="self-start rounded-lg rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
      {bubble.text}
    </div>
  )
}
