import { describe, expect, it, vi } from 'vitest'
import { registerSwarmTools } from '../src/tools/index.js'
import { validateDag } from '../src/domain/dag.js'

type Tool = { name: string; description: string; parameters: Record<string, unknown>; execute(args: unknown, exec: never): Promise<unknown> }
function tools() {
  const definitions = new Map<string, Tool>()
  const service = { dispatch: vi.fn(() => ({ runId: 'r', taskCount: 1, status: 'planning' })), waitForChange: vi.fn(async () => 'cursor 12'), interruptTask: vi.fn(), retryTask: vi.fn(), completeTaskExternally: vi.fn() }
  registerSwarmTools({ get: () => ({ register: (definition: Tool) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }) } as never, service as never)
  return { definitions, service, invoke: (name: string, args: unknown) => definitions.get(name)!.execute(args, { agent: { id: 'owner' }, signal: new AbortController().signal } as never) }
}

describe('model-facing hardening contracts', () => {
  it('preserves policy, budgets and artifact contracts through actual tool validation', async () => {
    const r = tools()
    const task = { id: 'a', subject: 'A', description: 'Synthetic', role: 'builder', evidence: { artifacts: [{ path: 'out.json', format: 'json', schemaVersion: 1, requiredKeys: ['version'] }] }, policy: { evidence: 'required' } }
    const policy = { version: 1, evidence: 'required', review: 'strict', isolation: 'advisory' }
    const budget = { mode: 'advisory', maxRequests: 2 }
    await r.invoke('swarm_dispatch', { title: 'synthetic', spec: 's', tasks: [task], policy, budget })
    expect(r.service.dispatch).toHaveBeenCalledWith(expect.objectContaining({ tasks: [task], policy, budget }), { id: 'owner' })
    expect(validateDag([task] as never).valid).toBe(true)
  })

  it('does not strip unknown task fields before the domain validator can refuse them', async () => {
    const r = tools()
    const task = { id: 'a', subject: 'A', description: 'Synthetic', role: 'builder', inventedStrictBoundary: true }
    await r.invoke('swarm_dispatch', { title: 'synthetic', spec: 's', tasks: [task] })
    const forwarded = (r.service.dispatch.mock.calls[0] as unknown[])[0] as { tasks: unknown[] }
    expect(forwarded.tasks).toEqual([task])
    expect(validateDag(forwarded.tasks as never)).toMatchObject({ valid: false, errors: [expect.stringMatching(/unknown|unsupported|inventedStrictBoundary/)] })
  })

  it('forwards cursor waits and observed destructive intent without refreshing it', async () => {
    const r = tools()
    await r.invoke('swarm_wait', { runId: 'r', timeoutSeconds: 5, afterSeq: 12, mode: 'drained', maxChars: 512 })
    expect(r.service.waitForChange).toHaveBeenCalledWith('r', 5000, expect.any(AbortSignal), { afterSeq: 12, mode: 'drained', maxChars: 512 })
    const observed = { attemptId: 'att-old', status: 'running', attemptRevoked: false }
    await r.invoke('swarm_interrupt', { runId: 'r', taskId: 'a', observed })
    expect(r.service.interruptTask).toHaveBeenCalledWith('r', 'a', 'owner', observed)
    const definition = r.definitions.get('swarm_dispatch')!
    expect(JSON.stringify(definition.parameters)).toContain('advisory')
    expect(JSON.stringify(definition.parameters)).toContain('Strict is refused')
  })
})
