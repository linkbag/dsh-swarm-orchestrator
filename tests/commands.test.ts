// The `/swarm` grammar and its dispatch to the service. The command is a thin
// adapter over methods the board and the model tools already use, so these tests
// pin two things: the parsing is unambiguous, and every branch lands on the SAME
// service call the rest of the plugin makes (a command that drifted from the
// board would be a second source of truth for a human decision).
import { describe, expect, it } from 'vitest'
import { handleSwarmCommand, parseSwarmArgs, type SwarmCommandService } from '../src/command.js'

interface Calls {
  statusText: Array<string | undefined>
  endorse: string[]
  retry: Array<[string, string, string | undefined]>
  complete: Array<[string, string, string | undefined, string | undefined]>
  dispatch: unknown[]
}

function fakeService(overrides: Partial<SwarmCommandService> = {}): { service: SwarmCommandService; calls: Calls } {
  const calls: Calls = { statusText: [], endorse: [], retry: [], complete: [], dispatch: [] }
  const service: SwarmCommandService = {
    statusText: (runId) => { calls.statusText.push(runId); return runId === undefined ? 'no swarm runs yet' : `run ${runId}: 2 tasks, 1 blocked for a human` },
    endorse: (runId) => { calls.endorse.push(runId) },
    retryTask: (runId, taskId, actor) => { calls.retry.push([runId, taskId, actor]) },
    completeTaskExternally: (runId, taskId, actor, summary) => { calls.complete.push([runId, taskId, actor, summary]) },
    snapshot: () => ({ tasks: [{ id: 't-blocked', runId: 'run-abc' }] }),
    dispatch: (spec) => { calls.dispatch.push(spec); return { runId: 'run-new', taskCount: 2, status: 'running' } },
    ...overrides,
  }
  return { service, calls }
}

describe('/swarm parsing', () => {
  it('bare invocation is the status summary, not a usage error', () => {
    expect(parseSwarmArgs('')).toEqual({ kind: 'status' })
    expect(parseSwarmArgs('   ')).toEqual({ kind: 'status' })
  })

  it('reads the status subcommand with and without a run id', () => {
    expect(parseSwarmArgs('status')).toEqual({ kind: 'status' })
    expect(parseSwarmArgs('status run-abc')).toEqual({ kind: 'status', runId: 'run-abc' })
  })

  it('accepts a task id alone or a run id plus task id for retry/complete', () => {
    expect(parseSwarmArgs('retry t-1')).toEqual({ kind: 'retry', taskId: 't-1' })
    expect(parseSwarmArgs('retry run-a t-1')).toEqual({ kind: 'retry', runId: 'run-a', taskId: 't-1' })
    expect(parseSwarmArgs('complete t-1')).toEqual({ kind: 'complete', taskId: 't-1' })
    expect(parseSwarmArgs('complete t-1 fixed by hand')).toEqual({ kind: 'complete', taskId: 't-1', summary: 'fixed by hand' })
    expect(parseSwarmArgs('complete run-a t-1 accepted')).toEqual({ kind: 'complete', runId: 'run-a', taskId: 't-1', summary: 'accepted' })
  })

  it('keeps unrecognised text as a GOAL, so the one-shot behaviour is untouched', () => {
    expect(parseSwarmArgs('add dark mode')).toEqual({ kind: 'goal', goal: 'add dark mode' })
    expect(parseSwarmArgs('statuspage redesign')).toEqual({ kind: 'goal', goal: 'statuspage redesign' })
  })

  it('asks for syntax instead of guessing when a required id is missing', () => {
    expect(parseSwarmArgs('endorse').kind).toBe('usage')
    expect(parseSwarmArgs('retry').kind).toBe('usage')
    expect(parseSwarmArgs('complete').kind).toBe('usage')
    expect(parseSwarmArgs('help').kind).toBe('help')
  })
})

describe('/swarm dispatch', () => {
  it('reports status with no runs, and per-run when asked', () => {
    const { service, calls } = fakeService()
    expect(handleSwarmCommand(service, '').text).toBe('no swarm runs yet')
    expect(handleSwarmCommand(service, 'status run-abc').text).toContain('run-abc')
    expect(calls.statusText).toEqual([undefined, 'run-abc'])
  })

  it('endorses an exact run', () => {
    const { service, calls } = fakeService()
    const result = handleSwarmCommand(service, 'endorse run-abc')
    expect(result.kind).toBe('success')
    expect(calls.endorse).toEqual(['run-abc'])
  })

  it('resolves the run for a bare task id, and refuses an unknown one without calling through', () => {
    const { service, calls } = fakeService()
    expect(handleSwarmCommand(service, 'retry t-blocked').kind).toBe('success')
    expect(calls.retry).toEqual([['run-abc', 't-blocked', undefined]])

    const miss = handleSwarmCommand(service, 'retry t-nope')
    expect(miss.kind).toBe('error')
    expect(miss.text).toContain('unknown task')
    expect(calls.retry).toHaveLength(1)
  })

  it('completes a task — the option an evidence-blocked task needs — carrying the note', () => {
    const { service, calls } = fakeService()
    expect(handleSwarmCommand(service, 'complete t-blocked accepted by hand').kind).toBe('success')
    expect(calls.complete).toEqual([['run-abc', 't-blocked', undefined, 'accepted by hand']])
  })

  it('surfaces a gate refusal as guidance instead of bypassing it', () => {
    // completeTaskExternally is session-gated; the command must report that, not route around it.
    const { service } = fakeService({
      completeTaskExternally: () => { throw new Error('swarm_complete is gated to the dispatching session; use the Swarm dashboard instead.') },
    })
    const result = handleSwarmCommand(service, 'complete t-blocked')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('dispatching session')
  })

  it('still dispatches a goal, unchanged, and endorses it', () => {
    const { service, calls } = fakeService()
    const result = handleSwarmCommand(service, 'add dark mode')
    expect(result.text).toContain('run-new')
    const spec = calls.dispatch[0] as { endorse: boolean; tasks: Array<{ id: string; blockedBy?: string[] }> }
    expect(spec.endorse).toBe(true)
    expect(spec.tasks.map((t) => t.id)).toEqual(['plan', 'execute'])
    expect(spec.tasks[1]?.blockedBy).toEqual(['plan'])
  })

  it('never throws for malformed input or a failing service', () => {
    const { service } = fakeService({ statusText: () => { throw new Error('board unavailable') }, endorse: () => { throw new Error('unknown run "x"') } })
    expect(handleSwarmCommand(service, 'status').kind).toBe('error')
    expect(handleSwarmCommand(service, 'endorse x').text).toContain('unknown run')
    expect(handleSwarmCommand(service, 'endorse').kind).toBe('error')
  })
})
