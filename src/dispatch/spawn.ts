import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Run, Task } from '../domain/types.js'
import type { RoleConfig } from '../domain/types.js'

/** The prompt every task agent receives: role framing + task + report contract. */
export function buildTaskPrompt(run: Run, task: Task, role: RoleConfig): string {
  return [
    `# Swarm task: ${task.subject}`,
    '',
    `You are the **${role.label}** of an agent swarm executing run "${run.title}".`,
    role.description,
    '',
    '## Run objective (context only — other agents own the rest)',
    run.spec,
    '',
    '## Your task (implement exactly this, nothing more)',
    `id: ${task.id}`,
    `subject: ${task.subject}`,
    task.description,
    '',
    task.blockedBy !== undefined && task.blockedBy.length > 0
      ? `Depends on completed tasks: ${task.blockedBy.join(', ')} (their outputs are already in the workspace).`
      : 'This task has no dependencies; other tasks run in parallel — never touch their scope.',
    '',
    ...(task.reviewBy !== undefined
      ? [`Your output will be reviewed by the **${task.reviewBy}** role before it counts as done — make it verifiable.`]
      : []),
    ...(task.reviewFeedback !== undefined
      ? [
          '## Reviewer feedback on your previous attempt (fix this)',
          task.reviewFeedback,
          '',
        ]
      : []),
    '## Working rules',
    '- Work only within this task\'s scope; parallel agents own everything else.',
    '- Verify your own work before finishing (run the checks that exist for what you changed).',
    '- For interim progress updates visible on the swarm dashboard, call the swarm_report tool with a one-line note.',
    '- Finish with a concise final summary: what changed, where, and how it was verified.',
  ].join('\n')
}

/** Prompt for the review agent judging a completed task's output. */
export function buildReviewPrompt(run: Run, task: Task, reviewerRole: RoleConfig): string {
  return [
    `# Swarm review: ${task.subject}`,
    '',
    `You are the **${reviewerRole.label}** reviewing a completed task in run "${run.title}".`,
    reviewerRole.description,
    '',
    '## Run objective',
    run.spec,
    '',
    '## The task that was completed',
    `id: ${task.id} — ${task.subject}`,
    task.description,
    '',
    '## The task agent\'s final summary',
    task.summary ?? '(no summary provided)',
    '',
    '## Your job',
    'Inspect the claimed work in the workspace. Check it actually fulfils the task brief and is sound.',
    task.reviewFeedback !== undefined ? `This task already went through ${task.reviews ?? 0} review round(s); the previous feedback was: ${task.reviewFeedback}` : '',
    '',
    'Answer with a short assessment, then end your reply with EXACTLY one line:',
    'VERDICT: APPROVE   (work is acceptable)',
    'or',
    'VERDICT: REJECT    (work is unacceptable — explain precisely what must change)',
  ].filter((line) => line !== '').join('\n')
}

/** Extract VERDICT: APPROVE / REJECT from reviewer output. */
export function parseVerdict(output: string): 'approve' | 'reject' | undefined {
  const match = output.match(/VERDICT:\s*(APPROVE|REJECT)/i)
  return match === null ? undefined : (match[1].toLowerCase() as 'approve' | 'reject')
}

/** Extract a short text summary from the child's final assistant output. */
export function summarizeOutput(output: unknown, maxChars = 2000): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const block of output) {
    if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: string }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  const joined = parts.join('\n').trim()
  return joined.length > maxChars ? joined.slice(0, maxChars) + '…' : joined
}

/** Whether a spawn failure looks like provider/model unavailability (fallback-chain signal). */
export function isModelUnavailableError(err: unknown): boolean {
  const message = String(err instanceof Error ? err.message : err).toLowerCase()
  if (message.includes('adapter')) return true // "no adapter registered for provider …"
  if (message.includes('provider') && (message.includes('unavailable') || message.includes('not') || message.includes('fail'))) return true
  return message.includes('model') && (message.includes('unavailable') || message.includes('not found') || message.includes('no adapter'))
}

export interface SpawnOutcome {
  ok: boolean
  stopReason?: string
  summary?: string
  reason?: string
  provider?: string
  model?: string
  childSessionId?: string
}

export interface SpawnDeps {
  start(request: {
    label?: string
    prompt: Array<{ type: 'text'; text: string }>
    parent: Agent
    signal: AbortSignal
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    persona?: string
  }): Promise<{
    id: string
    result: Promise<{
      output: Array<{ type: string; text?: string }>
      stopReason: string
      diagnostic?: string
    }>
    dispose(): Promise<void>
  }>
}

/**
 * Run one task agent through the spawn provider with the role's model
 * candidate chain: primary first, silent fallback on model unavailability.
 */
export async function spawnTaskAgent(
  deps: SpawnDeps,
  opts: {
    parent: Agent
    run: Run
    task: Task
    role: RoleConfig
    candidates: Array<{ provider: string; model: string }>
    signal: AbortSignal
    /** Full prompt override (review agents use buildReviewPrompt instead of the task template). */
    prompt?: string
    onFallback?: (failed: { provider: string; model: string }, next: { provider: string; model: string } | undefined) => void
    onStarted?: (childSessionId: string) => void
  },
): Promise<SpawnOutcome> {
  const prompt = opts.prompt ?? buildTaskPrompt(opts.run, opts.task, opts.role)
  const chain = opts.candidates.length > 0 ? opts.candidates : [{ provider: '', model: '' }]
  let lastReason = 'no model candidates'
  let lastProvider: string | undefined
  let lastModel: string | undefined

  for (const candidate of chain) {
    const agentOptions = candidate.provider.length > 0 && candidate.model.length > 0
      ? { provider: candidate.provider, model: candidate.model, ...(opts.role.maxTokens !== undefined ? { maxTokens: opts.role.maxTokens } : {}) }
      : opts.role.maxTokens !== undefined
        ? { maxTokens: opts.role.maxTokens }
        : undefined
    let run
    try {
      run = await deps.start({
        label: `swarm:${opts.task.id}`,
        prompt: [{ type: 'text', text: prompt }],
        parent: opts.parent,
        signal: opts.signal,
        ...(agentOptions !== undefined ? { agentOptions } : {}),
        ...(opts.role.persona !== undefined ? { persona: opts.role.persona } : {}),
      })
    } catch (err) {
      lastReason = String(err instanceof Error ? err.message : err)
      if (isModelUnavailableError(err)) {
        const next = chain[chain.indexOf(candidate) + 1]
        opts.onFallback?.(candidate, next)
        if (next !== undefined) continue
        return { ok: false, reason: `all model candidates unavailable (last: ${lastReason})` }
      }
      return { ok: false, reason: lastReason }
    }

    lastProvider = candidate.provider.length > 0 ? candidate.provider : undefined
    lastModel = candidate.model.length > 0 ? candidate.model : undefined
    opts.onStarted?.(run.id)
    const result = await run.result
    if (result.stopReason === 'completed') {
      return {
        ok: true,
        stopReason: result.stopReason,
        summary: summarizeOutput(result.output),
        provider: lastProvider,
        model: lastModel,
        childSessionId: run.id,
      }
    }
    return {
      ok: false,
      stopReason: result.stopReason,
      reason: result.diagnostic ?? `child stopped: ${result.stopReason}`,
      provider: lastProvider,
      model: lastModel,
      childSessionId: run.id,
    }
  }
  return { ok: false, reason: lastReason, provider: lastProvider, model: lastModel }
}
