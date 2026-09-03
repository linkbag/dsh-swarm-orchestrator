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
    reviewGate: { type: 'string' as const, description: '\'agent\' (default) or \'human\' — human routes the verdict to dashboard Approve/Reject buttons' },
    writes: { type: 'array' as const, items: { type: 'string' as const }, description: 'Files this task may write (exclusive scope). Overlapping concurrent scopes produce a dispatch warning.' },
    model: {
      type: 'object' as const,
      additionalProperties: true,
      description: 'Per-task model override (wins over the role pin): { provider, model }',
      properties: {
        provider: { type: 'string' as const, required: true as const },
        model: { type: 'string' as const, required: true as const },
      },
    },
    evidence: {
      type: 'object' as const,
      additionalProperties: true,
      description: 'Evidence contract: the task will not close until these hold. { files: [paths], commands: [shell commands] }',
      properties: {
        files: { type: 'array' as const, items: { type: 'string' as const }, description: 'Files (relative to the workspace) that must exist and be non-empty' },
        commands: { type: 'array' as const, items: { type: 'string' as const }, description: 'Shell commands that must exit 0' },
      },
    },
  },
}

/** The tool registry surface this module uses; mirrors WebServerLike in routes.ts. */
interface ToolsLike {
  register(definition: unknown): () => void
}

/**
 * Register the three model-facing swarm tools into the global tools layer.
 *
 * Resolves the registry with ctx.get('tools') rather than the ctx.tools
 * property: this plugin declares no `inject` for its optional services, and
 * cordis throws "cannot get property ... without inject" on property access
 * alone. ctx.get() is the un-guarded lookup, same as registerSwarmRoutes does
 * for webServer.
 */
export function registerSwarmTools(ctx: Context, service: SwarmService): () => void {
  const tools = ctx.get('tools') as unknown as ToolsLike | undefined
  if (tools === undefined) return () => {}
  const disposers: Array<() => void> = []

  disposers.push(tools.register(defineTool({
    name: 'swarm_dispatch',
    description:
      'Submit a swarm run: a task DAG executed by parallel role agents (models come from the swarm duty table; check the Swarm dashboard tab). '
      + 'Use ONLY when the human explicitly asks for a swarm / multi-agent run — never as a default way to work a task. '
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
            ...(task.reviewGate === 'human' ? { reviewGate: 'human' as const } : {}),
            ...(task.writes !== undefined && task.writes.length > 0 ? { writes: task.writes } : {}),
            ...(task.model !== undefined && typeof task.model === 'object'
              && typeof (task.model as { provider?: unknown }).provider === 'string'
              && typeof (task.model as { model?: unknown }).model === 'string'
              ? { model: { provider: (task.model as { provider: string }).provider, model: (task.model as { model: string }).model } }
              : {}),
            ...(task.evidence !== undefined && typeof task.evidence === 'object'
              ? {
                  evidence: {
                    ...(Array.isArray((task.evidence as { files?: unknown }).files)
                      ? { files: (task.evidence as { files: string[] }).files.filter((f) => typeof f === 'string') }
                      : {}),
                    ...(Array.isArray((task.evidence as { commands?: unknown }).commands)
                      ? { commands: (task.evidence as { commands: string[] }).commands.filter((c) => typeof c === 'string') }
                      : {}),
                  },
                }
              : {}),
          })),
          ...(args.endorse === true ? { endorse: true } : {}),
        },
        exec.agent,
      )
      const status = result.status === 'running'
        ? 'endorsed — dispatching now'
        : 'awaiting human endorsement on the Swarm dashboard'
      return `Run ${result.runId} created with ${result.taskCount} tasks — ${status}. Track with swarm_status or the Swarm tab.`
    },
  })))

  disposers.push(tools.register(defineTool({
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

  disposers.push(tools.register(defineTool({
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

  disposers.push(tools.register(defineTool({
    name: 'swarm_retry',
    description:
      'Requeue a failed or blocked swarm task for another attempt (recovery after a fix). '
      + 'Gated to the run\'s dispatching session; other sessions must use the Swarm dashboard.',
    parameters: {
      runId: { type: 'string', required: true, description: 'The run id' },
      taskId: { type: 'string', required: true, description: 'The failed/blocked task id to requeue' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      service.retryTask(args.runId, args.taskId, exec.agent === undefined ? undefined : String(exec.agent.id))
      return `Task ${args.taskId} requeued — the dispatcher will relaunch it when its blockers allow. Track with swarm_status.`
    },
  })))

  disposers.push(tools.register(defineTool({
    name: 'swarm_wait',
    description:
      'Block until the swarm board changes (task completed/failed, run state change) or the timeout expires — '
      + 'use this instead of sleep-polling when supervising a swarm run. Returns the board text at the moment of the change.',
    parameters: {
      runId: { type: 'string', description: 'Only wait for changes in this run (omit for any swarm activity)' },
      timeoutSeconds: { type: 'number', description: 'Max seconds to wait (default 240, max 600)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const timeoutSeconds = Math.min(Math.max(args.timeoutSeconds ?? 240, 5), 600)
      return service.waitForChange(args.runId, timeoutSeconds * 1000, exec.signal)
    },
  })))

  return () => disposers.forEach((dispose) => dispose())
}
