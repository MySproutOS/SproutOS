/**
 * The pod labels a usage sample is attributed by.
 *
 * ## Why this exists
 *
 * `services/metering-agent` reads two labels off every pod on its node and bills whoever they name.
 * It read `sproutos.dev/organization-id`. The control plane wrote `sproutos.dev/project` onto a
 * Knative revision, and nothing at all onto a workflow sandbox or a dev sandbox.
 *
 * So `attribution_from_labels` returned nothing for every pod on every node. The agent kept
 * working perfectly: it discovered pods, read `cpu.stat` and `memory.current`, computed deltas,
 * signed batches and delivered them — `{"message":"delivered","count":60}` in its own logs — and
 * every one of those samples was attributed to nobody. `usage_event` stayed empty. Every customer
 * workload the platform has ever run was free.
 *
 * There is no error state for billing nothing. A pod is Running, a sample is a valid sample, and a
 * batch of unattributed events is a well-formed batch. The only signal was an empty table, which
 * reads exactly like a quiet week.
 *
 * ## The contract
 *
 * `lib/rust/metering-proto/fixtures/attribution-labels.json` holds the key names and the cases.
 * Both languages assert against it — the same discipline as the signing vectors beside it and the
 * SRN grammar, and for a plainer reason: these two strings are how work becomes money.
 *
 * ## Using it
 *
 * Every workload the platform creates on a tenant's behalf spreads `attributionLabels()` into its
 * pod template. A pod that does not carry them is a pod nobody is charged for, so the rule is that
 * anything creating a pod for a customer calls this — Knative revisions, workflow sandbox Jobs, dev
 * sandbox pods, and whatever comes next.
 */

/** The label naming the organization that pays for this pod. */
export const ORGANIZATION_ID_LABEL = "sproutos.dev/organization-id"

/**
 * The label naming the project, when there is one.
 *
 * Optional on purpose: a standalone backend service belongs to an organization and to no project,
 * and TASK 37 says that is a supported shape. The agent treats a missing project as a
 * project-less sample rather than as an unattributable one.
 */
export const PROJECT_ID_LABEL = "sproutos.dev/project-id"

/**
 * Labels for a workload run on behalf of an organization, and optionally a project.
 *
 * A label value must be a valid Kubernetes label value, which a UUID is. No validation here: the
 * caller has these ids out of the database, and a check that cannot fail is a check that teaches
 * the next reader the values are doubtful.
 */
export function attributionLabels(
  organizationId: string,
  projectId?: string,
): Record<string, string> {
  return {
    [ORGANIZATION_ID_LABEL]: organizationId,
    ...(projectId === undefined ? {} : { [PROJECT_ID_LABEL]: projectId }),
  }
}
