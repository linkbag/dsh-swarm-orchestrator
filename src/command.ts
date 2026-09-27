import type { Context } from '@deepseek-ai/cordis'
import type { SwarmService } from './service.js'

/**
 * K5: the `/swarm` command. Two jobs on one grammar, decided by the first token:
 *
 * - `/swarm <goal>` dispatches the AbbVie pattern that worked in production: an
 *   architect writes PLAN.md, then a builder executes it. Unchanged behaviour.
 * - `/swarm status|endorse|retry|complete …` are the HUMAN DECISIONS a blocked run
 *   waits on. They reuse the exact service paths the model tools and the dashboard
 *   use - no business logic is duplicated here - so a typed command cannot drift
 *   from what the board does. It runs with the user's authority, which is the
 *   point; it also cannot bypass a guard, because every call lands on the same
 *   method that enforces it (see `complete`, which stays session-gated).
 *
 * A bare `/swarm` is the status summary: the old usage error was a dead end for the
 * most likely keystroke, and the summary is what a user needs when they type it.
 */

export type SwarmArgs =
  | { kind: 'status'; runId?: string }
  | { kind: 'endorse'; runId: string }
  | { kind: 'retry'; runId?: string; taskId: string }
  | { kind: 'complete'; runId?: string; taskId: string; summary?: string }
  | { kind: 'goal'; goal: string }
  | { kind: 'help' }
  | { kind: 'usage'; text: string }

export type SwarmCommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string }

const USAGE = [
  'usage:',
  '/swarm <goal>                     dispatch a plan→execute run for <goal>',
  '/swarm                            status: active runs, what waits on you, next actions',
  '/swarm status [runId]             one run in detail (default: the active one)',
  '/swarm endorse <runId>            endorse a run waiting at the gate',
  '/swarm retry <taskId>             requeue a failed/blocked task (or: retry <runId> <taskId>)',
  '/swarm complete <taskId> [note]   accept finished work despite an evidence artefact',
].join('\n')

/** Structural view of the service methods this command drives (keeps tests trivial). */
export interface SwarmCommandService {
  statusText(runId?: string): string
  endorse(runId: string): void
  retryTask(runId: string, taskId: string, actorSessionId?: string): void
  completeTaskExternally(runId: string, taskId: string, actorSessionId: string | undefined, summary?: string): void
  snapshot(): { tasks: ReadonlyArray<{ id: string; runId?: string }> }
  dispatch(spec: unknown, agent: unknown): { runId: string; taskCount: number; status: string }
}

/**
 * Parse only the grammar this command owns. Anything that is not a recognised
 * subcommand is a GOAL: `/swarm add dark mode` must keep dispatching, so the
 * parser never treats unknown text as an error.
 */
export function parseSwarmArgs(rawInput: string): SwarmArgs {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'status' }
  const tokens = input.split(/\s+/u)
  const head = (tokens[0] ?? '').toLowerCase()

  if (head === 'help' || head === '?') return { kind: 'help' }
  if (head === 'status') {
    const runId = tokens[1]
    return runId === undefined ? { kind: 'status' } : { kind: 'status', runId }
  }
  if (head === 'endorse') {
    const runId = tokens[1]
    if (runId === undefined) return { kind: 'usage', text: 'usage: /swarm endorse <runId>' }
    return { kind: 'endorse', runId }
  }
  if (head === 'retry') {
    const args = tokens.slice(1)
    if (args.length === 0) return { kind: 'usage', text: 'usage: /swarm retry <taskId>' }
    // One id is a task id (the run is resolved from the board); two are (runId, taskId).
    return args.length === 1
      ? { kind: 'retry', taskId: args[0]! }
      : { kind: 'retry', runId: args[0]!, taskId: args[1]! }
  }
  if (head === 'complete') {
    const args = tokens.slice(1)
    if (args.length === 0) return { kind: 'usage', text: 'usage: /swarm complete <taskId> [note]' }
    // `complete run-… <taskId> …` is (runId, taskId, note…); otherwise (taskId, note…).
    const twoIds = args.length >= 2 && /^run[-_]/iu.test(args[0]!) && /^[A-Za-z0-9._-]+$/u.test(args[1]!)
    if (twoIds) {
      const summary = args.slice(2).join(' ').trim()
      return summary.length === 0
        ? { kind: 'complete', runId: args[0]!, taskId: args[1]! }
        : { kind: 'complete', runId: args[0]!, taskId: args[1]!, summary }
    }
    const summary = args.slice(1).join(' ').trim()
    return summary.length === 0
      ? { kind: 'complete', taskId: args[0]! }
      : { kind: 'complete', taskId: args[0]!, summary }
  }
  return { kind: 'goal', goal: input }
}

/** Best-effort session id for the acting agent; `undefined` keeps the platform's own gate. */
function sessionIdOf(agent: unknown): string | undefined {
  const a = agent as { session?: { id?: unknown }; sessionId?: unknown; id?: unknown } | undefined
  const candidate = a?.session?.id ?? a?.sessionId ?? a?.id
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/** Resolve the run that owns a task id, so `retry <taskId>` works without it. */
function runIdOfTask(service: SwarmCommandService, taskId: string): string | undefined {
  return service.snapshot().tasks.find((t) => t.id === taskId)?.runId
}

export function handleSwarmCommand(service: SwarmCommandService, rawInput: string, agent?: unknown): SwarmCommandResult {
  let args: SwarmArgs
  try {
    args = parseSwarmArgs(rawInput)
  } catch (err) {
    return { kind: 'error', text: `could not read that command: ${String(err)}` }
  }
  if (args.kind === 'help') return { kind: 'success', text: USAGE }
  if (args.kind === 'usage') return { kind: 'error', text: args.text + '\n\n' + USAGE }

  try {
    switch (args.kind) {
      case 'status':
        return { kind: 'success', text: service.statusText(args.runId) }
      case 'endorse':
        service.endorse(args.runId)
        return { kind: 'success', text: `Run ${args.runId} endorsed — its first tasks are dispatching now.` }
      case 'retry': {
        const runId = args.runId ?? runIdOfTask(service, args.taskId)
        if (runId === undefined) return { kind: 'error', text: `unknown task "${args.taskId}" — check the Swarm board for the current task ids.` }
        service.retryTask(runId, args.taskId, sessionIdOf(agent))
        return { kind: 'success', text: `Task ${args.taskId} requeued in run ${runId}.` }
      }
      case 'complete': {
        const runId = args.runId ?? runIdOfTask(service, args.taskId)
        if (runId === undefined) return { kind: 'error', text: `unknown task "${args.taskId}" — check the Swarm board for the current task ids.` }
        service.completeTaskExternally(runId, args.taskId, sessionIdOf(agent), args.summary)
        return { kind: 'success', text: `Task ${args.taskId} accepted in run ${runId}.` }
      }
      case 'goal': {
        const goal = args.goal
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
        }, agent)
        return {
          kind: 'success',
          text: `Run ${result.runId} created with ${result.taskCount} tasks (${result.status}) — track with /swarm status or the Swarm tab.`,
        }
      }
    }
  } catch (err) {
    // Every failure is reported, never thrown at the composer: a gate refusal
    // (e.g. `complete` outside the dispatching session) must read as guidance.
    return { kind: 'error', text: String(err instanceof Error ? err.message : err) }
  }
}

export function registerSwarmCommand(ctx: Context, service: SwarmService): (() => void) | undefined {
  const commands = ctx.get('commands') as {
    register(definition: {
      name: string
      description: string
      input?: { hint: string }
      handler(invocation: { agent: unknown; rawInput: string; signal: AbortSignal }): SwarmCommandResult
    }): () => void
  } | undefined
  if (commands === undefined) return undefined
  const target = service as unknown as SwarmCommandService
  return commands.register({
    name: 'swarm',
    description: 'Swarm: <goal> dispatches a plan→execute run; status/endorse/retry/complete drive existing runs.',
    input: { hint: '[<goal>|status [runId]|endorse <runId>|retry <taskId>|complete <taskId>]' },
    handler: (invocation) => handleSwarmCommand(target, invocation.rawInput, invocation.agent),
  })
}
