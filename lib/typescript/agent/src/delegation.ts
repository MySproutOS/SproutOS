/**
 * The delegation contract shared by both sandbox harnesses.
 *
 * Keep provider model names out of these definitions. A platform-credit turn already selects
 * Terra at the parent, while a BYO turn selects the customer's configured model and provider.
 * Children inherit that choice; naming a platform model here would silently send BYO work through
 * a model the customer did not choose.
 */
export const MAX_CONCURRENT_CHILD_AGENTS = 2
export const MAX_CHILD_AGENT_DEPTH = 2

const SMALL_TURN_BUDGET = 8
const LARGE_TURN_BUDGET = 24

export const DELEGATION_POLICY = `## Delegating work

You may delegate independent subtasks to child agents. Run at most two children concurrently and
nest delegation no more than two layers below the main agent. Use the \`small\` role for bounded
lookups, focused tests, and simple edits; use the \`large\` role for ambiguous or multi-file work
that needs deeper reasoning. Children use the same provider and model as their parent.

Delegate only work that can proceed independently, and do not have two agents edit the same files.
Wait for every child you start, inspect its result, integrate it deliberately, and run the relevant
tests yourself. The parent agent owns the final answer and the correctness of all delegated work.`

const SMALL_INSTRUCTIONS = `Handle one narrow, well-defined subtask. Prefer targeted reads and the
smallest useful change. Return concise evidence and name every file you changed. Do not broaden the
task. Your parent owns integration and final verification.`

const LARGE_INSTRUCTIONS = `Own one complex, independently useful subtask. Trace the real control
flow, make a coherent change when asked, and verify it proportionately. Return concrete evidence,
remaining risks, and every file you changed. Your parent owns integration and final verification.`

/** Session-scoped Claude definitions. `inherit` is load-bearing for customer BYO credentials. */
export function claudeDelegationAgents(supportsRoleEffort: boolean): string {
  return JSON.stringify({
    small: {
      description: "Bounded lookups, focused tests, and simple edits that can finish quickly.",
      ...(supportsRoleEffort ? { effort: "low" } : {}),
      maxTurns: SMALL_TURN_BUDGET,
      model: "inherit",
      prompt: SMALL_INSTRUCTIONS,
    },
    large: {
      description: "Ambiguous or multi-file work that needs deeper reasoning and validation.",
      ...(supportsRoleEffort ? { effort: "high" } : {}),
      maxTurns: LARGE_TURN_BUDGET,
      model: "inherit",
      prompt: LARGE_INSTRUCTIONS,
    },
  })
}

/**
 * Platform-owned Codex roles, written below `$CODEX_HOME/agents` during bootstrap.
 *
 * Codex supports a role-specific effort but has no documented role-specific turn limit. The
 * instructions therefore keep each role bounded, while the harness enforces the supported global
 * concurrency limit. Omitting `model` preserves both platform Terra and every BYO model.
 */
export function codexDelegationRoles(
  supportsRoleEffort: boolean,
): Record<"small" | "large", string> {
  const smallEffort = supportsRoleEffort ? 'model_reasoning_effort = "low"\n' : ""
  const largeEffort = supportsRoleEffort ? 'model_reasoning_effort = "high"\n' : ""

  return {
    small: `name = "small"
description = "Bounded lookups, focused tests, and simple edits that can finish quickly."
${smallEffort}developer_instructions = """
${SMALL_INSTRUCTIONS}
"""
`,
    large: `name = "large"
description = "Ambiguous or multi-file work that needs deeper reasoning and validation."
${largeEffort}developer_instructions = """
${LARGE_INSTRUCTIONS}
"""
`,
  }
}
