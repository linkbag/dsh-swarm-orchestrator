import type { Context } from '@deepseek-ai/cordis'
import type { SwarmService } from './service.js'

/**
 * K5: the `/swarm <goal>` one-shot command. Typing it dispatches the AbbVie
 * pattern that worked in production: an architect writes the plan to
 * PLAN.md, then a builder executes the plan end-to-end. The command is an
 * explicit user action, so it endorses (unless the hard gate is on).
 */
export function registerSwarmCommand(ctx: Context, service: SwarmService): (() => void) | undefined {
  const commands = ctx.get('commands') as {
    register(definition: {
      name: string
      description: string
      handler(invocation: { agent: unknown; rawInput: string; signal: AbortSignal }): { kind: 'success'; text: string } | { kind: 'error'; text: string }
    }): () => void
  } | undefined
  if (commands === undefined) return undefined
  return commands.register({
    name: 'swarm',
    description: 'One-shot swarm: plan this goal (architect → PLAN.md), then execute the plan end-to-end (builder).',
    handler: (invocation) => {
      const goal = invocation.rawInput.trim()
      if (goal.length === 0) {
        return { kind: 'error', text: 'usage: /swarm <what to build — the swarm plans it, then executes it>' }
      }
      const title = goal.length > 60 ? goal.slice(0, 60) + '…' : goal
      const result = service.dispatch({
        title,
        spec: goal,
        endorse: true,
        tasks: [
          {
            id: 'plan',
            subject: 'Plan the goal',
            description: 'Decompose the goal into a concrete implementation plan and write it to PLAN.md in the workspace: phases, files each phase owns, verification steps, and the integration order. Plan only — write no product code.',
            role: 'architect',
          },
          {
            id: 'execute',
            subject: 'Execute the plan',
            description: 'Read PLAN.md in the workspace and execute it end-to-end: implement every phase, run the verifications PLAN.md names, fix what fails, and finish with a summary of what was built and how it was verified.',
            role: 'builder',
            blockedBy: ['plan'],
          },
        ],
      }, invocation.agent as never)
      return {
        kind: 'success',
        text: `Run ${result.runId} created with ${result.taskCount} tasks (${result.status}) — track with swarm_status or the Swarm tab.`,
      }
    },
  })
}
