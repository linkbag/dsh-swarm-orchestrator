import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SwarmService } from '../service.js'

const taskItemSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    id: { type: 'string' as const, required: true as const, description: 'Short unique task id (kebab-case)' },
    subject: { type: 'string' as const, required: true as const, description: 'One-line task subject' },
    description: { type: 'string' as const, required: true as const, description: 'Full task brief for the task agent' },
    role: { type: 'string' as const, required: true as const, description: 'Duty-table role (architect | builder | reviewer | integrator, or a custom role)' },
    blockedBy: { type: 'array' as const, items: { type: 'string' as const }, description: 'Task ids that must complete before this one starts' },
    reviewBy: { type: 'string' as const, description: 'Role that reviews this task\'s output after completion (e.g. reviewer); rejections loop back with feedback up to reviewLoops times' },
  },
}

/** Register the three model-facing swarm tools into the global tools layer. */
export function registerSwarmTools(ctx: Context, service: SwarmService): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_dispatch',
    description:
      'Submit a swarm run: a task DAG executed by parallel role agents (models come from the swarm duty table; check the Swarm dashboard tab). '
      + 'Returns the run id; tasks dispatch once the run is endorsed (the human endorses on the dashboard, or pass endorse=true ONLY when the human already approved spawning).',
    parameters: {
      title: { type: 'string', required: true, description: 'Run title shown on the dashboard' },
      spec: { type: 'string', required: true, description: 'The overall objective handed to every task agent as context' },
      tasks: { type: 'array', required: true, items: taskItemSchema, description: 'Ordered task list; independent tasks run in parallel' },
      endorse: { type: 'boolean', description: 'Set true ONLY when the human has explicitly approved spawning this run' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const result = service.dispatch(
        {
          title: args.title,
          spec: args.spec,
          tasks: args.tasks.map((task) => ({
            id: task.id, subject: task.subject, description: task.description, role: task.role,
            ...(task.blockedBy !== undefined && task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
            ...(task.reviewBy !== undefined && task.reviewBy.length > 0 ? { reviewBy: task.reviewBy } : {}),
          })),
          ...(args.endorse === true ? { endorse: true } : {}),
        },
        exec.agent,
      )
      const status = result.status === 'running'
        ? 'endorsed — dispatching now'
        : 'awaiting human endorsement on the Swarm dashboard (or re-dispatch with endorse=true once approved)'
      return `Run ${result.runId} created with ${result.taskCount} tasks — ${status}. Track with swarm_status or the Swarm tab.`
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_status',
    description: 'Report the current swarm board: runs, task states, models in use, and the latest per-task notes.',
    parameters: {
      runId: { type: 'string', description: 'Limit the report to one run (omit for all recent runs)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: async (args) => service.statusText(args.runId),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_report',
    description:
      'Post an interim progress note from a swarm task agent to the dashboard (one line: what you are doing or just finished). '
      + 'Only the agent executing the tracked task may report; finish your turn to complete the task.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Your task id' },
      note: { type: 'string', required: true, description: 'One-line progress note' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw new Error('swarm_report is only available to swarm task agents')
      return service.report(String(exec.agent.id), args.taskId, args.note)
    },
  })))

  return () => disposers.forEach((dispose) => dispose())
}
