import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendDelegatedPolicyOverrides } from '@deepseek-ai/dsh-subagent'
import { captureAuthority, validAuthority, type EvidenceShell } from './authority.js'
import type { ExecutionAuthority } from './authority.js'
import { PLUGIN_VERSION, type SwarmConfig } from './config.js'
import { checkEffortSupport, resolveEffortSupport, type EffortSourceFile, type EffortSupport, type SettingsEntryValue } from './preflight.js'
import { validateDag } from './domain/dag.js'
import { DutyTableStore } from './domain/duty-table.js'
import { EventStore } from './domain/event-store.js'
import { RuntimeStore } from './domain/runtime-store.js'
import { RUNTIME_LIMITS, validateRuntimeInteger } from './domain/limits.js'
import { fold, isReady, newState, taskKeyOf, type SwarmState } from './domain/projection.js'
import type { BoardSnapshot } from './board.js'
import { buildBoardSnapshot } from './board.js'
import { spawnTaskAgent, buildReviewPrompt, buildReviewReaskPrompt, parseVerdict, taskReportRelPath, type SpawnDeps } from './dispatch/spawn.js'
import type { DispatchInput, DispatchResult, DutyTable, ModelRef, RoleConfig, Run, RunDispatchContext, Task, TaskSpec } from './domain/types.js'

// Match the producer kind assigned to historical swarm notices by the V3→V4
// migration. Native V4 rejects the retired { kind: 'plugin', plugin: ... } wrapper.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-swarm-orchestrator': {
      readonly kind: 'plugin:dsh-swarm-orchestrator'
    } & ContextFormed
  }
}

/**
 * J15: drop tool names a host does not expose from a role's toolFilter.
 *
 * `tools.restrict()` throws on an unknown name, and that throw happens during
 * child creation — so one typo in a role's toolFilter fails EVERY task agent in
 * the run rather than the single task it was meant to constrain. Production hit
 * this with a filter naming "modlens" when the tool is really
 * `modlens_read_image`: 10/10 tasks failed across 3 waves and the whole run died.
 *
 * A configuration typo must be a warning, not an outage. Pure so the policy is
 * directly testable.
 *
 * An `allow` list that loses every entry is refused outright: an empty allow-list
 * would permit everything, which is the opposite of the operator's intent.
 */
export function sanitizeToolNames(
  requested: { deny?: string[]; allow?: string[] } | undefined,
  known: ReadonlySet<string> | undefined,
): { filter?: { deny?: string[]; allow?: string[] }; dropped: string[]; refusal?: string } {
  if (requested === undefined) return { dropped: [] }
  if (known === undefined) return { dropped: [], refusal: 'tool registry unavailable; cannot verify role restrictions' }
  if ((requested.allow === undefined && requested.deny === undefined)
    || requested.allow?.length === 0 || requested.deny?.length === 0) {
    return { dropped: [], refusal: 'empty tool restrictions are ambiguous; launch refused' }
  }
  const unknownDenied = requested.deny?.filter((name) => !known.has(name)) ?? []
  if (unknownDenied.length > 0) return { dropped: unknownDenied, refusal: 'deny-list contains unknown tools; launch refused rather than widening access' }
  const dropped: string[] = []
  const keep = (names: string[] | undefined): string[] | undefined => {
    if (names === undefined) return undefined
    const valid: string[] = []
    for (const name of names) {
      if (known.has(name)) valid.push(name)
      else dropped.push(name)
    }
    return valid.length > 0 ? valid : undefined
  }
  const deny = keep(requested.deny)
  const allow = keep(requested.allow)
  if (requested.allow !== undefined && requested.allow.length > 0 && allow === undefined) {
    return { dropped, refusal: 'allow-list has no valid tool names; the whole filter was ignored rather than widened' }
  }
  const filter = { ...(deny !== undefined ? { deny } : {}), ...(allow !== undefined ? { allow } : {}) }
  if (deny === undefined && allow === undefined) return { dropped }
  return { filter, dropped }
}

/**
 * A7: what one evidence command actually did.
 *
 * The evidence gate is the last thing between finished work and a completed task,
 * so its verdict has to be readable from `events.jsonl` alone. Before this, a
 * failure recorded only `message.slice(0, 300)` — no exit code, no timeout state,
 * no elapsed time — so "the suite printed a green summary and exited 1 from a
 * documented teardown artefact" and "the suite genuinely failed" looked identical,
 * and the dispatcher had to reproduce the suite by hand to tell them apart.
 */
interface EvidenceCommandOutcome {
  readonly command: string
  readonly ok: boolean
  /** Process exit code when the command ran to completion; absent when it never exited. */
  readonly exitCode?: number
  /** Set when the command could not even be started (e.g. ENOENT: the workspace is gone). */
  readonly spawnError?: string
  /** True when the runner killed it at the ceiling instead of it exiting on its own. */
  readonly timedOut: boolean
  readonly elapsedMs: number
  /** Bounded tail of the command's combined output. */
  readonly outputTail: string
}

/** Output tail kept in the structured record: enough for a stack trace's last frames. */
const EVIDENCE_TAIL_LINES = 18
/** Output tail kept in the recorded reason; the structured record carries the longer one. */
const EVIDENCE_REASON_TAIL_LINES = 6
/** The command itself, bounded — the incident's command string ran to ~300 characters. */
const EVIDENCE_COMMAND_CHARS = 160

/** Last `lines` lines, then bounded to `chars` counted from the END (the informative end). */
function boundedTail(text: string, lines: number, chars: number): string {
  const kept = text.split(/\r?\n/).slice(-lines).join('\n').trim()
  return kept.length > chars ? '…' + kept.slice(-chars) : kept
}

/**
 * One reason string for a failed command. The verdict (exit code, or TIMED OUT) is
 * never truncated away; only the output tail is.
 */
function describeEvidenceFailure(outcome: EvidenceCommandOutcome): string {
  const command = outcome.command.length > EVIDENCE_COMMAND_CHARS
    ? outcome.command.slice(0, EVIDENCE_COMMAND_CHARS) + '…'
    : outcome.command
  const verdict = outcome.timedOut
    ? 'TIMED OUT — the runner killed it at the ceiling before it exited: that is the'
      + ' configured limit, NOT a verdict on the command, so a slow-but-passing command'
      + ' looks exactly like this. Raise evidenceTimeoutMs if it legitimately needs longer,'
      + ' or replace it with a cheap targeted assertion'
    : outcome.spawnError !== undefined
      ? `could not be started (${outcome.spawnError}) — the run workspace or the interpreter is missing`
      : `exit code ${outcome.exitCode ?? 'unknown'}`
  const tail = boundedTail(outcome.outputTail, EVIDENCE_REASON_TAIL_LINES, 600)
  return `evidence command failed — ${verdict}, after ${(outcome.elapsedMs / 1000).toFixed(1)}s: ${command}`
    + (tail.length > 0 ? `\n--- output tail ---\n${tail}` : '\n(no output)')
}

/** The bounded structured record for one outcome, for the event log. */
function evidenceRecord(outcome: EvidenceCommandOutcome): Record<string, unknown> {
  return {
    command: outcome.command.length > 400 ? outcome.command.slice(0, 400) + '…' : outcome.command,
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.spawnError !== undefined ? { spawnError: outcome.spawnError } : {}),
    timedOut: outcome.timedOut,
    elapsedMs: outcome.elapsedMs,
    outputTail: outcome.outputTail,
  }
}

/**
 * Run one evidence command under the resolved interpreter and report what happened.
 *
 * `child_process.exec` builds `<shell> -c <command>`, and on Windows it rejects an
 * absolute interpreter path passed as `shell` with `spawn <path> ENOENT`. So the
 * shell is invoked as the *file* with an explicit `-Command`/`-c` argument, which
 * also removes a layer of quoting from the command string. The declared command is
 * passed through verbatim: a `cmd /c …` string is the child's own choice and runs
 * under the resolved PowerShell exactly as written.
 */
/**
 * B2: the coalescing window for human-attention pings. Long enough that a
 * burst of blocks (production: eight at once) lands in one aggregated message,
 * short enough that the ping feels immediate. Not a heuristic about anything —
 * only about how close together two pings may be.
 */
const HUMAN_WAIT_NOTIFY_COALESCE_MS = 1500

async function runEvidenceCommand(
  shell: EvidenceShell | undefined,
  authority: ExecutionAuthority | undefined,
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  onCleanupFailed?: (error: unknown) => void,
): Promise<EvidenceCommandOutcome> {
  const startedAt = Date.now()
  let handle: Awaited<ReturnType<EvidenceShell['execute']>> | undefined
  // A kill failure must not escape an AbortSignal event listener. The holder
  // remains counted until done acknowledges real cleanup (or fails closed).
  const onAbort = (): void => { try { handle?.kill() } catch { /* await done below */ } }
  try {
    if (!validAuthority(authority)) throw new Error('missing captured dispatch authority; evidence was not executed')
    if (shell === undefined || typeof shell.execute !== 'function') throw new Error('DSH Shell execute service unavailable; evidence was not executed')
    if (authority.sandbox.mode !== 'danger-full-access' && shell.sandboxMode === undefined) {
      throw new Error('Shell cannot enforce the captured sandbox; evidence was not executed')
    }
    if (signal.aborted) throw new Error('evidence cancelled before execution')
    const spec = shell.resolve({
      command, workdir: cwd, timeoutMs, onExpiry: 'kill', signal,
      stdoutMaxBytes: 8 * 1024 * 1024,
      sandboxPolicy: { ...authority.sandbox },
    })
    handle = await shell.execute(spec as never)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const result = await handle.result()
    const sandboxFailed = result.sandbox?.denied === true || result.sandbox?.runnerFailed === true
      || (authority.sandbox.mode !== 'danger-full-access' && result.sandbox?.mode !== authority.sandbox.mode)
    return {
      command,
      ok: result.exitCode === 0 && !result.timedOut && !result.aborted && !sandboxFailed,
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      ...(sandboxFailed ? { spawnError: 'sandbox denied the command or could not enforce the captured policy' } : {}),
      ...(result.aborted ? { spawnError: 'evidence command cancelled' } : {}),
      timedOut: result.timedOut,
      elapsedMs: Date.now() - startedAt,
      outputTail: boundedTail([result.stdout.text, result.stderr.text].filter(Boolean).join('\n'), EVIDENCE_TAIL_LINES, 1600),
    }
  } catch (err) {
    return { command, ok: false, spawnError: String(err instanceof Error ? err.message : err), timedOut: false, elapsedMs: Date.now() - startedAt, outputTail: '' }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (handle !== undefined) {
      try { await handle.done }
      catch (error) { onCleanupFailed?.(error); throw error }
    }
  }
}

/** Classify a spawn-failure reason for pause (A3) and adaptive-concurrency (K1) decisions. */
function classifyFailure(reason: string): 'quota' | 'provider' | 'other' {
  if (/quota|insufficient (balance|credit|funds)|balance (exhausted|depleted)|402|payment required|credit (ran out|exhausted)/i.test(reason)) return 'quota'
  if (/timeout|timed out|rate limit|429|empty response|stream|503|502|server error|transport|econn/i.test(reason)) return 'provider'
  return 'other'
}

/** Canonical workspace compare: forward slashes, no trailing separator, case-folded on Windows. */
function normalizePath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Read the durable session header's cwd without booting the session: the log's
 * first zstd frame is the header event itself, so decode exactly that frame.
 */
function decodeSessionHeaderCwd(logPath: string): string | undefined {
  try {
    const buf = readFileSync(logPath)
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const start = buf.indexOf(magic)
    if (start === -1) return undefined
    let end = buf.indexOf(magic, start + 1)
    if (end === -1) end = buf.length
    const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    const header = JSON.parse(text.split('\n')[0]) as { cwd?: unknown }
    return typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
  } catch {
    return undefined
  }
}

interface InFlight {
  controller: AbortController
  taskKey: string
  childSessionId?: string
  /** J19: the attempt this flight represents, so a superseded one can be told apart. */
  attemptId?: string
  roleId?: string
  phase?: 'build' | 'review' | 'evidence'
  done?: Promise<void>
  cleanupFailed?: boolean
  reclaimReason?: string
  reclaim?: (reason: string) => void
  /**
   * Item 7: re-arms the spawn ceiling once the child has started. The ceiling is
   * then a sliding no-progress timer — every heartbeat re-arms it, so a working
   * child is never killed for elapsed time, while a silent one is reclaimed
   * after the window with the same J10 adoption the settle path uses.
   */
  resetSpawnTimer?: () => void
}

/** Structural view of ctx.agents for anchor creation (see ensureAnchor). */
interface AgentsLike {
  create(options: {
    sessionId: SessionId
    meta?: { cwd?: string; delegationDepth?: number; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string }
    setup?: (anchorCtx: unknown, anchor: Agent) => void | Promise<void>
  }): Promise<{ agent: Agent; dispose(): Promise<void> }>
  /**
   * Live-agent lookup by session id (workspace resolution + swarm notices).
   * `status`/`steer`/`inject` are optional so a host too old to expose them
   * still receives notices through `followup` (see pushNotice).
   */
  get?(id: string): {
    status?: 'idle' | 'running'
    session?: { header?: { cwd?: string } }
    followup?(message: unknown): void
    steer?(message: unknown): void
    inject?(message: unknown): void
  } | undefined
}

/** Structural view of the agentPresets service for anchor composition. */
interface PresetsLike {
  mount(anchorCtx: unknown, id?: string): Promise<unknown>
}

/**
 * P2: the standing brief for the injected architect-review task. It receives
 * the dispatching agent's proposal verbatim and reviews/refines it — never
 * replaces it — with PLAN.md as the enforced artifact.
 */
function architectReviewPrompt(title: string, spec: string, tasks: TaskSpec[], planFile: string): string {
  const proposal = [
    `Title: ${title}`,
    `Objective: ${spec}`,
    '',
    'Proposed tasks:',
    ...tasks.map((t) => `- ${t.id} (${t.role})${t.writes !== undefined ? ` [writes: ${t.writes.join(', ')}]` : ''}: ${t.subject} — ${t.description}`),
  ].join('\n')
  return [
    'The dispatching agent has already proposed the plan below. Your job is to REVIEW and REFINE it — verify it against the repository, do not start from scratch.',
    '',
    '## The proposal (as dispatched)',
    proposal,
    '',
    '## Your review procedure',
    '1. Deep-research the proposal against the actual repository: verify every assumption (files, dependencies, build setup, existing code) before trusting it.',
    '2. Check interdependencies: every blockedBy must be real, and anything that runs in parallel must be safe to run concurrently — no shared files without narrower write scopes.',
    '3. If the proposal splits parallel workstreams across separate runs, consolidate them into ONE task DAG in your plan.',
    `4. Write the refined plan to ${planFile} in the workspace root: final task-by-task plan with per-task write scopes, verification steps, flagged risks, and explicit deviations from the proposal.`,
    `5. ${planFile} must exist and be non-empty before you finish — the evidence contract enforces it. (Use this exact filename; other runs in the same workspace have their own plan files.)`,
  ].join('\n')
}

/**
 * Capture the dispatching agent's world as plain JSON while it is alive:
 * its preset, model route, and workspace — everything later spawns need once
 * the dispatching session is gone. Reads are defensive: a dispatcher whose
 * fiber already went inactive still answers plain scope-chain reads, and any
 * failure just drops that field.
 */
function captureDispatchContext(parent: Agent | undefined): Partial<RunDispatchContext> {
  if (parent === undefined) return {}
  const captured: Partial<RunDispatchContext> = {}
  try {
    const options = (parent as { options?: { provider?: string; model?: string } }).options
    if (typeof options?.provider === 'string' && typeof options.model === 'string'
      && options.provider.length > 0 && options.model.length > 0) {
      captured.provider = options.provider
      captured.model = options.model
    }
  } catch { /* route unreadable — leave unset */ }
  try {
    const header = (parent as { session?: { header?: { id?: string; sessionId?: string; cwd?: string } } }).session?.header
    // Session id with fallbacks: some dispatch paths expose it only on the agent
    // object itself (live capture bug found in the LinguaLens runs — header.id
    // can be blank while the agent's own id is the session id).
    const fromHeader = typeof header?.id === 'string' && header.id.length > 0 ? header.id
      : typeof header?.sessionId === 'string' && header.sessionId.length > 0 ? header.sessionId
        : undefined
    const fromAgent = (parent as { id?: unknown }).id
    const sessionId = fromHeader ?? (typeof fromAgent === 'string' && fromAgent.length > 0 ? fromAgent : undefined)
    if (sessionId !== undefined) captured.sessionId = sessionId
    if (typeof header?.cwd === 'string' && header.cwd.length > 0) captured.cwd = header.cwd
  } catch { /* header unreadable — leave unset */ }
  try {
    const presets = (parent as { ctx?: { get(name: string): unknown } }).ctx?.get('agentPresets') as
      | { composedPreset(agentCtx: unknown): string | undefined }
      | undefined
    const presetId = presets?.composedPreset?.((parent as { ctx?: unknown }).ctx)
    if (typeof presetId === 'string' && presetId.length > 0) captured.presetId = presetId
  } catch { /* preset unreadable — leave unset */ }
  return captured
}

/** A8: the longest run title the board accepts (a display label, not a document). */
const MAX_RUN_TITLE = 120
/** A8: how many removed runs a snapshot carries back for Restore (newest first). */
const MAX_REMOVED_RUNS = 50

/**
 * The host-side swarm service: duty table + JSONL event store + dispatcher.
 * State is folded from the event log on every change; the dispatcher launches
 * one-shot task agents through ctx.subagents with the role's model chain.
 */
export class SwarmService extends Service {
  private readonly swarmConfig: SwarmConfig
  readonly events: EventStore
  readonly duty: DutyTableStore
  readonly runtime: RuntimeStore
  readonly startedAt: number

  private state: SwarmState = newState()
  private stateDirty = true
  private readonly inFlight = new Map<string, InFlight>()
  /**
   * J19: task key → the attempt id currently permitted to write that task.
   * Set when an attempt launches and re-set by every subsequent attempt, so a
   * late result can always be recognised as belonging to a superseded one.
   */
  private readonly liveAttempts = new Map<string, string>()
  /**
   * J21: the deployment's declared effort support, read once from settings.yaml.
   * undefined = the file could not be read, in which case no preflight warnings are
   * emitted (we do not warn about what we cannot know).
   */
  private effortSupportCache: EffortSupport | undefined
  private effortSupportRead = false
  /** The dispatching agent per run — provenance and cwd source, never the spawn route (see ensureAnchor). */
  private readonly runParents = new Map<string, Agent>()
  /** Service-owned idle anchor agents every spawn of a run is routed through. */
  private readonly runAnchors = new Map<string, { agent: Agent; dispose(): Promise<void> }>()
  private readonly anchorPromises = new Map<string, Promise<Agent | undefined>>()
  /** Includes cancelled holders until their owned cleanup proves quiescence. */
  private readonly holders = new Set<InFlight>()
  private disposed = false
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private readonly recoveries = new Map<string, Promise<void>>()
  private readonly recoveryQueue = new Map<string, { task: Task; summary: string }>()
  private readonly reviewQueue = new Map<string, { runId: string; taskId: string; roleId: string; attemptId: string }>()
  /** K1: per-run adaptive launch capacity (shrinks on provider-class failures, recovers on completions). */
  private readonly adaptiveLimits = new Map<string, number>()
  /** Last silence-nudge timestamp per in-flight task (dedupes re-nudges). */
  private readonly nudgedAt = new Map<string, number>()
  /** Consecutive nudge count per in-flight task (3+ triggers auto-reclaim). */
  private readonly nudgeCount = new Map<string, number>()
  /** H-2 circuit breaker: recent failure timestamps per runId (rolling 30s window). */
  private readonly recentFailures = new Map<string, number[]>()
  /** H-2 circuit breaker: runId → resume-after timestamp (retries paused while active). */
  private readonly circuitBreakerUntil = new Map<string, number>()
  private readonly sessionTasks = new Map<string, { taskKey: string; effort?: string; attemptId?: string }>()
  /**
   * A7: taskKey → the attemptId that already spent its one evidence-only recheck.
   * An evidence-only failure re-runs just the declared commands, never the child; a
   * second failure blocks the task for a human instead of retrying work whose result
   * is already on disk. Bounded by the number of tasks — a new attempt carries a new
   * attemptId, so it earns a fresh recheck.
   */
  private readonly evidenceRecheckedAttempt = new Map<string, string>()
  private tickScheduled = false

  constructor(ctx: Context, config: SwarmConfig) {
    // Validate/load before Cordis publishes this Service. A refused store must
    // degrade the plugin, never leave a discoverable half-initialized instance.
    for (const key of Object.keys(RUNTIME_LIMITS) as Array<keyof typeof RUNTIME_LIMITS>) validateRuntimeInteger(key, config[key])
    mkdirSync(config.storageDir, { recursive: true })
    const events = new EventStore(join(config.storageDir, 'events.jsonl'))
    const duty = new DutyTableStore(join(config.storageDir, 'duty-table.json'))
    const runtime = new RuntimeStore(join(config.storageDir, 'runtime.json'))
    // A valid envelope can still carry an unreplayable payload. Fold before
    // publication too, and retain that validated initial projection.
    const initialState = fold(events.all())
    super(ctx, 'swarm')
    this.swarmConfig = config
    this.startedAt = Date.now()
    ctx.effect(() => () => {
      this.disposed = true
      if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer)
      if (this.humanWaitTimer !== undefined) clearTimeout(this.humanWaitTimer)
      this.recoveryQueue.clear()
      this.reviewQueue.clear()
      const holders = [...this.holders]
      for (const flight of holders) flight.controller.abort()
      void Promise.allSettled(holders.map((flight) => flight.done)).then(() => {
        for (const runId of this.runAnchors.keys()) this.releaseAnchor(runId)
      })
    })
    this.events = events
    this.state = initialState
    this.stateDirty = false
    // B2: record when each task's CURRENT wait episode began (the seq of the
    // task/blocked or task/review-started event that started it). A ping is
    // keyed to the episode it covered, so any NEW block event is by definition
    // a fresh wait — no need to enumerate every resolution path (swarm_retry
    // resolves with task/failed(retry), swarm_review with task/reviewed,
    // swarm_complete with task/completed; listing them already missed one).
    this.events.subscribe((event) => {
      if (event.kind === 'task/blocked' || event.kind === 'task/review-started') {
        if (event.runId !== undefined && event.taskId !== undefined && typeof event.seq === 'number') {
          this.humanWaitEpisode.set(`${event.runId}/${event.taskId}`, event.seq)
        }
      }
    })
    this.duty = duty
    this.runtime = runtime
    // H-4/J9 boot readiness: delay orphan recovery until the subagents spawn
    // provider has actually mounted. The original implementation waited a fixed
    // 3000ms, which is a guess: on a loaded host the plugin tree can take longer,
    // and a retry that fires before `subagents` exists fails with
    // "subagents service unavailable in this host (spawn provider not mounted?)"
    // — burning a task's retry budget for something that was never the task's
    // fault. 18 such failures were recorded. Poll for readiness instead of
    // guessing, and fall back to the deadline so recovery still happens if the
    // provider is genuinely absent from this deployment.
    ctx.effect(() => {
      // H-4/J9 boot readiness. Wait the configured grace, polling for the spawn
      // provider, then recover. The previous implementation waited a fixed 3000ms
      // and nothing else; this keeps that timing as a floor but records whether the
      // provider was actually up, so a genuine post-restart race is visible instead
      // of silently burning retries (18 such failures were recorded).
      const startedAt = Date.now()
      const graceMs = Math.max(0, this.swarmConfig.bootGraceSeconds * 1000)
      const pollMs = 250
      let timer: ReturnType<typeof setTimeout>
      const finish = (providerReady: boolean): void => {
        if (!providerReady) {
          ctx.logger('swarm').warn(
            'subagents provider not mounted after %dms — running orphan recovery anyway '
            + '(requeued tasks may fail with a spawn-provider error on first retry)',
            graceMs,
          )
        }
        try {
          this.recoverOrphans()
        } catch (err) {
          ctx.logger('swarm').warn('orphan recovery after grace failed: %s', String(err))
        }
      }
      const attempt = (): void => {
        const ready = ctx.get('subagents') !== undefined
        if (!ready && Date.now() - startedAt < graceMs) {
          timer = setTimeout(attempt, pollMs)
          return
        }
        finish(ready)
      }
      timer = setTimeout(attempt, graceMs)
      return () => clearTimeout(timer)
    })
    this.events.subscribe(() => {
      this.stateDirty = true
      this.scheduleTick()
    })
    // Watchdog: abort task agents that go silent past staleTimeoutSeconds.
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          this.watchdog()
        } catch (err) {
          this.ctx.logger('swarm').warn('watchdog sweep failed: %s', String(err))
        }
      }, 60000)
      return () => clearInterval(timer)
    })
    this.ctx.logger('swarm').info('swarm service ready v%s (storage: %s)', PLUGIN_VERSION, config.storageDir)
  }

  // ── state ────────────────────────────────────────────────────────────────

  private view(): SwarmState {
    if (this.stateDirty) {
      this.state = fold(this.events.all())
      this.stateDirty = false
    }
    return this.state
  }

  /**
   * Tasks orphaned by a host restart (running/dispatching/reviewing with no live run object).
   *
   * J6: only tasks of a RUNNING run may be re-failed. `fold` already refuses task
   * transitions for terminal runs (projection J5), so failing a task whose run is
   * aborted/completed/failed/paused appends an event that the projection then
   * ignores — the task stays `running`, this method sees it again on the next boot
   * and re-fails it forever, `attempts` never advances, and the retry cap can never
   * engage. Observed in production as 13 consecutive "host restarted mid-flight"
   * events over 21.5 hours against a run that had been aborted 21 hours earlier.
   *
   * The retry budget is also charged here (J7), so orphan recovery cannot loop
   * indefinitely when a task cannot survive a restart.
   */
  private recoverOrphans(): void {
    const state = this.view()
    for (const run of state.runs.values()) {
      if (run.status !== 'running') continue
      if (!validAuthority(run.dispatch?.authority)) {
        const reason = 'legacy run has no captured caller authority — explicitly resume to capture a conservative read-only policy, or redispatch from the owning chat'
        this.events.append('run/paused', { runId: run.id, data: { reason } })
        this.notifyDispatchSession(run.id, 'paused', reason)
        continue
      }
      for (const id of run.taskIds) {
        const task = this.view().tasks.get(run.id + '/' + id)
        if (task === undefined || this.inFlight.has(taskKeyOf(task)) || this.recoveries.has(taskKeyOf(task))) continue
        if (task.status === 'reviewing' && task.humanReview === true) { this.scheduleHumanWaitingNotify(run.id); continue }
        if (task.status === 'completed' || task.status === 'reviewing') {
          if (task.attemptProtocol === 2 && task.attemptId !== undefined && task.attemptRevoked !== true && task.reviewed !== true && task.reviewUnavailable !== true && task.reviewExhausted !== true) {
            if (task.reviewGate === 'human') {
              this.events.append('task/review-started', { runId: run.id, taskId: id, data: { attemptId: task.attemptId, reviewer: task.reviewBy ?? 'human', human: true } })
              this.scheduleHumanWaitingNotify(run.id)
            } else if (task.reviewBy !== undefined && task.reviewBy.length > 0) void this.runReview(run.id, id, task.reviewBy, task.attemptId)
          }
          continue
        }
        if (task.status !== 'running' && task.status !== 'dispatching') continue
        const report = this.adoptTaskReport(run.id, task)
        if (report !== undefined) { this.recoverReportedTask(task, report); continue }
        this.events.append('task/failed', { runId: run.id, taskId: id, data: { source: 'operator', retry: task.attempts <= this.rt('maxRetries'), reason: 'host restarted mid-flight; no correlated report' } })
      }
    }
    this.scheduleTick()
  }

  watchdog(now = Date.now()): void {
    const state = this.view()
    const staleMs = this.rt('staleTimeoutSeconds') * 1000
    const nudgeMs = this.rt('nudgeAfterMinutes') * 60000
    for (const [key, flight] of [...this.inFlight]) {
      const task = state.tasks.get(key)
      if (task === undefined) {
        flight.controller.abort()
        continue // Ownership lasts until the provider and Shell handles settle.
      }
      // A task that left the running state (completed, failed, blocked) while
      // still holding an inFlight slot (settle handler racing the sweep) —
      // clean the tracking Maps to avoid stale entries.
      if (!this.currentFlight(task.runId, task.id, flight, flight.phase === 'review')) {
        flight.controller.abort()
        continue
      }
      if (flight.phase === 'evidence' || flight.reclaimReason !== undefined) continue
      const reclaim = (reason: string): void => {
        this.nudgeCount.delete(key)
        this.nudgedAt.delete(key)
        // Cancel only the child. Its owned settle path validates any correlated
        // report with the SAME evidence/review gates before releasing capacity.
        flight.reclaim?.(reason)
      }
      if (now - task.updatedAt > staleMs) {
        reclaim(`stale: no progress for ${Math.round(staleMs / 1000)}s (watchdog)`)
        this.ctx.logger('swarm').warn('watchdog aborted stale task %s', key)
        continue
      }
      // Early-warning tier: surface long silences long before the reclaim.
      // I-2 escalation: after 3 consecutive nudges (3× nudgeAfterMinutes of
      // silence with no heartbeat reset), auto-reclaim the task — stalled
      // children shouldn't sit for the full stale timeout.
      if (nudgeMs > 0 && task.status === 'running') {
        const last = task.lastNoteAt ?? task.updatedAt
        const silentMs = now - last
        const lastNudge = this.nudgedAt.get(key) ?? 0
        if (silentMs > nudgeMs && now - lastNudge > nudgeMs) {
          this.nudgedAt.set(key, now)
          const count = (this.nudgeCount.get(key) ?? 0) + 1
          this.nudgeCount.set(key, count)
          if (count >= 3) {
            // Escalation: reclaim the stalled child and requeue the task.
            reclaim(`watchdog escalation: ${count} nudges over ${Math.round(silentMs / 60000)} min of silence — child reclaimed`)
            this.ctx.logger('swarm').warn('watchdog escalated task %s after %d nudges', key, count)
            continue
          }
          this.events.append('task/nudged', {
            runId: task.runId, taskId: task.id,
            data: { attemptId: flight.attemptId, silentMinutes: Math.round(silentMs / 60000) },
          })
        }
        // Reset the nudge counter when the task heartbeats (is making progress).
        if (silentMs <= nudgeMs) {
          this.nudgeCount.delete(key)
        }
      }
    }
    // Item 9: keep a generated dependency-board snapshot beside the run for
    // every running run (the coordinator's hand-maintained file is separate
    // and never touched).
    for (const run of this.view().runs.values()) {
      if (run.status === 'running') this.writeDependencyBoard(run.id)
    }
  }

  /**
   * Item 9: auto-export one run's dependency board as markdown, written beside
   * the run (`.dsh-swarm/dependency-board-<runId>.md`). A generated snapshot —
   * clearly marked so it is never confused with a hand-maintained board.
   */
  private writeDependencyBoard(runId: string): void {
    const state = this.view()
    const run = state.runs.get(runId)
    if (run === undefined || run.dispatch?.cwd === undefined) return
    const tasks = run.taskIds
      .map((id) => state.tasks.get(`${runId}/${id}`))
      .filter((t): t is Task => t !== undefined)
    const lines: string[] = []
    lines.push(`# Dependency board — ${run.title}`, '')
    lines.push(`Run: \`${run.id}\` · status: ${run.status} · auto-generated by the swarm service (every watchdog sweep) — do not edit by hand.`, '')
    lines.push('| Task | Role | Status | Attempts | Depends on | Summary / note (head) |', '|---|---|---|---|---|---|')
    for (const task of tasks) {
      const deps = (task.blockedBy ?? []).join(', ')
      const head = (task.summary ?? task.lastNote ?? '').replace(/\|/g, '\\|').split('\n')[0]?.slice(0, 120) ?? ''
      lines.push(`| ${task.id} | ${task.role} | ${task.status} | ${task.attempts} | ${deps} | ${head} |`)
    }
    try {
      const dir = join(run.dispatch.cwd, '.dsh-swarm')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `dependency-board-${runId}.md`), lines.join('\n') + '\n', 'utf8')
    } catch (err) {
      this.ctx.logger('swarm').warn('dependency board write failed for %s: %s', runId, String(err))
    }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  /** Effective runtime parameter: dashboard override wins over YAML config. */
  private rt<K extends keyof import('./domain/runtime-store.js').RuntimeOverrides>(key: K): number {
    const override = this.runtime.get()[key]
    if (override !== undefined) return override
    return this.swarmConfig[key] as number
  }

  /** Update runtime overrides from the dashboard (persisted to runtime.json). */
  setRuntimeOverrides(next: import('./domain/runtime-store.js').RuntimeOverrides): import('./domain/runtime-store.js').RuntimeOverrides {
    const saved = this.runtime.save(next)
    // Reset in-memory state that depends on tunable parameters.
    this.circuitBreakerUntil.clear()
    this.recentFailures.clear()
    this.scheduleTick()
    return saved
  }

  /**
   * Detect concurrent tasks claiming the same exclusive write scope.
   *
   * Two shapes matter:
   *  - an EXACT shared path (the original check);
   *  - a review/integration task declaring a whole directory (`src`, `scripts`,
   *    `docs`) that NESTS every file a builder owns. This was the actual production
   *    pattern: 13 of 23 runs that declared scopes had unserialised overlap, and
   *    those runs produced 20 "file changed since it was read" tool failures while
   *    the 24 runs without overlap produced none.
   *
   * Non-fatal — surfaced as warnings, capped so a whole-tree claim cannot flood
   * the dispatch result.
   */
  private writeOverlapWarnings(tasks: TaskSpec[]): string[] {
    const norm = (p: string): string => p.trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
    const encloses = (outer: string, inner: string): boolean =>
      outer.length > 0 && inner.length > outer.length && inner.startsWith(outer + '/')
    /** A scope is "broad" when it is a bare directory that likely covers a whole tree. */
    const isBroad = (scope: string): boolean =>
      scope.length > 0 && !scope.includes('.') && !/[*?]/.test(scope)

    const reach = new Map<string, Set<string>>()
    for (const task of tasks) {
      const seen = new Set<string>()
      const stack = [...(task.blockedBy ?? [])]
      while (stack.length > 0) {
        const current = stack.pop()!
        if (seen.has(current)) continue
        seen.add(current)
        const upstream = tasks.find((t) => t.id === current)
        if (upstream !== undefined) stack.push(...(upstream.blockedBy ?? []))
      }
      reach.set(task.id, seen)
    }
    const warnings: string[] = []
    for (let i = 0; i < tasks.length; i++) {
      const a = tasks[i]!
      if (a.writes === undefined || a.writes.length === 0) continue
      const aScopes = a.writes.map(norm)
      for (let j = i + 1; j < tasks.length; j++) {
        const b = tasks[j]!
        if (b.writes === undefined || b.writes.length === 0) continue
        if (reach.get(a.id)?.has(b.id) || reach.get(b.id)?.has(a.id)) continue
        const bScopes = b.writes.map(norm)
        let emitted = false
        for (const x of aScopes) {
          for (const y of bScopes) {
            if (x === y) {
              warnings.push(`tasks "${a.id}" and "${b.id}" may run concurrently and both declare write scope over "${x}" — consider blockedBy or narrower scopes`)
              emitted = true
            } else if (isBroad(y) && encloses(y, x)) {
              warnings.push(`task "${b.id}" claims the broad scope "${y}", which contains "${x}" owned by "${a.id}" — they may edit the same files concurrently; narrow the scope or serialise with blockedBy`)
              emitted = true
            } else if (isBroad(x) && encloses(x, y)) {
              warnings.push(`task "${a.id}" claims the broad scope "${x}", which contains "${y}" owned by "${b.id}" — they may edit the same files concurrently; narrow the scope or serialise with blockedBy`)
              emitted = true
            }
            if (emitted) break
          }
          if (emitted) break
        }
        if (warnings.length >= 5) return warnings
      }
    }
    return warnings
  }

  dispatch(input: DispatchInput, parent: Agent | undefined): DispatchResult {
    const tasks: TaskSpec[] = input.tasks
    if (tasks.length === 0) throw new Error('a run needs at least one task')
    const dag = validateDag(tasks)
    if (!dag.valid) throw new Error(`invalid task DAG: ${dag.errors.join('; ')}`)
    const known = Object.keys(this.duty.get().roles)
    const unknownRoles = [...new Set(tasks.map((t) => t.role).filter((r) => !known.includes(r)))]
    if (unknownRoles.length > 0) throw new Error(`unknown roles ${unknownRoles.join(', ')} — known: ${known.join(', ')}`)

    const captured = captureDispatchContext(parent)
    captured.authority = captureAuthority(this.ctx, parent, captured.cwd)
    const notices: string[] = []

    // P1: one-run-per-goal guard. A workspace with an active sibling run is a
    // governance smell — parallel workstreams belong in ONE DAG. Warn by
    // default; 'block' rejects; 'off' (and unrecognized values normalize to
    // 'warn', so a bad config value can never disable the guard silently...
    // except 'off' itself) does nothing.
    const policy = this.swarmConfig.workspaceRunPolicy
    if (policy !== 'off' && captured.cwd !== undefined) {
      const norm = normalizePath(captured.cwd)
      const siblings = [...this.view().runs.values()].filter((r) =>
        (r.status === 'planning' || r.status === 'running' || r.status === 'paused')
        && r.dispatch?.cwd !== undefined && normalizePath(r.dispatch.cwd) === norm)
      if (siblings.length > 0) {
        const overlap = this.crossRunWriteOverlap(tasks, siblings.map((s) => s.id))
        const message = `run ${siblings[0]!.id} ("${siblings[0]!.title}") is already active in this workspace`
          + (overlap !== undefined ? ` and both declare writes over "${overlap}"` : '')
          + ' — parallel workstreams belong in ONE run. If the sibling is stalled, use swarm_interrupt on its stuck task '
          + '(or abort the sibling run) before endorsing this one; otherwise consolidate into it.'
        if (policy === 'block') {
          throw new Error(`workspace already has an active run: ${message}`)
        }
        notices.push(message)
      }
    }

    // Hard limit: ONE active run per chat session. Sequential runs in the same
    // conversation must wait for the current run to finish — the dispatcher
    // calls swarm_wait on the active run, gets the completion notification,
    // then dispatches the next one. This prevents accidental parallel dispatches
    // that duplicate work or conflict on files.
    if (captured.sessionId !== undefined) {
      const activeFromSession = [...this.view().runs.values()].find((r) =>
        (r.status === 'planning' || r.status === 'running' || r.status === 'paused')
        && r.dispatch?.sessionId === captured.sessionId)
      if (activeFromSession !== undefined) {
        throw new Error(
          `this chat already has an active swarm run: ${activeFromSession.id} ("${activeFromSession.title}") [${activeFromSession.status}] — `
          + `call swarm_wait({ runId: "${activeFromSession.id}" }) until it completes, then dispatch your next run. `
          + 'If the run is stalled, use swarm_interrupt on its stuck task or abort it from the dashboard first.',
        )
      }
    }

    // P2: mandatory architect review. When enabled and the DAG has no architect
    // task, an architect-review root is injected and every dispatched task is
    // gated behind it. Injection can never throw: a duty table without the
    // architect role or a DAG that fails validation degrades to a notice.
    const wantsReview = input.architectReview ?? this.swarmConfig.requireArchitectReview
    let effectiveTasks = tasks
    let reviewPlanFile: string | undefined
    if (wantsReview && !tasks.some((t) => t.role === 'architect')) {
      // Uniquify the injected id: a dispatched task may already own the name
      // 'architect-review' — the review must still happen, under a fresh id.
      let reviewId = 'architect-review'
      for (let n = 2; tasks.some((t) => t.id === reviewId); n += 1) reviewId = `architect-review-${n}`
      // Run-specific plan file: parallel runs in the same workspace each get
      // their own plan artifact instead of overwriting each other's PLAN.md.
      const preRunId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      reviewPlanFile = `PLAN-${preRunId}.md`
      const injectedDag: TaskSpec[] = [
        {
          id: reviewId,
          subject: 'Review and refine the proposed plan',
          description: architectReviewPrompt(input.title, input.spec, tasks, reviewPlanFile),
          role: 'architect',
          evidence: { files: [reviewPlanFile] },
        },
        ...tasks.map((t) => ({ ...t, blockedBy: [reviewId, ...(t.blockedBy ?? [])] })),
      ]
      const injectedKnown = [...new Set(injectedDag.map((t) => t.role))].every((r) => known.includes(r))
      const injectedValid = validateDag(injectedDag).valid
      if (injectedKnown && injectedValid) {
        effectiveTasks = injectedDag
      } else {
        notices.push(`architect review skipped (${injectedKnown ? 'injected DAG failed validation' : 'the duty table has no architect role'})`)
      }
    }

    const writeWarnings = this.writeOverlapWarnings(effectiveTasks)
    const allWarnings = [...notices, ...writeWarnings]

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    this.events.append('run/created', {
      runId,
      data: {
        title: input.title,
        spec: input.spec,
        tasks: effectiveTasks,
        dispatch: captured,
      },
    })
    if (parent !== undefined) this.runParents.set(runId, parent)
    if (input.endorse === true && this.swarmConfig.requireManualEndorsement !== true) {
      this.events.append('run/endorsed', { runId })
    }
    this.scheduleTick()
    return {
      runId,
      status: this.view().runs.get(runId)?.status ?? 'planning',
      taskCount: effectiveTasks.length,
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    }
  }

  /** P1b: the first file both an incoming task and any active sibling run's task declare as written. */
  private crossRunWriteOverlap(incoming: TaskSpec[], siblingRunIds: string[]): string | undefined {
    const siblingWrites = new Set<string>()
    for (const task of this.view().tasks.values()) {
      if (!siblingRunIds.includes(task.runId)) continue
      for (const w of task.writes ?? []) siblingWrites.add(w.toLowerCase())
    }
    if (siblingWrites.size === 0) return undefined
    for (const task of incoming) {
      for (const w of task.writes ?? []) {
        if (siblingWrites.has(w.toLowerCase())) return w
      }
    }
    return undefined
  }

  endorse(runId: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    if (run.status !== 'planning' && run.status !== 'awaiting-endorsement') {
      throw new Error(`run ${runId} is ${run.status}; only unendorsed runs can be endorsed`)
    }
    this.events.append('run/endorsed', { runId })
  }

  abort(runId: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    for (const [key, flight] of this.inFlight) {
      if (flight.taskKey.startsWith(runId + '/')) {
        flight.controller.abort()
        this.inFlight.delete(key)
      }
    }
    this.events.append('run/aborted', { runId })
    this.releaseAnchor(runId)
  }

  /**
   * A8: relabel a run on the board. One append-only event; nothing else is
   * touched, and it deliberately works on a terminal run — the run you are done
   * with is exactly the one you want to rename.
   */
  renameRun(runId: string, title: string): string {
    if (this.view().runs.get(runId) === undefined) throw new Error(`unknown run ${runId}`)
    const next = title.trim()
    if (next.length === 0) throw new Error('title required')
    if (next.length > MAX_RUN_TITLE) throw new Error(`title too long (max ${MAX_RUN_TITLE} characters)`)
    this.events.append('run/renamed', { runId, data: { title: next } })
    return next
  }

  /**
   * A8: set how the board presents a run. `removed` is the recoverable recycle
   * bin (what the restore list reads); `purged` hides the run from the board AND
   * that list. Nothing is deleted either way — no files, no storage, no
   * event-log entries, no session data — and the run stays in `view()`, so
   * scheduling, recovery and history are untouched. Deliberately unrestricted by
   * run status, so a stuck or noisy run can be cleared out of the way without
   * aborting it.
   */
  setRunBoardState(runId: string, state: string): void {
    if (state !== 'visible' && state !== 'removed' && state !== 'purged') {
      throw new Error(`state must be visible, removed or purged (got ${JSON.stringify(state)})`)
    }
    if (this.view().runs.get(runId) === undefined) throw new Error(`unknown run ${runId}`)
    this.events.append('run/board-state', { runId, data: { state } })
  }

  /**
   * J10 durable handoff: adopt a completed task report that survived a child death.
   *
   * A host restart can kill a child between finishing its work and the dispatcher
   * recording it. Production showed exactly this: "Code landed on disk before the
   * host restart; verified present in ..." for four tasks, and a reviewer report
   * "written before the crash" — five completed deliverables were thrown away and
   * the run reported failure. The child now writes `.dsh-swarm/task-<id>.json` as
   * its final action; if that file is present and well-formed when the child dies,
   * the work is real and is recorded as completed instead of failed.
   *
   * J22 narrowed "present" to "written during the live attempt": the path is shared
   * across runs and attempts, so presence alone also described files this attempt
   * had nothing to do with.
   *
   * Returns the summary to record, or undefined when there is nothing to adopt.
   */
  private adoptTaskReport(runId: string, task: Task): string | undefined {
    const cwd = this.view().runs.get(runId)?.dispatch?.cwd
    if (cwd === undefined) return undefined
    const current = this.view().tasks.get(taskKeyOf(task)) ?? task
    const strict = current.attemptProtocol === 2
    if (strict && (current.attemptId === undefined || current.attemptRevoked === true)) return undefined
    const reportPath = join(cwd, strict ? taskReportRelPath(task.id, runId, current.attemptId) : taskReportRelPath(task.id))
    let raw: string
    let fd: number | undefined
    try {
      fd = openSync(reportPath, 'r')
      const info = fstatSync(fd)
      const limit = 256 * 1024
      if (!info.isFile() || info.size === 0 || info.size > limit) return undefined
      // Legacy compatibility only. New reports use exact run/attempt/task identities.
      if (!strict && current.attemptStartedAt !== undefined && info.mtimeMs < current.attemptStartedAt) return undefined
      // Bound the READ too: an attacker can grow a file after the size check.
      const buffer = Buffer.alloc(limit + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const n = readSync(fd, buffer, bytes, buffer.length - bytes, bytes)
        if (n === 0) break
        bytes += n
      }
      if (bytes === 0 || bytes > limit) return undefined
      raw = buffer.toString('utf8', 0, bytes)
    } catch { return undefined }
    finally { if (fd !== undefined) closeSync(fd) }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return undefined }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    // A report is a recovery HINT. Evidence and review still run in finalizeTask.
    if (record.status !== 'completed') return undefined
    if (strict) {
      if (record.runId !== runId || record.attemptId !== current.attemptId || record.taskId !== task.id) return undefined
    } else if ((record.taskId !== undefined && record.taskId !== task.id)
      || (record.runId !== undefined && record.runId !== runId)) return undefined
    const summary = typeof record.summary === 'string' && record.summary.trim().length > 0
      ? record.summary.trim().slice(0, 32768)
      : 'finished work reported on disk; recovered through evidence and review gates'
    this.ctx.logger('swarm').info('correlated recovery hint for %s/%s; checking evidence and review', runId, task.id)
    return summary
  }

  /**
   * Heartbeat from a task agent, authenticated by its child session id.
   *
   * The task is resolved FROM the authenticated session, so `taskId` is optional:
   * requiring the model to pass it produced 33 `missing required property "taskId"`
   * tool errors across production runs, all of which the service could answer for
   * itself. A supplied id is still validated, so an agent can never report against
   * a task it does not own.
   */
  report(childAgentId: string, taskId: string | undefined, note: string): string {
    const entry = this.sessionTasks.get(childAgentId)
    if (entry === undefined) throw new Error('this agent is not a tracked swarm task agent')
    const task = this.view().tasks.get(entry.taskKey)
    if (task === undefined) throw new Error('this agent has no task assigned (the task may have been reclaimed)')
    if (taskId !== undefined && taskId.length > 0 && task.id !== taskId) {
      throw new Error(`task ${taskId} is not assigned to this agent (this agent owns "${task.id}")`)
    }
    // J19: a superseded member may not post notes against the live task — its
    // progress describes work that has been discarded, and the board would show it
    // as if the current attempt had done it.
    const mine = this.liveAttempts.get(entry.taskKey)
    const flight = this.inFlight.get(entry.taskKey)
    if (task.attemptRevoked === true || task.attemptId !== entry.attemptId
      || (mine !== undefined && task.attemptId !== undefined && task.attemptId !== mine)
      || (task.attemptProtocol === 2 && (flight === undefined || flight.childSessionId !== childAgentId || !this.currentFlight(task.runId, task.id, flight, flight.phase === 'review')))) {
      throw new Error('this attempt has been superseded — the task was retried or reassigned, so your result is no longer accepted')
    }
    if (typeof note !== 'string' || note.trim().length === 0 || note.length > 8192) throw new Error('progress note must contain 1–8192 characters')
    this.events.append('task/heartbeat', {
      runId: task.runId, taskId: task.id,
      data: { ...(entry.attemptId !== undefined ? { attemptId: entry.attemptId } : {}), note },
    })
    // Item 7: progress re-arms the child's no-progress window — a working child
    // is never reclaimed for elapsed time.
    if (flight !== undefined && flight.attemptId === entry.attemptId) flight.resetSpawnTimer?.()
    return 'ok'
  }

  setDutyTable(next: DutyTable, actor: string): DutyTable {
    if (next.version !== 1) throw new Error('duty table version must be 1')
    if (next.roles === undefined || typeof next.roles !== 'object') throw new Error('duty table needs a roles object')
    for (const [id, role] of Object.entries(next.roles)) {
      if (role.id !== id) throw new Error(`role ${id} has mismatched id ${String(role.id)}`)
      if (!Array.isArray(role.fallbacks)) throw new Error(`role ${id} needs a fallbacks array`)
    }
    // B-config: a toolFilter naming a tool this host does not expose is a typo,
    // and until now it was only discovered at dispatch — where J15 silently
    // DROPS the unknown name with a log warning, so the filter quietly stops
    // doing what its author intended. Production shape: a filter naming
    // "modlens" (the tool is `modlens_read_image`) — 27 task-attempts died
    // across 3 runs before J15 made it a warning. The dashboard save path can
    // do better: reject the typo at the moment it is made, naming it. Fail-open
    // by design — when the host's tool list cannot be read (or is empty), the
    // save is accepted unchanged; the runtime J15 warning stays the last line
    // of defense and dispatch behavior is untouched.
    const knownTools = this.restrictableToolNames()
    if (knownTools !== undefined && knownTools.size > 0) {
      const unknown: string[] = []
      for (const [id, role] of Object.entries(next.roles)) {
        for (const list of ['deny', 'allow'] as const) {
          for (const name of role.toolFilter?.[list] ?? []) {
            if (!knownTools.has(name)) unknown.push(`"${name}" (role "${id}", ${list} list)`)
          }
        }
      }
      if (unknown.length > 0) {
        const sample = [...knownTools].slice(0, 8).join(', ')
        throw new Error(
          `duty table rejected: toolFilter names ${unknown.length === 1 ? 'an unknown tool' : 'unknown tools'} `
          + `${unknown.join(', ')}. This host exposes ${knownTools.size} restrictable tools `
          + `(e.g. ${sample}). At dispatch an unknown name is silently dropped, so this filter `
          + 'would not do what it says — fix the name or remove it from the filter.',
        )
      }
    }
    const saved = this.duty.save({ ...next, override: next.override })
    this.events.append('duty/updated', { data: { actor } })
    return saved
  }

  /**
   * Resolve the workspace (cwd) a session belongs to: the live agent's
   * session header first, then the persisted session log's durable header.
   * Undefined = unresolvable (the caller falls back to the unfiltered view).
   */
  resolveSessionWorkspace(sessionId: string): string | undefined {
    if (sessionId.length === 0) return undefined
    try {
      const agents = this.ctx.get('agents') as AgentsLike | undefined
      const live = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
      const liveCwd = (live as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd
      if (typeof liveCwd === 'string' && liveCwd.length > 0) return liveCwd
    } catch { /* live lookup unavailable — fall through to the durable header */ }
    try {
      // $DSH_HOME/sessions/<workspace-dir>/<sessionId>/session.jsonl.zstd
      const sessionsRoot = join(dirname(dirname(this.swarmConfig.storageDir)), 'sessions')
      for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const logPath = join(sessionsRoot, entry.name, sessionId, 'session.jsonl.zstd')
        if (!existsSync(logPath)) continue
        return decodeSessionHeaderCwd(logPath)
      }
    } catch { /* best effort */ }
    return undefined
  }

  /**
   * P-A/B2: deliver one swarm notice to a dispatching session, on the channel
   * its CURRENT status calls for — the single path both notifications share.
   *
   * `followup()` is `send(..., 'next-turn', true)`: on a BUSY driver the wake is
   * never latched (live drivers claim queued work themselves), so the notice is
   * only claimed once the running turn fully ends — and a turn that ends by
   * abort/error replays only a LATCHED wake, stranding the notice in the inbox
   * until a human clicks Steer. Production delivered exactly that: a
   * completed-run notice sat in the queue dock behind the dispatching turn,
   * invisible to the model. The host's own producers (subagent settlement,
   * background jobs) avoid it the same way, and so does this: a busy target is
   * `steer`ed — consumed at the very next step, and it still WAKES if the driver
   * retires between the status read and the send — while an idle one gets an
   * ordinary turn. `inject` is the no-wake fallback when a host has no `steer`;
   * an unknown status keeps plain `followup`, the always-delivered option on a
   * host too old to report a status.
   *
   * The source is a producer-owned swarm NOTICE, never generic `plugin` (which
   * native V4 persistence rejects) or `user` (which goal / skill-scan /
   * wake-budget policy treats as human authorization). Its `notice` form keeps
   * the collapsed transcript presentation while still reaching the model like
   * any injected context.
   *
   * @returns whether the notice was handed to a live session.
   */
  private pushNotice(sessionId: string, text: string, summary: string): boolean {
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    const live = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (live === undefined) return false
    const message = createUserMessage({
      source: {
        kind: 'plugin:dsh-swarm-orchestrator',
        form: 'notice',
        summary: boundContextSummary(summary),
      },
      content: [{ type: 'text', text }],
    })
    if (live.status === 'running') {
      if (typeof live.steer === 'function') {
        live.steer(message)
        return true
      }
      if (typeof live.inject === 'function') {
        live.inject(message)
        return true
      }
    }
    if (typeof live.followup === 'function') {
      live.followup(message)
      return true
    }
    return false
  }

  /**
   * P-A: push the run's terminal result into the dispatching chat's inbox, so
   * the dispatcher learns the outcome exactly once, at the moment it's true —
   * no polling, no optimistic summaries. Only live sessions are reached: a chat
   * that was closed is never disturbed. Failures are contained — a notification
   * problem must never affect the run.
   */
  private notifyDispatchSession(runId: string, outcome: 'completed' | 'failed' | 'paused', detail: string): void {
    if (this.swarmConfig.notifyDispatchSession !== true) return
    try {
      const run = this.view().runs.get(runId)
      const sessionId = run?.dispatch?.sessionId
      if (sessionId === undefined) return
      const title = run?.title ?? runId
      const text = `[swarm auto-notification] Swarm run "${title}" (${runId}) ${outcome}: ${detail}. `
        + 'Briefly relay this to the user. Do not start new work unless the user asks — the live board is on the Swarm tab.'
      this.pushNotice(sessionId, text, `swarm run ${outcome}: ${title}`)
    } catch (err) {
      this.ctx.logger('swarm').warn('completion push for run %s failed (contained): %s', runId, String(err))
    }
  }

  /** B2: the wait episode each task is currently in — the seq of the event that started it. */
  private readonly humanWaitEpisode = new Map<string, number>()
  /** B2: the episode each waiting item was already pinged for, as `runId/taskId` -> episode seq. */
  private readonly humanWaitPinged = new Map<string, number>()
  /** B2: coalescing timer — one aggregated ping per burst of blocks, not one per task. */
  private humanWaitTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * B2: something just started waiting on a human (a task blocked with
   * `human: true`, or a task parked in a `reviewGate: 'human'` verdict). Arm a
   * short coalescing window so a burst produces ONE aggregated ping — the
   * production incident had eight tasks block at once, and eight pings would be
   * their own alarm fatigue. Items joining inside the window are picked up when
   * it fires; a later join arms a fresh window. Each owner's waits are delivered
   * only to their captured dispatching session, never another owner's chat.
   * Only successfully delivered episodes are deduplicated.
   *
   * A run merely awaiting endorsement does NOT ping: the creation-time tool
   * result already tells the dispatching agent "awaiting human endorsement on
   * the Swarm dashboard", so a second channel would be noise, not signal.
   */
  private scheduleHumanWaitingNotify(runId: string): void {
    if (this.swarmConfig.notifyDispatchSession !== true) return
    if (this.humanWaitTimer !== undefined) return
    this.humanWaitTimer = setTimeout(() => {
      this.humanWaitTimer = undefined
      this.flushHumanWaiting(runId)
    }, HUMAN_WAIT_NOTIFY_COALESCE_MS)
    this.humanWaitTimer.unref?.()
  }

  /**
   * B2: send one aggregated attention ping listing EVERYTHING currently waiting
   * on a human. An item counts as fresh when its wait EPISODE (the block or
   * review-start event that began it) is not the one already pinged — so a task
   * that resolves and blocks again pings again, while re-flushing an unchanged
   * set stays silent. `humanReview` is sticky in the projection (it marks "has
   * ever waited"), so a review-gated task counts as waiting only while it is
   * still `reviewing`, and a blocked task counts while it is still `blocked`.
   * Failures are contained exactly like the completion push.
   */
  private flushHumanWaiting(_triggerRunId: string): void {
    if (this.swarmConfig.notifyDispatchSession !== true) return
    const state = this.view()
    const owners = new Map<string, Array<{ task: Task; episode: number }>>()
    for (const task of state.tasks.values()) {
      if (task.status !== 'blocked' && !(task.humanReview === true && task.status === 'reviewing')) continue
      const run = state.runs.get(task.runId)
      if (run?.status === 'aborted' || run?.status === 'completed') continue
      const owner = run?.dispatch?.sessionId
      if (owner === undefined) continue
      const items = owners.get(owner) ?? []
      items.push({ task, episode: this.humanWaitEpisode.get(taskKeyOf(task)) ?? -1 })
      owners.set(owner, items)
    }
    for (const [owner, items] of owners) {
      if (!items.some(({ task, episode }) => this.humanWaitPinged.get(taskKeyOf(task)) !== episode)) continue
      try {
        const brief = (s: string): string => s.length <= 260 ? s : `${s.slice(0, 90)} … ${s.slice(-160)}`
        const lines = items.map(({ task }) => task.status === 'blocked'
          ? `- run ${task.runId} task "${task.id}": ${brief(String(task.blockedReason ?? 'blocked — a human decides'))}`
          : `- run ${task.runId} task "${task.id}": awaiting your review verdict (reviewGate: human)`)
        const text = `[swarm attention] ${items.length} item${items.length === 1 ? '' : 's'} waiting on a human decision:\n${lines.join('\n')}\n`
          + 'Resolution: swarm_review (approve/reject — human review gates), swarm_retry (requeue a blocked task), '
          + 'swarm_complete (accept finished work despite the evidence artefact), or the dashboard buttons. '
          + 'You may surface this decision to the user as a multiple-choice prompt. '
          + 'Do not start new work unless the user asks — the live board is on the Swarm tab.'
        // A stranded attention ping is worse than a stranded completion notice:
        // it means a human decision never reaches the chat. pushNotice steers a
        // busy owner so the ping is seen at the next step, not after the turn.
        if (!this.pushNotice(owner, text, `swarm attention: ${items.length} waiting on a human`)) continue
        // Only acknowledge this owner's captured episodes AFTER successful delivery.
        // Missing/throwing sessions and other owners retain their undelivered items.
        for (const { task, episode } of items) this.humanWaitPinged.set(taskKeyOf(task), episode)
      } catch (err) {
        this.ctx.logger('swarm').warn('human-wait push to %s failed (contained): %s', owner, String(err))
      }
    }
  }

  snapshot(filter?: { session?: string; cwd?: string }): BoardSnapshot {
    const state = this.view()
    let effective = state
    let scopeCwd: string | undefined
    let scopeUnresolvable = false
    if (filter?.cwd !== undefined || filter?.session !== undefined) {
      const cwd = filter?.cwd !== undefined
        ? filter.cwd
        : (filter?.session !== undefined ? this.resolveSessionWorkspace(filter.session) : undefined)
      if (cwd === undefined) {
        // Couldn't tie the request to a workspace: serve the unfiltered board
        // and say so, rather than showing an empty screen.
        scopeUnresolvable = true
      } else {
        scopeCwd = cwd
        const norm = normalizePath(cwd)
        const keep = new Set<string>()
        for (const run of state.runs.values()) {
          const runCwd = run.dispatch?.cwd
          // Runs without a recorded workspace (legacy) stay in the global view only.
          if (runCwd !== undefined && normalizePath(runCwd) === norm) keep.add(run.id)
        }
        effective = {
          runs: new Map([...state.runs.entries()].filter(([id]) => keep.has(id))),
          tasks: new Map([...state.tasks.entries()].filter(([, t]) => keep.has(t.runId))),
        }
      }
    }
    // A8: the board state is a VIEW concern. Hide removed AND purged runs, and
    // their tasks with them, so nothing is orphaned in the task columns; this
    // single filter is what the board, the badge and `swarm_status` all read, so
    // none of them can disagree. The unfiltered state stays reachable through
    // view(), which is where every scheduling decision reads it from — so hiding
    // a run can never affect dispatch, recovery or its history.
    const visibleRuns = new Map(
      [...effective.runs].filter(([, r]) => r.boardState !== 'removed' && r.boardState !== 'purged'),
    )
    const visible = {
      runs: visibleRuns,
      tasks: new Map([...effective.tasks].filter(([, task]) => visibleRuns.has(task.runId))),
    }
    // The recycle bin: `removed` only. A `purged` run is deliberately absent from
    // this list too — out of sight everywhere, yet still in the log and in view().
    const removedRuns = [...effective.runs.values()]
      .filter((r) => r.boardState === 'removed')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_REMOVED_RUNS)
      .map((r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.createdAt }))
    const effectiveRuntime = {
      maxConcurrent: this.rt('maxConcurrent'),
      maxTotalConcurrentAgents: this.rt('maxTotalConcurrentAgents'),
      spawnStaggerMs: this.rt('spawnStaggerMs'),
      retryBackoffBaseMs: this.rt('retryBackoffBaseMs'),
      circuitBreakerThreshold: this.rt('circuitBreakerThreshold'),
      circuitBreakerCooldownMs: this.rt('circuitBreakerCooldownMs'),
      nudgeAfterMinutes: this.rt('nudgeAfterMinutes'),
      staleTimeoutSeconds: this.rt('staleTimeoutSeconds'),
      spawnTimeoutSeconds: this.rt('spawnTimeoutSeconds'),
    }
    return buildBoardSnapshot(visible, this.duty.get(), this.events.seq, PLUGIN_VERSION, { cwd: scopeCwd, unresolvable: scopeUnresolvable }, effectiveRuntime, removedRuns)
  }

  statusText(runId?: string): string {
    const snap = this.snapshot()
    const runs = runId !== undefined ? snap.runs.filter((r) => r.id === runId) : snap.runs
    if (runs.length === 0) return runId !== undefined ? `unknown run ${runId}` : 'no swarm runs yet'
    const lines: string[] = []
    for (const run of runs) {
      const tasks = snap.tasks.filter((t) => t.runId === run.id)
      const byStatus = new Map<string, number>()
      for (const task of tasks) byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1)
      lines.push(`${run.id} [${run.status}] "${run.title}" — ${tasks.length} tasks: ${[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(', ')}`)
      for (const task of tasks) {
        lines.push(`  - ${task.id} [${task.status}] (${task.role}${task.agent?.model !== undefined ? ` @ ${task.agent.provider ?? ''}/${task.agent.model}` : ''})${task.lastNote !== undefined ? ` — ${String(task.lastNote).slice(0, 160)}` : ''}`)
      }
    }
    return lines.join('\n')
  }

  // ── dispatcher ───────────────────────────────────────────────────────────

  /**
   * The live agent every task-agent spawn for a run is routed through.
   *
   * Spawning through the DISPATCHING agent couples the run's lifetime to that
   * agent's context: when its turn ends and its session unloads (one-shot
   * subagent callers) or the session closes, every later spawn of the run dies
   * with "cannot create effect on inactive context". A run must outlive its
   * dispatcher, so each run gets a service-owned idle ANCHOR agent created on
   * first launch.
   *
   * The anchor joins the dispatch context captured at dispatch() — the
   * dispatcher's preset (falling back to the deployment default preset) and
   * model route — because a bare factory agent joins NO preset, and in a
   * rostered deployment its children then fail prompt assembly ("addressed a
   * model without joining any agent preset") and inherit no model route. The
   * durable meta records the same preset so a cold resume rebuilds the same
   * world. Hosts without an agents factory (unit tests) fall back to the
   * dispatching agent.
   */
  private async ensureAnchor(runId: string): Promise<Agent | undefined> {
    const existing = this.runAnchors.get(runId)
    if (existing !== undefined) return existing.agent
    const pending = this.anchorPromises.get(runId)
    if (pending !== undefined) return pending
    const captured = this.view().runs.get(runId)?.dispatch
    if (!validAuthority(captured?.authority)) throw new Error('run has no captured permissions; resume explicitly or redispatch from the owning session')
    const authority = captured.authority
    const create = async (): Promise<Agent | undefined> => {
      const agents = this.ctx.get('agents') as AgentsLike | undefined
      if (agents === undefined) return this.runParents.get(runId)
      const handle = await agents.create({
        sessionId: SessionId(randomUUID()),
        meta: {
          ...(captured.cwd !== undefined ? { cwd: captured.cwd } : {}),
          delegationDepth: 0,
          ...(captured.presetId !== undefined ? { agentPreset: captured.presetId } : {}),
        },
        ...(captured.provider !== undefined && captured.model !== undefined ? { agentOptions: { provider: captured.provider, model: captured.model } } : {}),
        setup: async (anchorCtx, anchor) => {
          // Factory setup runs before publication. Presets and the FIRST child
          // therefore see the dispatcher's ceiling, never deployment defaults.
          appendDelegatedPolicyOverrides(anchor.session, authority.delegated)
          const presets = (anchorCtx as { get(name: string): unknown }).get('agentPresets') as PresetsLike | undefined
          if (presets !== undefined) await presets.mount(anchorCtx, captured.presetId)
        },
      })
      try {
        if (this.disposed || this.view().runs.get(runId)?.status !== 'running') {
          await handle.dispose()
          return undefined
        }
        this.runAnchors.set(runId, handle)
        this.ctx.logger('swarm').info('run %s anchored to idle agent %s', runId, String(handle.agent.id))
        return handle.agent
      } catch (err) {
        await handle.dispose()
        throw err
      }
    }
    const promise = create()
    this.anchorPromises.set(runId, promise)
    try { return await promise }
    finally { if (this.anchorPromises.get(runId) === promise) this.anchorPromises.delete(runId) }
  }

  /**
   * Model candidate chain for a role, with the run's captured route filling
   * every "inherit the default" (empty) entry. Undefined when no route at all
   * is resolvable — the caller then fails the task with an actionable reason.
   */
  private resolveCandidates(run: Run, roleId: string, task?: Task): Array<{ provider: string; model: string }> | undefined {
    // K4: an explicit per-task model override leads the whole chain.
    if (task?.model !== undefined && task.model.provider.length > 0 && task.model.model.length > 0) {
      const override: ModelRef = { provider: task.model.provider, model: task.model.model }
      const rest = this.duty.resolveChain(roleId).filter((c) => !(c.provider === override.provider && c.model === override.model))
      return [override, ...rest]
    }
    const fallback = run.dispatch?.provider !== undefined && run.dispatch?.model !== undefined
      ? { provider: run.dispatch.provider, model: run.dispatch.model }
      : undefined
    const chain = this.duty.resolveChain(roleId).map((candidate) =>
      (candidate.provider.length === 0 || candidate.model.length === 0) && fallback !== undefined
        ? fallback
        : candidate,
    )
    // An unpinned role resolves to an EMPTY chain ("inherit the deployment
    // default") — with a captured run route that default is the route.
    if (chain.length === 0 && fallback !== undefined) return [fallback]
    const first = chain[0]
    if (first === undefined || first.provider.length === 0 || first.model.length === 0) return undefined
    return chain
  }

  /**
   * J15: validate a role's toolFilter against the tool names this host actually
   * exposes, dropping unknowns instead of letting `tools.restrict()` throw.
   *
   * The throw happens inside child creation, so an unknown name is not a
   * per-task failure — it fails the entire run at spawn. Production hit this
   * with a filter naming "modlens" when the tool is `modlens_read_image`:
   * 10/10 tasks failed across 3 waves. A configuration typo must be a warning.
   *
   * Returns the filter to apply, or undefined when nothing valid remains.
   */
  private sanitizeToolFilter(role: RoleConfig): { deny?: string[]; allow?: string[] } | undefined {
    return this.toolFilterFor(role.id)
  }

  /**
   * J15: the toolFilter actually applied for a role, resolved against the host's
   * real tool names. Returns undefined when nothing valid remains.
   */
  toolFilterFor(roleId: string): { deny?: string[]; allow?: string[] } | undefined {
    const role = this.duty.role(roleId)
    if (role === undefined) return undefined
    const requested = role.toolFilter
    if (requested === undefined) return undefined
    const { filter, dropped, refusal } = sanitizeToolNames(requested, this.restrictableToolNames())
    for (const name of dropped) {
      this.ctx.logger('swarm').warn(
        'role %s toolFilter names unknown tool "%s" — dropped (this host does not expose it)',
        roleId, name,
      )
    }
    if (refusal !== undefined) this.ctx.logger('swarm').warn('role %s toolFilter refused: %s', roleId, refusal)
    return filter
  }

  /** Best-effort read of the host's restrictable global tool names. */
  private restrictableToolNames(): Set<string> | undefined {
    try {
      const tools = this.ctx.get('tools') as unknown as
        | { restrictableNames?: Set<string>; view?: (scope?: unknown) => { restrictableNames?: Set<string> } }
        | undefined
      if (tools === undefined) return undefined
      const direct = tools.restrictableNames
      if (direct instanceof Set) return direct as Set<string>
      const view = tools.view?.()
      const fromView = view?.restrictableNames
      if (fromView instanceof Set) return fromView as Set<string>
      return undefined
    } catch {
      return undefined
    }
  }

  /** Dispose a run's anchor once the run reaches a terminal status. */
  private releaseAnchor(runId: string): void {
    if (this.countRunHolders(runId) > 0) return
    const handle = this.runAnchors.get(runId)
    if (handle === undefined) return
    this.runAnchors.delete(runId)
    void handle.dispose().catch((err) => {
      this.ctx.logger('swarm').warn('anchor for run %s failed to dispose: %s', runId, String(err))
    })
  }

  /** K1: the launch capacity this run currently earns (shrinks on provider pain, recovers on success). */
  private effectiveConcurrency(runId: string): number {
    const adaptive = this.adaptiveLimits.get(runId)
    const base = this.swarmConfig.adaptiveConcurrency
      ? Math.min(this.rt('maxConcurrent'), adaptive ?? this.rt('maxConcurrent'))
      : this.rt('maxConcurrent')
    return Math.max(1, base)
  }

  /** Count all running/dispatching/reviewing tasks across ALL runs (the global agent footprint). */
  private countGlobalRunning(): number {
    return this.holders.size
  }

  private countRunHolders(runId: string): number {
    return [...this.holders].filter((flight) => flight.taskKey.startsWith(runId + '/')).length
  }

  private spawnToolFilter(role: RoleConfig): { allow?: string[]; deny?: string[] } | undefined {
    const { filter, refusal, dropped } = sanitizeToolNames(role.toolFilter, this.restrictableToolNames())
    if (refusal !== undefined) throw new Error(refusal)
    if (dropped.length > 0) this.ctx.logger('swarm').warn('role %s allow list narrowed: unknown tools %s', role.id, dropped.join(', '))
    return filter
  }

  private dependencyHandoffs(run: Run, task: Task): string[] {
    return (task.blockedBy ?? []).slice(0, 64).map((id) => {
      const dependency = this.view().tasks.get(run.id + '/' + id)
      return `${id}: ${(dependency?.summary ?? dependency?.lastNote ?? '(no summary)').slice(0, 600)}`
    })
  }

  private shrinkConcurrency(runId: string): void {
    if (!this.swarmConfig.adaptiveConcurrency) return
    const next = Math.max(1, this.effectiveConcurrency(runId) - 1)
    this.adaptiveLimits.set(runId, next)
  }

  private growConcurrency(runId: string): void {
    if (!this.swarmConfig.adaptiveConcurrency) return
    if (this.effectiveConcurrency(runId) < this.rt('maxConcurrent')) {
      this.adaptiveLimits.set(runId, this.effectiveConcurrency(runId) + 1)
    } else {
      this.adaptiveLimits.delete(runId)
    }
  }

  /**
   * A1: the effort ladder for this attempt, head first — the pin the attempt
   * uses, then the rungs a retry of the SAME model may try before the task
   * rotates models, ending at `undefined` (no pin).
   *
   * The ladder must never be a dead end. It used to be the configured entries
   * only, with the index clamped to the last one, so a role with the primary
   * unset and `effortFallbacks: ['max']` collapsed to `['max']` and pinned `max`
   * on EVERY attempt and EVERY model — the opposite of a fallback. Production
   * evidence (seq 3913-3915): attempt 1 pinned `max` on `xiaomi/mimo-v2.6-pro`,
   * the child died 42 ms after `task/agent-started` with stopReason `error` and
   * no diagnostic, and the generic reason "child stopped: error" never matched
   * the J18 unsupported-effort signature, so the dispatcher rotated models
   * instead of dropping the pin. `undefined` is therefore always available as the
   * final rung: an exhausted ladder degrades to the provider default rather than
   * re-pinning a value the model has already refused.
   */
  private effortRungs(role: RoleConfig, attemptNumber: number): Array<string | undefined> {
    const configured = [role.reasoningEffort, ...(role.effortFallbacks ?? [])]
      .filter((e): e is string => typeof e === 'string' && e.length > 0)
    const start = Math.min(Math.max(0, attemptNumber - 1), configured.length)
    const rungs: Array<string | undefined> = []
    for (const rung of configured.slice(start)) {
      // Consecutive duplicates would burn a child on an identical request.
      if (rungs.length > 0 && rungs[rungs.length - 1] === rung) continue
      rungs.push(rung)
    }
    if (rungs.length === 0 || rungs[rungs.length - 1] !== undefined) rungs.push(undefined)
    return rungs
  }

  /**
   * J21: the deployment's declared effort support. Read once, then cached.
   *
   * Two sources, in order (2026-09-26): the LIVE settings service first — DSH moved
   * the document out of `$DSH_HOME/settings.yaml` into the active profile and renamed
   * the old file (`settings.yaml.imported`), which is exactly why this check went
   * blind and validated nothing while still looking healthy. `ctx.settings.describe()`
   * reports each profile entry with its live Config value, so it is the authoritative
   * source now. The legacy file remains as a fallback for installs that predate the
   * service; the renamed `.imported` document is deliberately NOT a candidate — it is
   * a stale copy, and a verdict read from it would describe a deployment that no
   * longer exists.
   *
   * A source that declares nothing is skipped rather than trusted, and when NO source
   * declares anything the check is inactive — "nothing judged", never "everything
   * supported". That inactivity is now logged once (this method is cached), because
   * silence is how it went unnoticed in the first place.
   */
  private effortSupport(): EffortSupport | undefined {
    if (this.effortSupportRead) return this.effortSupportCache
    this.effortSupportRead = true

    // 1. Live settings service. Resolved structurally via ctx.get(), like the other
    //    optional services this plugin uses, so there is no host-package import.
    const serviceEntries: SettingsEntryValue[] = []
    let serviceLabel = 'settings service (absent)'
    const settings = this.ctx.get('settings') as
      { describe?: (options?: { redactSecrets?: boolean }) => unknown } | undefined
    if (settings !== undefined && typeof settings.describe === 'function') {
      serviceLabel = 'settings service'
      try {
        const described = settings.describe({ redactSecrets: true })
        if (Array.isArray(described)) {
          for (const descriptor of described) {
            const record = descriptor as { ns?: unknown; value?: unknown } | null
            if (record !== null && typeof record === 'object' && typeof record.ns === 'string') {
              serviceEntries.push({ ns: record.ns, value: record.value })
            }
          }
        }
      } catch {
        // An unreadable service is simply not a source; the file fallback still runs.
      }
    }

    // 2. Legacy file fallback.
    const files: EffortSourceFile[] = []
    try {
      const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
      for (const candidate of [join(home, 'settings.yaml'), join(homedir(), '.dsh', 'settings.yaml')]) {
        if (!existsSync(candidate)) continue
        try {
          files.push({ path: candidate, text: readFileSync(candidate, 'utf8') })
        } catch {
          // unreadable candidate: try the next one
        }
      }
    } catch {
      // no filesystem access: the service above already had its chance
    }

    const resolved = resolveEffortSupport({
      service: { label: serviceLabel, entries: serviceEntries.length > 0 ? serviceEntries : undefined },
      files,
    })
    this.effortSupportCache = resolved.support
    const log = this.ctx.logger('swarm')
    if (resolved.support === undefined) {
      log.warn(
        'effort preflight INACTIVE: no settings source declared any model (consulted: %s) — effort pins are NOT validated, so an unsupported pin will surface only as a dead child',
        resolved.consulted.join(', '),
      )
    } else {
      // Distinct models, not a sum: the default-model pair can put the same id in both
      // `supported` and `declaredWithoutMap` (the live deployment is exactly that case),
      // and an operator-facing count that double-counts a model is worse than no count.
      // "Known levels" covers a declared map and that proven pair alike; the map-less
      // count is the uncertainty the policy change accepts, and it is reported so the
      // number is never invisible.
      const read = new Set([
        ...resolved.support.supported,
        ...resolved.support.declaredWithoutMap,
        ...resolved.support.declaredLevels.keys(),
      ])
      log.info(
        'effort preflight active from %s (%d model(s) read, %d with known levels; %d declared without an effort map: pins left in place there — the adapter\'s catalog may still support them)',
        resolved.source ?? 'unknown',
        read.size,
        resolved.support.supported.size,
        resolved.support.declaredWithoutMap.size,
      )
    }
    return this.effortSupportCache
  }

  /**
   * J21 preflight: strip an effort pin the attempt's PRIMARY model cannot accept,
   * and surface why. The candidate chain itself is never filtered.
   *
   * The pin is applied by the agent/request waterfall at request time, so an
   * unaccepted pair was only discovered when the child's first request died with
   * UNSUPPORTED_REASONING_EFFORT — 41 ms after `task/agent-started` in the incident
   * that motivated this, and again at 94 ms with a different level, which is what
   * proved the value was never the problem. Stripping the pin BEFORE the spawn
   * avoids that wasted child, and the wasted retry, entirely.
   *
   * Why the primary decides: the request goes to the primary first, and the chain is
   * rotated per attempt (A6), so a rotated chain legitimately re-enables the pin on a
   * model that declares support. A FALLBACK that refuses the pin is not rung-retried
   * on itself — the rung retry re-runs the primary; a mid-chain refusal converges on
   * the next task attempt, where A6 rotation makes that model primary and this strip
   * applies.
   *
   * Why the candidate is NOT dropped: the pin is a preference, model diversity is
   * not. Dropping a candidate because of a pin loses a working model for the run.
   */
  private preflightEffort(
    roleId: string,
    candidates: Array<{ provider: string; model: string }>,
    effort: string | undefined,
  ): { candidates: Array<{ provider: string; model: string }>; effort: string | undefined } {
    if (effort === undefined || candidates.length === 0) return { candidates, effort }
    const support = this.effortSupport()
    if (support === undefined) return { candidates, effort }
    const primary = candidates[0]
    const check = checkEffortSupport(primary.model, effort, support, primary.provider)
    if (!check.incompatible) return { candidates, effort }
    this.ctx.logger('swarm').warn('preflight (%s): %s', roleId, check.warning ?? `effort "${effort}" is not accepted by ${primary.provider}/${primary.model}`)
    return { candidates, effort: undefined }
  }

  /**
   * J2/P5: machine-check the evidence contract. File checks are advisory (they reach
   * the board as warnings); command failures are hard. Every command's structured
   * outcome travels back with the verdict so the caller can record WHY (A7).
   */

  private async checkEvidence(task: Task, signal: AbortSignal, onCleanupFailed?: (error: unknown) => void): Promise<{
    fileWarnings: string[]; commandFailures: string[]; commands: EvidenceCommandOutcome[]
  }> {
    const result = { fileWarnings: [] as string[], commandFailures: [] as string[], commands: [] as EvidenceCommandOutcome[] }
    const evidence = task.evidence
    if (evidence === undefined) return result
    const dispatch = this.view().runs.get(task.runId)?.dispatch
    const cwd = dispatch?.cwd ?? process.cwd()
    for (const file of evidence.files ?? []) {
      if (signal.aborted) break
      try {
        const info = statSync(join(cwd, file))
        if (!info.isFile() || info.size === 0) result.fileWarnings.push('required file "' + file + '" is missing or empty')
      } catch { result.fileWarnings.push('required file "' + file + '" is missing or empty') }
    }
    const shell = this.ctx.get('shell') as EvidenceShell | undefined
    for (const command of evidence.commands ?? []) {
      const outcome = await runEvidenceCommand(shell, dispatch?.authority, command, cwd, this.rt('evidenceTimeoutMs'), signal, onCleanupFailed)
      result.commands.push(outcome)
      if (!outcome.ok) result.commandFailures.push(describeEvidenceFailure(outcome))
      if (signal.aborted) break
    }
    return result
  }

  /** Only the still-owned attempt may commit after ANY await. */
  private currentFlight(runId: string, taskId: string, flight: InFlight, review = false): boolean {
    const task = this.view().tasks.get(runId + '/' + taskId)
    return !this.disposed && !flight.cleanupFailed && !flight.controller.signal.aborted
      && this.inFlight.get(flight.taskKey) === flight
      && this.view().runs.get(runId)?.status === 'running'
      && task?.attemptId === flight.attemptId && task?.attemptRevoked !== true
      && (review ? task?.status === 'reviewing' : task?.status === 'running' || task?.status === 'dispatching')
  }

  private ownFlight(key: string, flight: InFlight): void {
    this.inFlight.set(key, flight)
    this.holders.add(flight)
  }

  private markCleanupFailed(runId: string, taskId: string, flight: InFlight, error: unknown): void {
    const current = this.currentFlight(runId, taskId, flight, flight.phase === 'review')
    flight.cleanupFailed = true
    if (flight.childSessionId !== undefined) this.forgetChildSession(flight.childSessionId)
    const reason = 'child cleanup could not be confirmed; capacity retained: ' + String(error instanceof Error ? error.message : error)
    this.ctx.logger('swarm').warn('%s/%s: %s', runId, taskId, reason)
    if (current) {
      this.events.append('task/blocked', { runId, taskId, data: { attemptId: flight.attemptId, phase: flight.phase, human: true, reason } })
      this.scheduleHumanWaitingNotify(runId)
    }
    this.scheduleTick()
  }

  private finishFlight(key: string, flight: InFlight): void {
    if (flight.cleanupFailed) return
    this.holders.delete(flight)
    if (this.inFlight.get(key) === flight) this.inFlight.delete(key)
    if (flight.childSessionId !== undefined) this.forgetChildSession(flight.childSessionId)
    if (this.liveAttempts.get(key) === flight.attemptId && !this.inFlight.has(key)) this.liveAttempts.delete(key)
    const runId = key.slice(0, key.indexOf('/'))
    const status = this.view().runs.get(runId)?.status
    if (status === 'aborted' || status === 'failed' || status === 'completed') this.releaseAnchor(runId)
    this.scheduleTick()
  }

  /** Every automatic completion, including reports recovered after failure/restart, uses this gate. */
  private async finalizeTask(runId: string, taskId: string, flight: InFlight, summary: string, recovered = false): Promise<void> {
    if (!this.currentFlight(runId, taskId, flight)) return
    const key = flight.taskKey
    const task = this.view().tasks.get(key)!
    flight.phase = 'evidence'
    const d = (fields: Record<string, unknown>): Record<string, unknown> => ({ ...fields, attemptId: flight.attemptId })
    let evidence = await this.checkEvidence(task, flight.controller.signal, (error) => this.markCleanupFailed(runId, taskId, flight, error))
    if (!this.currentFlight(runId, taskId, flight)) return
    let firstRun: Record<string, unknown>[] | undefined
    if (evidence.commandFailures.length > 0 && this.evidenceRecheckedAttempt.get(key) !== flight.attemptId) {
      this.evidenceRecheckedAttempt.set(key, flight.attemptId!)
      firstRun = evidence.commands.filter((c) => !c.ok).slice(0, 10).map(evidenceRecord)
      this.events.append('task/heartbeat', { runId, taskId, data: d({ note: '⚠ evidence command failed — rechecking once without respawning the child: ' + evidence.commandFailures[0].slice(0, 300), evidence: { recheck: true, commands: firstRun } }) })
      evidence = await this.checkEvidence(task, flight.controller.signal, (error) => this.markCleanupFailed(runId, taskId, flight, error))
      if (!this.currentFlight(runId, taskId, flight)) return
      if (evidence.commandFailures.length === 0) this.events.append('task/heartbeat', { runId, taskId, data: d({ note: '✓ evidence commands passed on recheck — the finished work stands' }) })
    }
    if (evidence.commandFailures.length > 0) {
      this.events.append('task/blocked', { runId, taskId, data: d({ human: true, reason: 'evidence contract failed twice — automatic retrying stops here. A human decides: accept the work (swarm_complete / dashboard), fix the command, or requeue (swarm_retry). ' + evidence.commandFailures[0], evidence: { commands: evidence.commands.filter((c) => !c.ok).slice(0, 10).map(evidenceRecord), firstRun } }) })
      this.scheduleHumanWaitingNotify(runId)
      return
    }
    if (evidence.fileWarnings.length > 0) this.events.append('task/heartbeat', { runId, taskId, data: d({ note: '⚠ evidence warning: ' + evidence.fileWarnings[0] }) })
    // Commands are quiescent now. Release this phase BEFORE queuing any reviewer.
    this.finishFlight(key, flight)
    this.evidenceRecheckedAttempt.delete(key)
    this.growConcurrency(runId)
    this.events.append('task/completed', { runId, taskId, data: d({ summary, recovered, fileWarnings: evidence.fileWarnings, evidence: evidence.commands.slice(0, 10).map(evidenceRecord) }) })
    if (task.reviewGate === 'human') {
      this.events.append('task/review-started', { runId, taskId, data: d({ reviewer: task.reviewBy ?? 'human', human: true }) })
      this.scheduleHumanWaitingNotify(runId)
    } else if (task.reviewBy !== undefined && task.reviewBy.length > 0) {
      void this.runReview(runId, taskId, task.reviewBy, flight.attemptId!)
    }
    this.scheduleTick()
  }

  /** Recovery waits for a cancelled holder's owned cleanup; the report remains only a hint. */
  private recoverReportedTask(task: Task, summary: string): void {
    const key = taskKeyOf(task)
    if (this.recoveries.has(key) || task.attemptId === undefined) return
    const old = this.inFlight.get(key)
    old?.controller.abort()
    const attemptId = task.attemptId
    const work = Promise.resolve(old?.done).then(async () => {
      const fresh = this.view().tasks.get(key)
      if (this.disposed || this.view().runs.get(task.runId)?.status !== 'running' || fresh?.attemptId !== attemptId || fresh.attemptRevoked === true) return
      if (fresh.status !== 'running' && fresh.status !== 'dispatching' && fresh.status !== 'reviewing') return
      if (this.inFlight.has(key)) return
      if (this.countGlobalRunning() >= this.rt('maxTotalConcurrentAgents') || this.countRunHolders(task.runId) >= this.effectiveConcurrency(task.runId)) { this.recoveryQueue.set(key, { task: fresh, summary }); return }
      this.recoveryQueue.delete(key)
      if (fresh.status === 'reviewing') this.events.append('task/recovery-started', { runId: task.runId, taskId: task.id, data: { attemptId } })
      const flight: InFlight = { controller: new AbortController(), taskKey: key, attemptId, roleId: task.role, phase: 'evidence' }
      this.liveAttempts.set(key, attemptId)
      this.ownFlight(key, flight)
      flight.done = this.finalizeTask(task.runId, task.id, flight, summary, true).catch((err: unknown) => {
        if (this.currentFlight(task.runId, task.id, flight)) this.events.append('task/blocked', { runId: task.runId, taskId: task.id, data: { attemptId, human: true, reason: 'recovery gate failed: ' + String(err) } })
      }).finally(() => this.finishFlight(key, flight))
      await flight.done
    }).catch((err: unknown) => this.ctx.logger('swarm').warn('report recovery failed: %s', String(err))).finally(() => { if (this.recoveries.get(key) === work) this.recoveries.delete(key) })
    this.recoveries.set(key, work)
  }

  private pauseRun(runId: string, cause: string): void {
    const state = this.view()
    const run = state.runs.get(runId)
    if (run === undefined || run.status !== 'running') return
    for (const flight of this.holders) if (flight.taskKey.startsWith(runId + '/')) flight.controller.abort()
    for (const id of run.taskIds) {
      const task = state.tasks.get(runId + '/' + id)
      if (task?.status === 'running' || task?.status === 'dispatching' || task?.status === 'reviewing' && task.humanReview !== true) {
        this.events.append('task/failed', { runId, taskId: id, data: { source: 'operator', retry: true, reason: 'run paused — cancelled sibling will be requeued after cleanup' } })
      }
      this.reviewQueue.delete(runId + '/' + id)
      this.recoveryQueue.delete(runId + '/' + id)
    }
    this.events.append('run/paused', { runId, data: { reason: cause } })
    this.notifyDispatchSession(runId, 'paused', cause)
  }

  /** Explicit operator action; missing legacy authority never widens to deployment defaults. */
  resumeRun(runId: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error('unknown run ' + runId)
    if (run.status !== 'paused' && run.status !== 'failed' && run.status !== 'aborted') throw new Error('run ' + runId + ' is ' + run.status + '; only paused or failed runs can be resumed')
    const authority = validAuthority(run.dispatch?.authority) ? run.dispatch!.authority! : captureAuthority(this.ctx, this.runParents.get(runId), run.dispatch?.cwd)
    this.events.append('run/resumed', { runId, data: { authority } })
    for (const id of run.taskIds) {
      const task = this.view().tasks.get(runId + '/' + id)
      if (task?.status === 'failed' || task?.status === 'running' || task?.status === 'dispatching' || task?.status === 'reviewing' && task.humanReview !== true) {
        this.events.append('task/failed', { runId, taskId: id, data: { source: 'operator', retry: true, reason: 'run resumed — requeued after previous holder cleanup' } })
      }
    }
    this.scheduleTick()
  }

  /** Human verdict on an exact currently-waiting attempt. */

  review(runId: string, taskId: string, verdict: 'approve' | 'reject'): void {
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status !== 'reviewing' || task.humanReview !== true) {
      throw new Error(`task ${taskId} is not awaiting a human review`)
    }
    const run = this.view().runs.get(runId)
    if (run?.status !== 'running' && run?.status !== 'paused') throw new Error(`run ${runId} is inactive; cannot review its task`)
    if (task.attemptProtocol === 2 && (task.attemptId === undefined || task.attemptRevoked === true)) throw new Error(`task ${taskId} has no live human review attempt`)
    const reviews = (task.reviews ?? 0) + 1
    // J19: pin the verdict to the attempt it judges, so a human decision about an
    // old attempt cannot close a task that has since been retried.
    const fence = { source: 'operator', ...(task.attemptId !== undefined ? { attemptId: task.attemptId } : {}) }
    if (verdict === 'approve') {
      this.events.append('task/reviewed', { runId, taskId, data: { ...fence, verdict: 'approve', feedback: 'approved by human review' } })
    } else {
      this.events.append('task/reviewed', { runId, taskId, data: { ...fence, verdict: 'reject', reviews, feedback: 'rejected by human review — fix and resubmit' } })
    }
    this.scheduleTick()
  }

  /** C1: resolve when the watched scope changes (long-poll for dispatcher chats). */
  waitForChange(runId: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (note: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
        resolve(`${note}\n\n${this.statusText(runId)}`)
      }
      const unsubscribe = this.events.subscribe((event) => {
        if (runId === undefined || event.runId === undefined || event.runId === runId) {
          finish(`change at seq ${event.seq}: ${event.kind}${event.taskId !== undefined ? ` (${event.taskId})` : ''}`)
        }
      })
      const timer = setTimeout(() => finish(`no swarm changes within ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
      const onAbort = (): void => finish('wait aborted')
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private scheduleTick(): void {
    if (this.disposed || this.tickScheduled) return
    this.tickScheduled = true
    queueMicrotask(() => {
      this.tickScheduled = false
      try {
        this.tick()
      } catch (err) {
        this.ctx.logger('swarm').warn('dispatcher tick failed: %s', String(err))
      }
    })
  }

  /**
   * H-2 circuit breaker: record a task failure and trip the breaker when
   * threshold failures land within the rolling 30-second window. While the
   * breaker is open, no tasks for this run launch — the tick skips them,
   * letting the provider recover instead of burning retries into a dead endpoint.
   */
  private recordFailure(runId: string): void {
    const threshold = this.rt('circuitBreakerThreshold')
    if (threshold <= 0) return
    const now = Date.now()
    const stamps = (this.recentFailures.get(runId) ?? []).filter((t) => now - t < 30_000)
    stamps.push(now)
    this.recentFailures.set(runId, stamps)
    if (stamps.length >= threshold) {
      this.recentFailures.delete(runId)
      const cooldown = this.rt('circuitBreakerCooldownMs')
      this.circuitBreakerUntil.set(runId, now + cooldown)
      this.ctx.logger('swarm').warn(
        'circuit breaker OPEN for run %s: %d failures in 30s — retries paused for %dms',
        runId, stamps.length, cooldown,
      )
      // Schedule a tick after the cooldown so the run resumes automatically.
      this.scheduleTick()
    }
  }

  /** H-2: whether the circuit breaker is currently pausing retries for this run. */
  private isCircuitOpen(runId: string): boolean {
    const until = this.circuitBreakerUntil.get(runId)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this.circuitBreakerUntil.delete(runId)
      this.ctx.logger('swarm').info('circuit breaker CLOSED for run %s — resuming', runId)
      return false
    }
    return true
  }

  /** Launch ready tasks up to the concurrency caps. Sync planning; spawns are staggered + fire-and-track. */
  private tick(): void {
    if (this.disposed) return
    const state = this.view()
    let deadline: number | undefined
    const later = (at: number): void => { if (at > Date.now() && (deadline === undefined || at < deadline)) deadline = at }
    for (const run of state.runs.values()) {
      if (run.status !== 'running') continue
      if (!validAuthority(run.dispatch?.authority)) { this.pauseRun(run.id, 'legacy run has no captured caller authority — explicitly resume with conservative permissions or redispatch'); continue }
      const tasks = run.taskIds.map((id) => state.tasks.get(run.id + '/' + id)).filter((task): task is Task => task !== undefined)
      for (const task of tasks) {
        if (task.status === 'blocked') {
          if (task.humanReview !== true && task.blockedReason?.startsWith('upstream task ') === true && (task.blockedBy?.length ?? 0) > 0 && task.blockedBy!.every((id) => state.tasks.get(run.id + '/' + id)?.status === 'completed')) this.events.append('task/unblocked', { runId: run.id, taskId: task.id, data: { source: 'operator' } })
          continue
        }
        if (task.status !== 'pending' && task.status !== 'retrying') continue
        const dead = (task.blockedBy ?? []).find((id) => { const status = state.tasks.get(run.id + '/' + id)?.status; return status === 'failed' || status === 'blocked' })
        if (dead !== undefined) this.events.append('task/blocked', { runId: run.id, taskId: task.id, data: { source: 'operator', reason: 'upstream task ' + dead + ' did not complete' } })
        if (task.status === 'retrying') later(task.updatedAt + Math.min(this.rt('retryBackoffBaseMs') * 2 ** Math.max(0, task.attempts - 1), 60000))
      }
      if (this.isCircuitOpen(run.id)) { later(this.circuitBreakerUntil.get(run.id)!); this.checkRunCompletion(run.id); continue }
      for (const [key, request] of this.recoveryQueue) {
        if (request.task.runId === run.id && !this.recoveries.has(key) && !this.inFlight.has(key) && this.countGlobalRunning() < this.rt('maxTotalConcurrentAgents') && this.countRunHolders(run.id) < this.effectiveConcurrency(run.id)) this.recoverReportedTask(request.task, request.summary)
      }
      this.launchQueuedReviews(run.id)
      const fresh = this.view()
      const runTasks = run.taskIds.map((id) => fresh.tasks.get(run.id + '/' + id)).filter((task): task is Task => task !== undefined)
      const roleRunning = new Map<string, number>()
      for (const flight of this.holders) if (flight.taskKey.startsWith(run.id + '/') && flight.roleId !== undefined) roleRunning.set(flight.roleId, (roleRunning.get(flight.roleId) ?? 0) + 1)
      let capacity = Math.max(0, Math.min(this.effectiveConcurrency(run.id) - this.countRunHolders(run.id), this.rt('maxTotalConcurrentAgents') - this.countGlobalRunning()))
      let wave = 0
      for (const task of runTasks) {
        if (capacity <= 0) break
        if (!isReady(fresh, task) || this.inFlight.has(taskKeyOf(task)) || this.recoveries.has(taskKeyOf(task)) || this.recoveryQueue.has(taskKeyOf(task))) continue
        if (task.status === 'retrying') {
          const at = task.updatedAt + Math.min(this.rt('retryBackoffBaseMs') * 2 ** Math.max(0, task.attempts - 1), 60000)
          if (Date.now() < at) { later(at); continue }
        }
        const cap = this.duty.role(task.role)?.maxConcurrent
        if (cap !== undefined && (roleRunning.get(task.role) ?? 0) >= cap) continue
        this.launchTask(run.id, task, wave === 0 ? 0 : this.rt('spawnStaggerMs') * wave)
        capacity -= 1
        wave += 1
        roleRunning.set(task.role, (roleRunning.get(task.role) ?? 0) + 1)
      }
      this.checkRunCompletion(run.id)
    }
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = deadline === undefined ? undefined : setTimeout(() => { this.deadlineTimer = undefined; this.scheduleTick() }, Math.max(1, deadline - Date.now()))
    this.deadlineTimer?.unref?.()
  }

  /** Explicit authenticated operator override, not automatic proof. */

  completeTaskExternally(runId: string, taskId: string, actorSessionId: string | undefined, summary: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    // Gated to the dispatching session; the dashboard bypasses via its own action.
    const owner = run.dispatch?.sessionId
    if (actorSessionId !== undefined && actorSessionId !== owner) {
      throw new Error('swarm_complete is gated to the dispatching session; use the Swarm dashboard instead')
    }
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (run.status !== 'running' && run.status !== 'paused' && run.status !== 'failed') throw new Error(`run ${runId} is ${run.status}; cannot complete an inactive run's task`)
    if (task.status === 'completed') throw new Error(`task ${taskId} is already completed`)
    if (run.status === 'failed') {
      const authority = validAuthority(run.dispatch?.authority) ? run.dispatch!.authority! : captureAuthority(this.ctx, this.runParents.get(runId), run.dispatch?.cwd)
      this.events.append('run/resumed', { runId, data: { authority } })
    }
    for (const [key, flight] of this.inFlight) {
      if (flight.taskKey === `${runId}/${taskId}`) {
        flight.controller.abort()
        this.inFlight.delete(key)
      }
    }
    this.events.append('task/completed', {
      runId, taskId,
      data: { source: 'operator', revokeAttempt: true, summary: (summary.length > 0 ? summary : `task ${taskId} completed outside the swarm (dispatcher rescue)`) },
    })
    this.scheduleTick()
  }

  /**
   * I-1: interrupt a running task's child agent and requeue it in the same run.
   * This is the dispatcher's rescue for stalled children: instead of dispatching
   * a relief-sibling run, the dead task is aborted and retried in place.
   */
  interruptTask(runId: string, taskId: string, actorSessionId: string | undefined): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    // Gated to the dispatching session (same rule as swarm_complete).
    const owner = run.dispatch?.sessionId
    if (actorSessionId !== undefined && actorSessionId !== owner) {
      throw new Error('swarm_interrupt is gated to the dispatching session; use the Swarm dashboard instead')
    }
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status !== 'running' && task.status !== 'dispatching') {
      throw new Error(`task ${taskId} is ${task.status}; only running or dispatching tasks can be interrupted`)
    }
    // Abort the in-flight child agent.
    const key = `${runId}/${taskId}`
    const flight = this.inFlight.get(key)
    if (flight !== undefined) {
      flight.controller.abort()
      this.inFlight.delete(key)
    }
    // Forget the tracked child session so the effort pin doesn't leak.
    if (flight?.childSessionId !== undefined) this.forgetChildSession(flight.childSessionId)
    // Mark the task as failed-with-retry: the dispatcher requeues it in the same run.
    this.events.append('task/failed', {
      runId, taskId,
      data: { source: 'operator', retry: true, reason: 'interrupted by the dispatching session (stalled child)' },
    })
    this.scheduleTick()
  }


  private launchTask(runId: string, task: Task, delayMs = 0): void {
    const run = this.view().runs.get(runId)
    const role = this.duty.role(task.role)
    const key = taskKeyOf(task)
    if (run === undefined || role === undefined) {
      this.events.append('task/blocked', { runId, taskId: task.id, data: { source: 'operator', reason: 'run context unavailable' } })
      return
    }
    let toolFilter: { allow?: string[]; deny?: string[] } | undefined
    try { toolFilter = this.spawnToolFilter(role) }
    catch (err) {
      this.events.append('task/blocked', { runId, taskId: task.id, data: { source: 'operator', human: true, reason: String(err instanceof Error ? err.message : err) } })
      this.scheduleHumanWaitingNotify(runId)
      return
    }
    let candidates = this.resolveCandidates(run, task.role, task)
    if (candidates === undefined) {
      this.events.append('task/failed', { runId, taskId: task.id, data: { source: 'operator', retry: false, reason: 'no model route for role "' + task.role + '": pin a provider/model in the Swarm Roster, or dispatch from a session with a configured model' } })
      return
    }
    if (task.attempts >= 1 && candidates.length > 1) {
      const offset = task.attempts % candidates.length
      candidates = [...candidates.slice(offset), ...candidates.slice(0, offset)]
    }
    const rungs = this.effortRungs(role, task.attempts + 1)
    const effort = this.preflightEffort(task.role, candidates, rungs[0]).effort
    const controller = new AbortController()
    const childController = new AbortController()
    const attemptId = 'att-' + randomUUID()
    const flight: InFlight = { controller, taskKey: key, attemptId, roleId: task.role, phase: 'build' }
    this.liveAttempts.set(key, attemptId)
    this.ownFlight(key, flight)
    this.nudgeCount.delete(key)
    this.nudgedAt.delete(key)
    const d = (fields: Record<string, unknown>): Record<string, unknown> => ({ ...fields, attemptId, phase: 'build' })
    this.events.append('task/started', { runId, taskId: task.id, data: d({ attemptProtocol: 2, label: 'swarm:' + task.id, provider: candidates[0]?.provider, model: candidates[0]?.model, effort, requestedEffort: rungs[0] }) })
    let spawnTimer: ReturnType<typeof setTimeout> | undefined
    let delayTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutMs = (role.spawnTimeoutSeconds ?? this.rt('spawnTimeoutSeconds')) * 1000
    const arm = (): void => {
      if (timeoutMs <= 0) return
      if (spawnTimer !== undefined) clearTimeout(spawnTimer)
      spawnTimer = setTimeout(() => flight.reclaim?.('spawn timeout: no task progress'), timeoutMs)
      spawnTimer.unref?.()
    }
    const abortChild = (): void => childController.abort()
    controller.signal.addEventListener('abort', abortChild, { once: true })
    flight.resetSpawnTimer = arm
    flight.reclaim = (reason) => {
      if (!this.currentFlight(runId, task.id, flight) || flight.phase !== 'build') return
      flight.reclaimReason = reason
      childController.abort()
    }
    const changeEffort = (id: string, pin: string | undefined): void => {
      if (!this.currentFlight(runId, task.id, flight)) return
      this.trackChildSession(id, key, pin, attemptId)
      this.events.append('task/effort-changed', { runId, taskId: task.id, data: d({ effort: pin }) })
    }
    flight.done = Promise.resolve().then(async () => {
      if (delayMs > 0 && !controller.signal.aborted) await new Promise<void>((resolve) => {
        const cancel = (): void => { if (delayTimer !== undefined) clearTimeout(delayTimer); controller.signal.removeEventListener('abort', cancel); resolve() }
        controller.signal.addEventListener('abort', cancel, { once: true })
        delayTimer = setTimeout(cancel, delayMs)
        delayTimer.unref?.()
        if (controller.signal.aborted) cancel()
      })
      if (!this.currentFlight(runId, task.id, flight)) return
      arm()
      const parent = await this.ensureAnchor(runId)
      if (!this.currentFlight(runId, task.id, flight)) return
      if (parent === undefined) throw new Error('no spawn anchor available (agents service absent and the dispatching session is gone)')
      const priorNotes = task.attempts > 0 ? this.events.all().filter((e) => e.runId === runId && e.taskId === task.id && e.kind === 'task/heartbeat' && typeof e.data?.note === 'string').slice(-6).map((e) => String(e.data?.note)) : undefined
      const currentTask = this.view().tasks.get(key)!
      const outcome = await spawnTaskAgent(this.spawnDeps(), {
        parent, run, task: { ...task, attemptId }, role, candidates: candidates!, signal: childController.signal,
        ...(this.swarmConfig.maxSubagentDepth > 0 ? { maxDepth: this.swarmConfig.maxSubagentDepth } : {}),
        workspace: run.dispatch?.cwd, toolFilter, priorNotes, evidence: task.evidence,
        initialEffort: rungs[0], effortRungs: rungs.slice(1),
        preflightEffort: (candidate, pin) => this.preflightEffort(task.role, [candidate], pin).effort,
        dependencyHandoffs: this.dependencyHandoffs(run, currentTask), planPath: run.planPath,
        onFallback: (failed, next) => {
          if (this.currentFlight(runId, task.id, flight)) this.events.append('task/model-fallback', { runId, taskId: task.id, data: d({ from: failed.provider + '/' + failed.model, ...(next === undefined ? {} : next), reason: 'unavailable' }) })
        },
        onCandidateStarted: (id, candidate, pin) => {
          if (!this.currentFlight(runId, task.id, flight)) return
          flight.childSessionId = id
          this.trackChildSession(id, key, pin, attemptId)
          this.events.append('task/agent-started', { runId, taskId: task.id, data: d({ sessionId: id, ...candidate, effort: pin }) })
        },
        onDropEffort: (id) => changeEffort(id, undefined), onEffortRung: changeEffort,
        onSettled: (id) => this.forgetChildSession(id),
        onCleanupFailed: (_id, error) => this.markCleanupFailed(runId, task.id, flight, error),
      })
      if (spawnTimer !== undefined) { clearTimeout(spawnTimer); spawnTimer = undefined }
      if (!this.currentFlight(runId, task.id, flight)) return
      if (outcome.ok) {
        await this.finalizeTask(runId, task.id, flight, outcome.summary ?? '')
        return
      }
      const adopted = this.adoptTaskReport(runId, this.view().tasks.get(key)!)
      if (adopted !== undefined) {
        await this.finalizeTask(runId, task.id, flight, adopted, true)
        return
      }
      const reason = flight.reclaimReason ?? outcome.reason ?? 'child stopped: ' + (outcome.stopReason ?? 'unknown')
      const failureClass = classifyFailure(reason)
      if (failureClass !== 'other') this.shrinkConcurrency(runId)
      const retry = this.view().tasks.get(key)!.attempts <= this.rt('maxRetries')
      this.events.append('task/failed', { runId, taskId: task.id, data: d({ retry: failureClass === 'quota' ? false : retry, reason: failureClass === 'quota' ? 'provider quota exhausted (before this failure: ' + reason + ')' : reason }) })
      if (failureClass === 'quota') this.pauseRun(runId, reason)
      else this.recordFailure(runId)
    }).catch(async (err: unknown) => {
      if (!this.currentFlight(runId, task.id, flight)) return
      // Bookkeeping errors are not proof of completion, even when a report exists.
      const adopted = this.adoptTaskReport(runId, this.view().tasks.get(key)!)
      if (adopted !== undefined) await this.finalizeTask(runId, task.id, flight, adopted, true)
      else this.events.append('task/blocked', { runId, taskId: task.id, data: d({ human: true, reason: 'dispatcher bookkeeping failed: ' + String(err instanceof Error ? err.message : err) }) })
      this.scheduleHumanWaitingNotify(runId)
    }).catch((err: unknown) => this.ctx.logger('swarm').warn('task completion gate failed: %s', String(err))).finally(() => {
      if (spawnTimer !== undefined) clearTimeout(spawnTimer)
      if (delayTimer !== undefined) clearTimeout(delayTimer)
      controller.signal.removeEventListener('abort', abortChild)
      this.finishFlight(key, flight)
    })
  }


  private async runReview(runId: string, taskId: string, reviewerRoleId: string, attemptId: string): Promise<void> {
    const key = runId + '/' + taskId
    const task = this.view().tasks.get(key)
    if (task?.attemptId !== attemptId || task.status !== 'completed' || this.view().runs.get(runId)?.status !== 'running') return
    // Same synchronous block as completion: the run must not end before a review is queued.
    this.events.append('task/review-started', { runId, taskId, data: { attemptId, reviewer: reviewerRoleId } })
    this.reviewQueue.set(key, { runId, taskId, roleId: reviewerRoleId, attemptId })
    this.scheduleTick()
  }

  private launchQueuedReviews(runId: string): void {
    for (const [key, request] of this.reviewQueue) {
      if (request.runId !== runId) continue
      const task = this.view().tasks.get(key)
      if (task?.attemptId !== request.attemptId || task.status !== 'reviewing' || task.humanReview || task.attemptRevoked) { this.reviewQueue.delete(key); continue }
      if (this.inFlight.has(key)) continue
      const role = this.duty.role(request.roleId)
      const roleCount = [...this.holders].filter((f) => f.roleId === request.roleId && f.taskKey.startsWith(runId + '/')).length
      if (this.countGlobalRunning() >= this.rt('maxTotalConcurrentAgents') || this.countRunHolders(runId) >= this.effectiveConcurrency(runId) || (role?.maxConcurrent !== undefined && roleCount >= role.maxConcurrent)) continue
      this.reviewQueue.delete(key)
      this.launchReview(request)
    }
  }

  private launchReview(request: { runId: string; taskId: string; roleId: string; attemptId: string }): void {
    const { runId, taskId, roleId, attemptId } = request
    const key = runId + '/' + taskId
    const run = this.view().runs.get(runId)!
    const role = this.duty.role(roleId)
    const candidates = role === undefined ? undefined : this.resolveCandidates(run, roleId)
    const d = (fields: Record<string, unknown>): Record<string, unknown> => ({ ...fields, attemptId, phase: 'review' })
    if (role === undefined || candidates === undefined) {
      this.events.append('task/reviewed', { runId, taskId, data: d({ verdict: 'error', feedback: role === undefined ? 'reviewer role "' + roleId + '" unavailable' : 'no model route for reviewer role "' + roleId + '"' }) })
      this.scheduleTick()
      return
    }
    let toolFilter: { allow?: string[]; deny?: string[] } | undefined
    try { toolFilter = this.spawnToolFilter(role) }
    catch (err) {
      this.events.append('task/blocked', { runId, taskId, data: d({ human: true, reason: 'review restrictions cannot be enforced: ' + String(err) }) })
      this.scheduleHumanWaitingNotify(runId)
      return
    }
    const controller = new AbortController()
    const childController = new AbortController()
    const abortChild = (): void => childController.abort()
    controller.signal.addEventListener('abort', abortChild, { once: true })
    const flight: InFlight = { controller, taskKey: key, attemptId, roleId, phase: 'review' }
    this.ownFlight(key, flight)
    const rungs = this.effortRungs(role, 1)
    const effort = this.preflightEffort('review ' + roleId, candidates, rungs[0]).effort
    this.events.append('task/review-agent', { runId, taskId, data: d({ provider: candidates[0]?.provider, model: candidates[0]?.model, effort, requestedEffort: rungs[0] }) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutMs = (role.spawnTimeoutSeconds ?? this.rt('spawnTimeoutSeconds')) * 1000
    const arm = (): void => {
      if (timeoutMs <= 0) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => flight.reclaim?.('reviewer exceeded the no-progress window'), timeoutMs)
      timer.unref?.()
    }
    flight.resetSpawnTimer = arm
    const current = (): boolean => this.currentFlight(runId, taskId, flight, true)
    flight.reclaim = (reason) => {
      if (!current()) return
      flight.reclaimReason = reason
      childController.abort()
    }
    const changeEffort = (id: string, pin: string | undefined): void => {
      if (!current()) return
      this.trackChildSession(id, key, pin, attemptId)
      this.events.append('task/effort-changed', { runId, taskId, data: d({ effort: pin }) })
    }
    flight.done = Promise.resolve().then(async () => {
      arm()
      const parent = await this.ensureAnchor(runId)
      if (!current()) return
      if (parent === undefined) throw new Error('no spawn anchor available for reviewer')
      const task = this.view().tasks.get(key)!
      const spawn = (prompt: string) => spawnTaskAgent(this.spawnDeps(), {
        parent, run, task, role, candidates, signal: childController.signal, prompt, toolFilter,
        workspace: run.dispatch?.cwd,
        ...(this.swarmConfig.maxSubagentDepth > 0 ? { maxDepth: this.swarmConfig.maxSubagentDepth } : {}),
        initialEffort: rungs[0], effortRungs: rungs.slice(1),
        preflightEffort: (candidate, pin) => this.preflightEffort('review ' + roleId, [candidate], pin).effort,
        onCandidateStarted: (id, candidate, pin) => {
          if (!current()) return
          flight.childSessionId = id
          this.trackChildSession(id, key, pin, attemptId)
          this.events.append('task/agent-started', { runId, taskId, data: d({ sessionId: id, ...candidate, effort: pin }) })
        },
        onFallback: (failed, next) => {
          if (current()) this.events.append('task/model-fallback', { runId, taskId, data: d({ from: failed.provider + '/' + failed.model, ...(next === undefined ? {} : next), reason: 'unavailable' }) })
        },
        onDropEffort: (id) => changeEffort(id, undefined), onEffortRung: changeEffort, onSettled: (id) => this.forgetChildSession(id),
        onCleanupFailed: (_id, error) => this.markCleanupFailed(runId, taskId, flight, error),
      })
      let outcome = await spawn(buildReviewPrompt(run, task, role))
      if (!current()) return
      let text = outcome.finalText ?? outcome.summary ?? ''
      let verdict = outcome.ok ? parseVerdict(text) : undefined
      if (outcome.ok && verdict === undefined) {
        outcome = await spawn(buildReviewReaskPrompt(text))
        if (!current()) return
        text = outcome.finalText ?? outcome.summary ?? ''
        verdict = outcome.ok ? parseVerdict(text) : undefined
      }
      if (!current()) return
      if (verdict === 'reject') {
        const reviews = (this.view().tasks.get(key)?.reviews ?? 0) + 1
        this.events.append('task/reviewed', { runId, taskId, data: d({ verdict, reviews, exhausted: reviews >= this.rt('reviewLoops'), feedback: text }) })
      } else {
        this.events.append('task/reviewed', { runId, taskId, data: d({ verdict: verdict ?? 'error', feedback: verdict === 'approve' ? text : flight.reclaimReason ?? outcome.reason ?? 'reviewer gave no explicit verdict (fail-open; not approved)' }) })
      }
    }).catch((err: unknown) => {
      if (current()) this.events.append('task/reviewed', { runId, taskId, data: d({ verdict: 'error', feedback: String(err instanceof Error ? err.message : err) }) })
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      controller.signal.removeEventListener('abort', abortChild)
      this.finishFlight(key, flight)
    })
  }

  private checkRunCompletion(runId: string): void {
    const state = this.view()
    const run = state.runs.get(runId)
    if (run === undefined || run.status !== 'running') return
    const tasks = run.taskIds.map((id) => state.tasks.get(`${runId}/${id}`)).filter((t): t is Task => t !== undefined)
    if (tasks.length === 0) return
    // A run ends when every task is terminal. All completed → 'completed';
    // any terminally failed/blocked (after retries and the upstream cascade)
    // → 'failed' with the same report shape. Runs no longer hang in 'running'
    // forever behind a task that can never succeed.
    const terminal = ['completed', 'failed', 'blocked'] as const
    if (!tasks.every((t) => (terminal as readonly string[]).includes(t.status))) return
    const succeeded = tasks.every((t) => t.status === 'completed')
    const byStatus: Record<string, number> = {}
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
    this.events.append(succeeded ? 'run/completed' : 'run/failed', {
      runId,
      data: {
        report: {
          completedAt: Date.now(),
          durationMs: Date.now() - run.createdAt,
          taskCount: tasks.length,
          byStatus,
          stats: run.stats ?? { fallbacks: 0, retries: 0, reviewsPassed: 0, reviewsRejected: 0 },
          tasks: tasks.map((task) => ({
            id: task.id,
            role: task.role,
            ...(task.agent?.model !== undefined ? { model: `${task.agent.provider ?? ''}/${task.agent.model}` } : {}),
            status: task.status,
            ...(task.reviewed === true ? { reviewed: true } : {}),
            ...(task.reviewExhausted === true ? { reviewExhausted: true } : {}),
            ...(task.summary !== undefined && task.summary.length > 0 ? { summary: task.summary.slice(0, 600) } : {}),
          })),
        },
      },
    })
    this.releaseAnchor(runId)
    // P-A: push the terminal result to the dispatching chat (once, on transition).
    this.notifyDispatchSession(
      runId,
      succeeded ? 'completed' : 'failed',
      tasks.map((t) => `${t.id}=${t.status}`).join(', '),
    )
  }

  /** Requeue a failed/blocked task for another attempt (dashboard action or swarm_retry tool). */
  retryTask(runId: string, taskId: string, actorSessionId?: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    // A5: the recovery tool is for the dispatching session; the dashboard bypasses the gate.
    const owner = run.dispatch?.sessionId
    if (actorSessionId !== undefined && actorSessionId !== owner) {
      throw new Error(`swarm_retry is gated to the dispatching session (${owner}); use the Swarm dashboard instead`)
    }
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status !== 'failed' && task.status !== 'blocked') {
      throw new Error(`task ${taskId} is ${task.status}; only failed or blocked tasks can be retried`)
    }
    // A5: a terminal run comes back to life when one of its tasks is retried.
    if (run.status === 'failed' || run.status === 'aborted' || run.status === 'completed') {
      const authority = validAuthority(run.dispatch?.authority) ? run.dispatch!.authority! : captureAuthority(this.ctx, this.runParents.get(runId), run.dispatch?.cwd)
      this.events.append('run/resumed', { runId, data: { authority } })
    }
    this.events.append('task/failed', { runId, taskId, data: { source: 'operator', retry: true, reason: 'manual retry' } })
    // Observed live (run-mujadjk9-d7zr): the retry left the task in `retrying` and the
    // revived run then sat idle for 62 minutes, because a terminal run's tick loop has
    // stopped and appending the event does not restart it. Kick it explicitly —
    // scheduleTick is idempotent, so calling it here cannot double-schedule.
    this.scheduleTick()
  }

  /** Track a spawned child session for report authentication + effort pinning. */
  trackChildSession(childSessionId: string, taskKey: string, effort?: string, attemptId?: string): void {
    this.sessionTasks.set(childSessionId, {
      taskKey,
      ...(effort !== undefined ? { effort } : {}),
      ...(attemptId !== undefined ? { attemptId } : {}),
    })
  }

  forgetChildSession(childSessionId: string): void {
    this.sessionTasks.delete(childSessionId)
  }

  /** Compatibility accessor; use effortOverrideFor to distinguish an explicit no-pin. */
  effortFor(agentId: string): string | undefined {
    return this.sessionTasks.get(agentId)?.effort
  }

  /** Undefined means untracked; a tracked empty object explicitly removes inherited effort. */
  effortOverrideFor(agentId: string): { effort?: string } | undefined {
    const entry = this.sessionTasks.get(agentId)
    if (entry === undefined) return undefined
    const task = this.view().tasks.get(entry.taskKey)
    if (task?.attemptProtocol === 2) {
      const flight = this.inFlight.get(entry.taskKey)
      if (flight === undefined || flight.childSessionId !== agentId || entry.attemptId !== task.attemptId || !this.currentFlight(task.runId, task.id, flight, flight.phase === 'review')) return undefined
    }
    return entry.effort === undefined ? {} : { effort: entry.effort }
  }

  /**
   * Spawn-provider deps resolved with ctx.get(): cordis throws
   * "cannot get property … without inject" on the ctx.subagents property,
   * and this plugin deliberately keeps subagents optional (profiles without
   * it still get roster/board; dispatch reports a clear per-task error).
   */
  private spawnDeps(): SpawnDeps {
    return {
      start: (request) => {
        const subagents = this.ctx.get('subagents') as { start(provider: string, request: unknown): unknown } | undefined
        if (subagents === undefined) throw new Error('subagents service unavailable in this host (spawn provider not mounted?)')
        return subagents.start('spawn', request as never) as never
      },
    }
  }
}
