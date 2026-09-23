import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Run, Task, TaskEvidence } from '../domain/types.js'
import type { RoleConfig } from '../domain/types.js'

/** Extra spawn context: retry-resume hints (A4) and the evidence contract (J2). */
export interface PromptContext {
  /** Progress notes from the task's previous attempt(s) — the child resumes from here. */
  priorNotes?: string[]
  /** Machine-checked evidence requirements, restated in the prompt. */
  evidence?: TaskEvidence
  /** J16: the run's workspace root, stated so path-relative contracts are unambiguous. */
  workspace?: string
}

/** The prompt every task agent receives: role framing + task + report contract. */
export function buildTaskPrompt(run: Run, task: Task, role: RoleConfig, context: PromptContext = {}): string {
  return [
    `# Swarm task: ${task.subject}`,
    '',
    `You are the **${role.label}** of an agent swarm executing run "${run.title}".`,
    role.description,
    '',
    '## Run objective (context only — other agents own the rest)',
    run.spec,
    '',
    // J16: state the workspace root explicitly. The rest of this prompt refers to
    // "the workspace" repeatedly, and without an absolute path each agent guesses —
    // observed live: one task wrote to the run root while its siblings wrote into a
    // subdirectory named in the spec, so their evidence contracts failed and the
    // integrator could not reconcile the two. Every bare path below (evidence.files,
    // the write scope, the task report) is resolved against THIS directory.
    ...(context.workspace !== undefined
      ? [
          '## Workspace root (all relative paths resolve here)',
          `\`${context.workspace}\``,
          '',
          `Every relative path in this brief — your evidence contract, your write scope, \`${taskReportRelPath(task.id)}\` — is resolved against that directory by the dispatcher. If the brief names any other directory, write there too only if you ALSO satisfy the contract at the workspace root.`,
          '',
        ]
      : []),
    '## Your task (implement exactly this, nothing more)',
    `id: ${task.id}`,
    `subject: ${task.subject}`,
    task.description,
    '',
    task.blockedBy !== undefined && task.blockedBy.length > 0
      ? `Depends on completed tasks: ${task.blockedBy.join(', ')} (their outputs are already in the workspace).`
      : 'This task has no dependencies; other tasks run in parallel — never touch their scope.',
    '',
    ...(task.writes !== undefined && task.writes.length > 0
      ? [`Exclusive write scope: ${task.writes.join(', ')} — do not modify files outside this list.`]
      : []),
    ...((task.blockedBy ?? []).some((b) => b.startsWith('architect-review'))
      ? ['The architect\'s plan file (matching PLAN-*.md in the workspace root) is the refined plan of record — where it conflicts with this brief, follow the plan and note the deviation in your summary.']
      : []),
    ...(task.reviewBy !== undefined
      ? [`Your output will be reviewed by the **${task.reviewBy}** role before it counts as done — make it verifiable.`]
      : []),
    ...(context.evidence !== undefined
      ? [
          '',
          '## Evidence contract (the task is NOT done until ALL of this holds)',
          ...(context.evidence.files ?? []).map((f) => `- File exists and is non-empty: \`${f}\` (relative to the workspace)`),
          ...(context.evidence.commands ?? []).map((c) => `- Command exits 0: \`${c}\``),
        ]
      : []),
    ...(task.reviewFeedback !== undefined
      ? [
          '',
          '## Reviewer feedback on your previous attempt (fix this)',
          task.reviewFeedback,
        ]
      : []),
    ...((context.priorNotes?.length ?? 0) > 0
      ? [
          '',
          '## Notes from your previous attempt(s) — resume from here',
          'A previous attempt already did part of this task. INSPECT the workspace for its files first and build on that work instead of redoing the research.',
          ...context.priorNotes!.map((note) => `- ${note}`),
        ]
      : []),
    '',
    '## Working rules',
    '- Work only within this task\'s scope; parallel agents own everything else.',
    '- Verify your own work before finishing (run the checks that exist for what you changed).',
    '- Post a `swarm_report` progress note at least every ~10 minutes or at each milestone, prefixed `progress:`, `blocker:`, or `done:`.',
    '- Finish with a concise final summary: what changed, where, and how it was verified.',
    '',
    '## Mandatory final action — write your task report (J10)',
    `As the LAST thing you do, write \`${taskReportRelPath(task.id)}\` (relative to the workspace) containing JSON:`,
    '```json',
    '{ "taskId": "' + task.id + '", "status": "completed", "summary": "<what changed and how you verified it>" }',
    '```',
    'Write it only when the work is genuinely done and verified — it is machine-checked and the',
    'dispatcher treats it as proof of completion. If you cannot finish, do not write it.',
    'This exists because a host restart can kill you between finishing the work and being recorded:',
    'the report is what preserves the finished work instead of discarding it.',
  ].join('\n')
}

/** Workspace-relative path of a task's durable completion report (J10). */
export function taskReportRelPath(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `.dsh-swarm/task-${safe}.json`
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
    ...(task.evidence !== undefined
      ? [
          '## Evidence contract the task had to satisfy (verify each item yourself)',
          ...(task.evidence.files ?? []).map((f) => `- File exists and is non-empty: \`${f}\``),
          ...(task.evidence.commands ?? []).map((c) => `- Command exits 0: \`${c}\``),
          '',
        ]
      : []),
    ...(task.evidence !== undefined || task.summary !== undefined
      ? [
          '## Where to start verifying',
          `- The task agent's own report: \`${taskReportRelPath(task.id)}\` — read it, then verify its claims in the workspace rather than trusting it.`,
          ...(task.evidence?.commands ?? []).length > 0 ? ['- Re-run the evidence commands above from the workspace root.'] : [],
          '',
        ]
      : []),
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

/**
 * Follow-up for a reviewer that settled without a verdict line (item 8): give it
 * its own assessment back and demand the exact line, nothing else.
 */
export function buildReviewReaskPrompt(assessment: string): string {
  return [
    'Your review above did not include the required verdict line, so it could not be recorded.',
    'End this reply with EXACTLY one line and nothing after it:',
    'VERDICT: APPROVE',
    'or',
    'VERDICT: REJECT',
    '',
    'Your previous assessment, for reference:',
    assessment.length > 0 ? assessment : '(no assessment text)',
  ].join('\n')
}

/** Extract a short text summary from the child's final assistant output. */
/** The child's complete final-message text, without any truncation. */
export function outputText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const block of output) {
    if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: string }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n').trim()
}

export function summarizeOutput(output: unknown, maxChars = 2000): string {
  const joined = outputText(output)
  return joined.length > maxChars ? joined.slice(0, maxChars) + '…' : joined
}

/** Whether a spawn failure looks like provider/model unavailability (fallback-chain signal). */
export function isModelUnavailableError(err: unknown): boolean {
  const message = String(err instanceof Error ? err.message : err).toLowerCase()
  if (message.includes('adapter')) return true // "no adapter registered for provider …"
  if (message.includes('provider') && (message.includes('unavailable') || message.includes('not') || message.includes('fail'))) return true
  return message.includes('model') && (message.includes('unavailable') || message.includes('not found') || message.includes('no adapter'))
}

/**
 * J18: whether a failure is the model rejecting the pinned reasoning effort.
 *
 * This is a *configuration* mismatch between the role's effort pin and the model
 * that actually served the request, not a provider outage — so the right response
 * is to drop the effort and retry, never to fail the task.
 */
export function isUnsupportedEffortError(reason: string | undefined): boolean {
  if (reason === undefined) return false
  return /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i.test(reason)
}

export interface SpawnOutcome {
  ok: boolean
  stopReason?: string
  summary?: string
  /** Complete final-message text, untruncated (the summary is capped at 2000 chars). */
  finalText?: string
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
    toolFilter?: { deny?: string[]; allow?: string[] }
    maxDepth?: number
    evidenceWarnings?: string[]
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
 * A1: a failure this fast that produced no output at all is a request-level
 * rejection — an unsupported pin, an auth/route problem, a model refusing the
 * request — rather than an attempt that ran and genuinely failed.
 *
 * Production evidence (seq 3913-3915): the child died 42 ms after
 * `task/agent-started` with stopReason `error` and no diagnostic, so the failure
 * arrived as the generic reason "child stopped: error". That string never matches
 * the J18 unsupported-effort signature (`UNSUPPORTED_REASONING_EFFORT`), so the
 * dispatcher rotated models instead of dropping the pin.
 */
export const FAST_FAILURE_MS = 10_000

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
    /** Per-role tool restriction (J1) passed through to the spawn provider. */
    toolFilter?: { deny?: string[]; allow?: string[] }
    /** Retry-resume hints woven into the prompt (A4). */
    priorNotes?: string[]
    /** Evidence contract restated in the prompt (J2). */
    evidence?: TaskEvidence
    /** J14: absolute delegation-depth cap for the task agent (1 = no grandchildren). */
    maxDepth?: number
    /** J16: the run's workspace root, stated in the prompt so relative paths are unambiguous. */
    workspace?: string
    onFallback?: (failed: { provider: string; model: string }, next: { provider: string; model: string } | undefined) => void
    onStarted?: (childSessionId: string) => void
    /** J18: clear the per-request effort pin for a child before an effort-less retry. */
    onDropEffort?: (childSessionId: string) => void
    /**
     * A1: the ladder rungs to try on the SAME model before the task rotates
     * models — the entries after this attempt's pinned primary, ending at
     * `undefined` (no pin). Owned by the service; the retry here is bounded by
     * its length and never touches the task's retry budget or the model chain.
     */
    effortRungs?: Array<string | undefined>
    /** A1: re-pin a retry child to the next rung (the service re-registers that child). */
    onEffortRung?: (childSessionId: string, effort: string) => void
  },
): Promise<SpawnOutcome> {
  const prompt = opts.prompt ?? buildTaskPrompt(opts.run, opts.task, opts.role, { priorNotes: opts.priorNotes, evidence: opts.evidence, workspace: opts.workspace })
  const chain = opts.candidates.length > 0 ? opts.candidates : [{ provider: '', model: '' }]
  let lastReason = 'no model candidates'
  let lastProvider: string | undefined
  let lastModel: string | undefined
  /** A1: set by the last pass — a failed child that died fast with no output (see FAST_FAILURE_MS). */
  let lastFailureWasFast = false

  /**
   * J18: run one pass over the candidate chain at a single effort rung.
   *
   * `rung` is the reasoning-effort pin for this pass; `undefined` clears the pin
   * (the J18 degrade). `keepPin` leaves the service's own pin for this attempt in
   * place — the first pass, where the service registered the primary rung through
   * `onStarted` before this run existed. `only` restricts the pass to a single
   * candidate, which the effort retry uses to re-run the SAME model instead of
   * walking the chain.
   *
   * The effort is pinned through the `agent/request` waterfall, so it is applied
   * to whichever model actually serves the request — including a FALLBACK whose
   * model does not support that level. Observed live: a role pinned
   * `reasoningEffort: "max"` with a `zai/glm-5.3` fallback, and every spawned task
   * died ~1s in with `UNSUPPORTED_REASONING_EFFORT`. That error arrives as the
   * child's stopReason, not as a `start()` throw, so the candidate loop below
   * never advanced and the whole run failed.
   */
  const runPass = async (rung: string | undefined, only?: { provider: string; model: string }, keepPin = false): Promise<SpawnOutcome> => {
    for (const candidate of only === undefined ? chain : [only]) {
      // Reset per candidate: the flag describes THIS pass's failure, and a
      // start() throw (model unavailable) must never inherit a fast-failure read.
      lastFailureWasFast = false
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
          // J14: bound the delegation depth of every task agent. The swarm never
          // passed maxDepth, so a task agent could spawn its own DSH subagents, and
          // those were invisible to the dispatcher: not counted by the global agent
          // cap, not tracked by the watchdog, not shown on the board, and each one
          // resident on the same Node heap. Observed in production: the
          // `vhp-cryo-embed` task spawned 12 hidden subagents in 42 minutes while the
          // orchestrator saw exactly one task, and one chain reached depth 3.
          // maxDepth 1 permits the task agent itself (depth 1) and rejects any
          // further delegation with SubagentDepthError. 0 disables the bound.
          ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
          ...(agentOptions !== undefined ? { agentOptions } : {}),
          ...(opts.role.persona !== undefined ? { persona: opts.role.persona } : {}),
          ...(opts.toolFilter !== undefined ? { toolFilter: opts.toolFilter } : {}),
        })
      } catch (err) {
        lastReason = String(err instanceof Error ? err.message : err)
        if (isModelUnavailableError(err)) {
          // The chain walk belongs to a full pass only: a single-candidate pass
          // (the effort retry) must never advance the A6 rotation.
          const next = only === undefined ? chain[chain.indexOf(candidate) + 1] : undefined
          opts.onFallback?.(candidate, next)
          if (next !== undefined) continue
          return { ok: false, reason: `all model candidates unavailable (last: ${lastReason})` }
        }
        return { ok: false, reason: lastReason }
      }

      lastProvider = candidate.provider.length > 0 ? candidate.provider : undefined
      lastModel = candidate.model.length > 0 ? candidate.model : undefined
      // The child exists from here: this is the clock the fast-failure heuristic
      // (and only that) measures against.
      const startedAt = Date.now()
      opts.onStarted?.(run.id)
      if (keepPin) {
        // The first pass: the service pinned the primary rung in onStarted, so
        // there is nothing to change here (and `undefined` must NOT mean "drop").
      } else if (rung === undefined) {
        opts.onDropEffort?.(run.id)
      } else {
        opts.onEffortRung?.(run.id, rung)
      }
      const result = await run.result
      if (result.stopReason === 'completed') {
        return {
          ok: true,
          stopReason: result.stopReason,
          summary: summarizeOutput(result.output),
          finalText: outputText(result.output),
          provider: lastProvider,
          model: lastModel,
          childSessionId: run.id,
        }
      }
      // A1: the request-level-rejection read — failed, said nothing, died fast.
      lastFailureWasFast = outputText(result.output).length === 0 && Date.now() - startedAt < FAST_FAILURE_MS
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

  const first = await runPass(undefined, undefined, true)
  const firstWasFast = lastFailureWasFast
  // J18: if the model rejected the pinned reasoning effort, retry the same chain
  // once with the effort pin removed. Degrading beats failing the task, and the
  // candidate chain is preserved so this does not mask real outages.
  if (!first.ok && isUnsupportedEffortError(first.reason)) {
    lastReason = first.reason ?? lastReason
    const retry = await runPass(undefined)
    if (retry.ok || !isUnsupportedEffortError(retry.reason)) return retry
  }
  // A1: effort varies fastest — before the model chain. When the first pass
  // failed in a way that smells like the PIN rather than the model (the provider
  // said so explicitly, or the child died fast without producing anything), walk
  // the remaining rungs on the SAME model, lowest pin last, ending at no pin.
  //
  // This is internal to the attempt: it starts children, but it never consumes
  // the task's retry budget, never changes the task's attempt number, and never
  // advances the A6 rotation — the caller sees one attempt either way. The walk
  // is bounded by the rung count, and it stops at the first failure that is no
  // longer effort-suspect (that is a genuine model failure, which is the model
  // chain's business).
  const rungQueue = opts.effortRungs ?? []
  if (!first.ok && rungQueue.length > 0 && chain.length > 0 && (isUnsupportedEffortError(first.reason) || firstWasFast)) {
    let last: SpawnOutcome = first
    for (const rung of rungQueue) {
      last = await runPass(rung, chain[0])
      if (last.ok) return last
      lastReason = last.reason ?? lastReason
      if (!(isUnsupportedEffortError(last.reason) || lastFailureWasFast)) return last
    }
    return last
  }
  return first
}
