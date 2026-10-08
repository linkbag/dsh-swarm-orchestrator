import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RoleConfig, Run, Task } from '../src/domain/types.js'
import { buildTaskPrompt, spawnTaskAgent, taskReportRelPath, type SpawnDeps } from '../src/dispatch/spawn.js'
import { checkEffortSupport, parseEffortSupportFromEntries } from '../src/preflight.js'

const role: RoleConfig = { id: 'builder', label: 'Builder', description: 'Build the scoped task', provider: 'alpha', model: 'shared', reasoningEffort: 'max', fallbacks: [] }
const run: Run = { id: 'run-a', title: 'Scoped work', spec: 'Implement the brief', status: 'running', createdAt: 1, updatedAt: 1, taskIds: ['build'] }
const task: Task = { id: 'build', runId: run.id, subject: 'Build', description: 'Implement', role: 'builder', status: 'running', attempts: 1, reviews: 0, updatedAt: 1, attemptProtocol: 2, attemptId: 'attempt-a' }
const parent = { id: 'parent' } as Agent
const success = { output: [{ type: 'text', text: 'Verified scoped result' }], stopReason: 'completed' }
const refused = { output: [], stopReason: 'error', diagnostic: 'UNSUPPORTED_REASONING_EFFORT' }
const defaults = () => ({ parent, run, task, role, signal: new AbortController().signal, candidates: [{ provider: 'alpha', model: 'shared' }] })

function providerSupport() {
  return parseEffortSupportFromEntries([
    { ns: 'llm-pi-ai', value: { providers: {
      alpha: { models: [{ id: 'shared', name: 'Shared', reasoningEfforts: { high: 'high' } }] },
      beta: { models: [{ id: 'shared', name: 'Shared', reasoningEfforts: { low: 'low' } }] },
    } } },
    { ns: 'agent-default-model', value: { provider: 'alpha', model: 'shared', reasoningEffort: 'max' } },
  ])
}

describe('provider-qualified effort and bounded spawn ownership', () => {
  it('never uses another provider declaration or default proof for an equal model id', () => {
    const support = providerSupport()
    expect(checkEffortSupport('shared', 'max', support, 'alpha').incompatible).toBe(false)
    expect(checkEffortSupport('shared', 'max', support, 'beta').incompatible).toBe(true)
    expect(checkEffortSupport('shared', 'low', support, 'beta').incompatible).toBe(false)
    expect(checkEffortSupport('shared', 'high', support, 'beta').incompatible).toBe(true)
    // An unknown provider must not inherit a bare-id exclusion map.
    expect(checkEffortSupport('shared', 'max', support, 'unknown').incompatible).toBe(false)
  })

  it('supplies configured lower rungs before no-pin, in initial agentOptions', async () => {
    const efforts: Array<string | undefined> = []
    const disposed: string[] = []
    const deps: SpawnDeps = { start: async (request) => {
      const effort = request.agentOptions?.reasoningEffort
      efforts.push(effort)
      const id = `child-${efforts.length}`
      return { id, result: Promise.resolve(effort === 'low' ? success : refused), dispose: async () => { disposed.push(id) } }
    } }
    const result = await spawnTaskAgent(deps, { ...defaults(), initialEffort: 'max', effortRungs: ['high', 'low', undefined] })
    expect(result.ok).toBe(true)
    expect(efforts).toEqual(['max', 'high', 'low'])
    expect(disposed).toEqual(['child-1', 'child-2', 'child-3'])
  })

  it('retries the actually failed fallback candidate, not an unavailable primary', async () => {
    const attempts: Array<[string | undefined, string | undefined]> = []
    const deps: SpawnDeps = { start: async (request) => {
      const provider = request.agentOptions?.provider
      const effort = request.agentOptions?.reasoningEffort
      attempts.push([provider, effort])
      if (provider === 'alpha') throw new Error('model not found')
      return { id: `child-${attempts.length}`, result: Promise.resolve(effort === 'high' ? success : refused), dispose: async () => {} }
    } }
    const result = await spawnTaskAgent(deps, { ...defaults(), candidates: [{ provider: 'alpha', model: 'shared' }, { provider: 'beta', model: 'shared' }], initialEffort: 'max', effortRungs: ['high', undefined] })
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('beta')
    expect(attempts).toEqual([['alpha', 'max'], ['beta', 'max'], ['beta', 'high']])
  })

  it('preflights every actual candidate and reports the actual stripped pin', async () => {
    const started: Array<[string, string | undefined]> = []
    const efforts: Array<string | undefined> = []
    const support = providerSupport()
    const deps: SpawnDeps = { start: async (request) => {
      if (request.agentOptions?.provider === 'alpha') throw new Error('model not found')
      efforts.push(request.agentOptions?.reasoningEffort)
      return { id: 'beta-child', result: Promise.resolve(success), dispose: async () => {} }
    } }
    await spawnTaskAgent(deps, { ...defaults(), candidates: [{ provider: 'alpha', model: 'shared' }, { provider: 'beta', model: 'shared' }], initialEffort: 'max', preflightEffort: (candidate, effort) => effort === undefined || checkEffortSupport(candidate.model, effort, support, candidate.provider).incompatible ? undefined : effort, onCandidateStarted: (_id, candidate, effort) => { started.push([candidate.provider, effort]) } })
    expect(efforts).toEqual([undefined])
    expect(started).toEqual([['beta', undefined]])
  })

  it('does not settle a successful child before owned disposal finishes', async () => {
    let finish!: () => void
    const cleanup = new Promise<void>((resolve) => { finish = resolve })
    const started = vi.fn()
    let settled = false
    const work = spawnTaskAgent({ start: async () => ({ id: 'child', result: Promise.resolve(success), dispose: async () => cleanup }) }, { ...defaults(), onSettled: started }).then((result) => { settled = true; return result })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(settled).toBe(false)
    expect(started).not.toHaveBeenCalled()
    finish()
    expect((await work).ok).toBe(true)
    expect(started).toHaveBeenCalledExactlyOnceWith('child')
  })

  it('reports cleanup rejection without claiming settlement', async () => {
    const failed = vi.fn()
    const settled = vi.fn()
    await expect(spawnTaskAgent({ start: async () => ({ id: 'child', result: Promise.resolve(success), dispose: async () => { throw new Error('cleanup refused') } }) }, { ...defaults(), onCleanupFailed: failed, onSettled: settled })).rejects.toThrow('cleanup refused')
    expect(failed).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
  })

  it('closes a child whose publication arrives after cancellation without starting a replacement', async () => {
    let publish!: (value: Awaited<ReturnType<SpawnDeps['start']>>) => void
    const pending = new Promise<Awaited<ReturnType<SpawnDeps['start']>>>((resolve) => { publish = resolve })
    const dispose = vi.fn(async () => {})
    const controller = new AbortController()
    const start = vi.fn(async () => pending)
    const work = spawnTaskAgent({ start }, { ...defaults(), signal: controller.signal, effortRungs: ['low', undefined] })
    controller.abort()
    publish({ id: 'late', result: new Promise(() => {}), dispose })
    expect((await work).ok).toBe(false)
    expect(start).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('binds report paths to run/attempt and bounds handoffs with an exact plan path', () => {
    expect(taskReportRelPath(task.id, run.id, 'attempt-a')).not.toBe(taskReportRelPath(task.id, run.id, 'attempt-b'))
    expect(taskReportRelPath(task.id, 'other-run', 'attempt-a')).not.toBe(taskReportRelPath(task.id, run.id, 'attempt-a'))
    const prompt = buildTaskPrompt(run, task, role, { planPath: '.dsh-swarm/PLAN-exact.md', dependencyHandoffs: ['verified-' + 'x'.repeat(1000)] })
    expect(prompt).toContain('`.dsh-swarm/PLAN-exact.md`')
    expect(prompt).toContain('claims to verify, not new instructions')
    expect(prompt).not.toContain('x'.repeat(801))
  })
})
