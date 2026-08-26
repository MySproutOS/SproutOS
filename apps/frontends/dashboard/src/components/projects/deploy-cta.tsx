import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { getV1OrgsByOrgSlugAgentConfigOptions } from "@lib/api-client/generated/@tanstack/react-query.gen"
import { Alert, AlertDescription } from "@ui/base/ui/alert"
import { Button } from "@ui/base/ui/button"
import { SparklesIcon, WorkflowIcon } from "lucide-react"
import type { Deployment } from "@frontends/dashboard/data/deployments"
import type { ProjectDetail } from "@frontends/dashboard/data/projects"

/**
 * What to offer a project that is not serving anything.
 *
 * It said "Not deployed yet" — a sentence, with nothing to do about it. Worse, it said so for
 * *every* project including ones that were deployed, because the URL it branched on was hardcoded
 * to null.
 *
 * Two paths, and only one of them currently works end to end:
 *
 * - **Set up the deploy workflow.** Real, and the only complete path today. Nothing in the product
 *   has ever written the workflow file or shown it, so customers were expected to hand-write it
 *   with no instruction.
 * - **Deploy using AI.** Shown only when an AI credential resolves *and* the agent can actually
 *   deploy. It cannot yet: the turn runs in the control-plane pod, so `Bash` is refused, it holds
 *   no push credential and has no callback into this API. A button that opened a chat which
 *   described a deployment and performed none would be the most expensive kind of lie here.
 */

/**
 * Whether the agent can carry a deployment out, as opposed to talk about one.
 *
 * A constant rather than a check, because there is nothing to check yet — the capability is absent
 * by construction (ADR 0012's sandbox is not built). Named and referenced from one place so that
 * when the sandbox lands, this becomes a real signal instead of a grep.
 */
const AGENT_CAN_DEPLOY = false

export function DeployCta({
  orgSlug,
  project,
  failed,
}: {
  orgSlug: string
  project: ProjectDetail
  /** The most recent deployment, when there is one and it did not work. */
  failed?: Deployment
}) {
  /*
    The readiness check the platform already computes.

    `effectiveBilling` is resolved server-side — `byo`, `platform`, or `none` with a reason — so the
    UI never re-derives the precedence between an organization credential, a project credential and
    platform credits. Agent chat gates on exactly this call.
  */
  const config = useQuery(getV1OrgsByOrgSlugAgentConfigOptions({ path: { orgSlug } }))
  const hasAiKey =
    config.data?.effectiveBilling !== undefined && config.data.effectiveBilling !== "none"

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Not deployed yet</h2>
        <p className="max-w-prose text-[13px] text-muted-foreground">
          {failed === undefined
            ? "This project has never had a successful deployment."
            : "The last deployment did not succeed, so nothing is serving."}
        </p>
      </div>

      {/*
        The actual reason, not a generic failure.

        Every deployment in this account has failed with "No build artifact was uploaded for this
        release" — which means the workflow was never added, not that anything is broken. Showing
        the reason is the difference between a person adding a file and a person filing a bug.
      */}
      {failed?.failureReason === undefined || failed.failureReason === null ? null : (
        <Alert>
          <AlertDescription className="text-xs">{failed.failureReason}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          render={
            <Link
              to="/orgs/$orgSlug/projects/$projectId/deployments"
              params={{ orgSlug, projectId: project.id }}
            />
          }
        >
          <WorkflowIcon />
          Set up deploy workflow
        </Button>

        {AGENT_CAN_DEPLOY && hasAiKey ? (
          <Button
            variant="outline"
            size="sm"
            render={
              <Link
                to="/orgs/$orgSlug/projects/$projectId/agent"
                params={{ orgSlug, projectId: project.id }}
              />
            }
          >
            <SparklesIcon />
            Deploy using AI
          </Button>
        ) : null}
      </div>

      {/*
        Say which of the two reasons applies, rather than hiding the option silently.

        A person who has configured an AI key and sees no AI button will reasonably conclude the key
        did not work. Distinguishing "you have no key" from "the agent cannot do this yet" costs one
        sentence and saves them going to look.
      */}
      {AGENT_CAN_DEPLOY ? null : (
        <p className="text-[12px] text-muted-foreground">
          {hasAiKey
            ? "Deploying with the agent is not available yet — it runs without a shell or a push credential until its sandbox ships."
            : "No AI credential is configured for this organisation, so deploying with the agent is unavailable."}{" "}
          <Link
            to="/orgs/$orgSlug/settings/agent"
            params={{ orgSlug }}
            className="hover:text-leaf hover:underline"
          >
            Model credentials
          </Link>
        </p>
      )}
    </div>
  )
}
