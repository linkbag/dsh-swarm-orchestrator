import { randomUUID } from 'node:crypto'
import { exec, execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { PLUGIN_VERSION, type SwarmConfig } from './config.js'
import { validateDag } from './domain/dag.js'
import { DutyTableStore } from './domain/duty-table.js'
import { EventStore } from './domain/event-store.js'
import { RuntimeStore } from './domain/runtime-store.js'
import { fold, isReady, newState, runningCount, taskKeyOf, type SwarmState } from './domain/projection.js'
import type { BoardSnapshot } from './board.js'
import { buildBoardSnapshot } from './board.js'
import { spawnTaskAgent, buildReviewPrompt, parseVerdict, taskReportRelPath, type SpawnDeps } from './dispatch/spawn.js'
import type { DispatchInput, DispatchResult, DutyTable, ModelRef, RoleConfig, Run, RunDispatchContext, Task, TaskSpec } from './domain/types.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

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
  // Without a readable registry we cannot verify: pass the request through.
  if (known === undefined) return { filter: requested, dropped: [] }
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
 * Run one evidence command under the resolved interpreter.
 *
 * `child_process.exec` builds `<shell> -c <command>`, and on Windows it rejects an
 * absolute interpreter path passed as `shell` with `spawn <path> ENOENT`. So the
 * shell is invoked as the *file* with an explicit `-Command`/`-c` argument, which
 * also removes a layer of quoting from the command string.
 */
async function runEvidenceCommand(command: string, cwd: string): Promise<void> {
  const shell = evidenceShell()
  const options = { cwd, timeout: 120_000, windowsHide: true }
  if (shell === undefined || shell.length === 0) {
    await execAsync(command, options)
    return
  }
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-c', command]
  await execFileAsync(shell, args, options)
}

/**
 * Resolve the shell used for evidence-contract commands, once per process.
 *
 * J3: this used to leave `shell` unset, so `exec` fell back to `cmd.exe` on
 * Windows. Agents naturally write PowerShell (`if (Test-Path …) { exit 0 }`,
 * `Set-Location`), which `cmd.exe` rejects with `'…') was unexpected at this
 * time.` — and because that failure was indistinguishable from a real gate
 * failure, the task was retried and eventually failed for a reason that had
 * nothing to do with the work. 59 of 184 recorded task failures (32%) across
 * every project trace to this one mismatch.
 *
 * Candidates are probed with an actual command, not just `where`: on the
 * machine this was diagnosed on, `pwsh` is NOT on PATH and no `Get-Command`
 * finds it, yet Windows PowerShell 5.1 sits at a fixed path. Preferring a
 * path over a name is what makes this reliable.
 */
let cachedEvidenceShell: string | undefined
function evidenceShell(): string | undefined {
  if (cachedEvidenceShell !== undefined) return cachedEvidenceShell
  const candidates: string[] = []
  if (process.platform !== 'win32') {
    candidates.push('/bin/bash', '/bin/sh')
  } else {
    if (typeof process.env.PWSH_PATH === 'string' && process.env.PWSH_PATH.length > 0) candidates.push(process.env.PWSH_PATH)
    if (process.env.ProgramFiles !== undefined) candidates.push(join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'))
    if (process.env.LOCALAPPDATA !== undefined) candidates.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
    if (process.env.SystemRoot !== undefined) {
      candidates.push(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    }
    candidates.push('pwsh.exe', 'pwsh', 'powershell.exe')
  }
  for (const candidate of candidates) {
    // `echo ok` as the shell command exercises resolution AND execution.
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    if (!probe.error && probe.status === 0) {
      cachedEvidenceShell = candidate
      return cachedEvidenceShell
    }
  }
  // No usable shell: keep the platform default rather than failing every gate.
  cachedEvidenceShell = ''
  return undefined
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
}

/** Structural view of ctx.agents for anchor creation (see ensureAnchor). */
interface AgentsLike {
  create(options: {
    sessionId: SessionId
    meta?: { cwd?: string; delegationDepth?: number; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string }
    setup?: (anchorCtx: unknown) => void | Promise<void>
  }): Promise<{ agent: Agent; dispose(): Promise<void> }>
  /** Live-agent lookup by session id (workspace resolution + completion push). */
  get?(id: string): {
    session?: { header?: { cwd?: string } }
    followup?(message: unknown): void
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
  /** The dispatching agent per run — provenance and cwd source, never the spawn route (see ensureAnchor). */
  private readonly runParents = new Map<string, Agent>()
  /** Service-owned idle anchor agents every spawn of a run is routed through. */
  private readonly runAnchors = new Map<string, { agent: Agent; dispose(): Promise<void> }>()
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
  private readonly sessionTasks = new Map<string, { taskKey: string; effort?: string }>()
  private tickScheduled = false

  constructor(ctx: Context, config: SwarmConfig) {
    super(ctx, 'swarm')
    this.swarmConfig = config
    this.startedAt = Date.now()
    mkdirSync(config.storageDir, { recursive: true })
    this.events = new EventStore(join(config.storageDir, 'events.jsonl'))
    this.duty = new DutyTableStore(join(config.storageDir, 'duty-table.json'))
    this.runtime = new RuntimeStore(join(config.storageDir, 'runtime.json'))
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
    const state = fold(this.events.all())
    let recovered = false
    let skipped = 0
    for (const task of state.tasks.values()) {
      if (task.status !== 'running' && task.status !== 'dispatching' && task.status !== 'reviewing') continue
      const run = state.runs.get(task.runId)
      if (run?.status !== 'running') { skipped++; continue }
      // J13: never touch a task this process is actively running. Recovery runs
      // asynchronously after boot, and in a one-shot/headless host the dispatching
      // agent can already have launched a task by then — that task is not an
      // orphan, and failing it kills live work (observed live: a smoke run showed
      // task/started -> agent-started -> failed("host restarted mid-flight")
      // -> heartbeat). An in-memory flight is the authoritative ownership signal.
      if (this.inFlight.has(taskKeyOf(task))) continue
      this.events.append('task/failed', {
        runId: task.runId, taskId: task.id,
        data: { retry: task.attempts <= this.swarmConfig.maxRetries, reason: 'host restarted mid-flight' },
      })
      recovered = true
    }
    if (recovered) this.ctx.logger('swarm').info('recovered orphaned running tasks after restart')
    if (skipped > 0) {
      this.ctx.logger('swarm').info('skipped %d orphaned task(s) whose run is not running (terminal runs stay frozen)', skipped)
    }
  }

  /**
   * Watchdog sweep. Two tiers over a running task's silence:
   * past `nudgeAfterMinutes` without a note → a `task/nudged` marker on the
   * board (early warning, re-nudged per additional silent window); past
   * `staleTimeoutSeconds` → the agent is aborted and the task requeued.
   * `now` is injectable for tests.
   */
  watchdog(now = Date.now()): void {
    const state = this.view()
    const staleMs = this.rt('staleTimeoutSeconds') * 1000
    const nudgeMs = this.rt('nudgeAfterMinutes') * 60000
    for (const [key, flight] of [...this.inFlight]) {
      const task = state.tasks.get(key)
      if (task === undefined) {
        this.inFlight.delete(key)
        this.nudgeCount.delete(key)
        this.nudgedAt.delete(key)
        continue
      }
      // A task that left the running state (completed, failed, blocked) while
      // still holding an inFlight slot (settle handler racing the sweep) —
      // clean the tracking Maps to avoid stale entries.
      if (task.status !== 'running' && task.status !== 'dispatching' && task.status !== 'reviewing') {
        this.inFlight.delete(key)
        this.nudgeCount.delete(key)
        this.nudgedAt.delete(key)
        continue
      }
      if (this.view().runs.get(task.runId)?.status === 'aborted') continue
      if (now - task.updatedAt > staleMs) {
        this.inFlight.delete(key)
        this.nudgeCount.delete(key)
        this.nudgedAt.delete(key)
        flight.controller.abort()
        this.events.append('task/failed', {
          runId: task.runId, taskId: task.id,
          data: { retry: task.attempts <= this.swarmConfig.maxRetries, reason: `stale: no progress for ${Math.round(staleMs / 1000)}s (watchdog)` },
        })
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
            this.nudgeCount.delete(key)
            this.inFlight.delete(key)
            flight.controller.abort()
            this.events.append('task/failed', {
              runId: task.runId, taskId: task.id,
              data: {
                retry: task.attempts <= this.swarmConfig.maxRetries,
                reason: `watchdog escalation: ${count} nudges over ${Math.round(silentMs / 60000)} min of silence — child reclaimed`,
              },
            })
            this.ctx.logger('swarm').warn('watchdog escalated task %s after %d nudges', key, count)
            continue
          }
          this.events.append('task/nudged', {
            runId: task.runId, taskId: task.id,
            data: { silentMinutes: Math.round(silentMs / 60000) },
          })
        }
        // Reset the nudge counter when the task heartbeats (is making progress).
        if (silentMs <= nudgeMs) {
          this.nudgeCount.delete(key)
        }
      }
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
   * Returns the summary to record, or undefined when there is nothing to adopt.
   */
  private adoptTaskReport(runId: string, task: Task): string | undefined {
    const cwd = this.view().runs.get(runId)?.dispatch?.cwd
    if (cwd === undefined) return undefined
    const reportPath = join(cwd, taskReportRelPath(task.id))
    let raw: string
    try {
      const info = statSync(reportPath)
      if (!info.isFile() || info.size === 0 || info.size > 256 * 1024) return undefined
      raw = readFileSync(reportPath, 'utf8')
    } catch {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as Record<string, unknown>
    // Only an explicit completed status is proof; anything else is not adoption.
    if (record.status !== 'completed') return undefined
    if (typeof record.taskId === 'string' && record.taskId.length > 0 && record.taskId !== task.id) {
      this.ctx.logger('swarm').warn('task report for %s declares a different taskId (%s) — ignoring', task.id, record.taskId)
      return undefined
    }
    const summary = typeof record.summary === 'string' && record.summary.trim().length > 0
      ? record.summary.trim()
      : 'completed (recovered from the on-disk task report after the child died)'
    this.ctx.logger('swarm').info('adopted on-disk task report for %s — the work outlived its agent', task.id)
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
    this.events.append('task/heartbeat', { runId: task.runId, taskId: task.id, data: { note } })
    return 'ok'
  }

  setDutyTable(next: DutyTable, actor: string): DutyTable {
    if (next.version !== 1) throw new Error('duty table version must be 1')
    if (next.roles === undefined || typeof next.roles !== 'object') throw new Error('duty table needs a roles object')
    for (const [id, role] of Object.entries(next.roles)) {
      if (role.id !== id) throw new Error(`role ${id} has mismatched id ${String(role.id)}`)
      if (!Array.isArray(role.fallbacks)) throw new Error(`role ${id} needs a fallbacks array`)
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
   * P-A: push the run's terminal result into the dispatching chat's inbox, so
   * the dispatcher learns the outcome exactly once, at the moment it's true —
   * no polling, no optimistic summaries. Only live sessions are woken: a chat
   * that was closed is never disturbed. Failures are contained — a notification
   * problem must never affect the run.
   */
  private notifyDispatchSession(runId: string, outcome: 'completed' | 'failed' | 'paused', detail: string): void {
    if (this.swarmConfig.notifyDispatchSession !== true) return
    try {
      const run = this.view().runs.get(runId)
      const sessionId = run?.dispatch?.sessionId
      if (sessionId === undefined) return
      const agents = this.ctx.get('agents') as AgentsLike | undefined
      const live = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
      if (live === undefined || typeof live.followup !== 'function') return
      const icon = outcome === 'completed' ? '✅' : outcome === 'paused' ? '⏸' : '❌'
      const text = `[swarm auto-notification] Swarm run "${run?.title ?? runId}" (${runId}) ${outcome}: ${detail}. `
        + 'Briefly relay this to the user. Do not start new work unless the user asks — the live board is on the Swarm tab.'
      live.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    } catch (err) {
      this.ctx.logger('swarm').warn('completion push for run %s failed (contained): %s', runId, String(err))
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
    return buildBoardSnapshot(effective, this.duty.get(), this.events.seq, PLUGIN_VERSION, { cwd: scopeCwd, unresolvable: scopeUnresolvable }, effectiveRuntime)
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
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    if (agents === undefined) return this.runParents.get(runId)
    const captured = this.view().runs.get(runId)?.dispatch
    const handle = await agents.create({
      sessionId: SessionId(randomUUID()),
      meta: {
        ...(captured?.cwd !== undefined ? { cwd: captured.cwd } : {}),
        delegationDepth: 0,
        ...(captured?.presetId !== undefined ? { agentPreset: captured.presetId } : {}),
      },
      ...(captured?.provider !== undefined && captured.model !== undefined
        ? { agentOptions: { provider: captured.provider, model: captured.model } }
        : {}),
      setup: async (anchorCtx) => {
        const presets = (anchorCtx as { get(name: string): unknown }).get('agentPresets') as PresetsLike | undefined
        if (presets !== undefined) {
          // undefined id = the deployment default preset (recovered runs).
          await presets.mount(anchorCtx, captured?.presetId)
        }
      },
    })
    // The run may have gone terminal (abort) while the factory was creating.
    if (this.view().runs.get(runId)?.status !== 'running') {
      void handle.dispose().catch(() => {})
      return undefined
    }
    this.runAnchors.set(runId, handle)
    this.ctx.logger('swarm').info('run %s anchored to idle agent %s', runId, String(handle.agent.id))
    return handle.agent
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
    let count = 0
    for (const task of this.view().tasks.values()) {
      if (task.status === 'running' || task.status === 'dispatching' || task.status === 'reviewing') count += 1
    }
    return count
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

  /** A1: the effort this attempt uses — primary first, then the ladder, then inherit. */
  private resolveEffort(role: RoleConfig, attemptNumber: number): string | undefined {
    const chain = [role.reasoningEffort, ...(role.effortFallbacks ?? [])]
      .filter((e): e is string => typeof e === 'string' && e.length > 0)
    if (chain.length === 0) return undefined
    return chain[Math.min(Math.max(0, attemptNumber - 1), chain.length - 1)]
  }

  /** J2: machine-check the evidence contract; null = pass, otherwise the first failure. */
  private async checkEvidence(task: Task): Promise<string | null> {
    const evidence = task.evidence
    if (evidence === undefined) return null
    const cwd = this.view().runs.get(task.runId)?.dispatch?.cwd ?? process.cwd()
    // A command gate cannot be judged from a directory that does not exist: report
    // that plainly instead of surfacing the shell's ENOENT as if the gate failed.
    if ((evidence.commands ?? []).length > 0) {
      try {
        if (!statSync(cwd).isDirectory()) return `the run workspace "${cwd}" is not a directory`
      } catch {
        return `the run workspace "${cwd}" does not exist, so evidence commands cannot run`
      }
    }
    for (const file of evidence.files ?? []) {
      try {
        const info = statSync(join(cwd, file))
        if (!info.isFile() || info.size === 0) return `required file "${file}" is missing or empty`
      } catch {
        return `required file "${file}" is missing or empty`
      }
    }
    for (const command of evidence.commands ?? []) {
      try {
        await runEvidenceCommand(command, cwd)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return `evidence command failed: ${command} — ${message.slice(0, 300)}`
      }
    }
    return null
  }

  /** A3: stop launching, abort in-flight children, and park the run for a human resume. */
  private pauseRun(runId: string, cause: string): void {
    for (const [key, flight] of this.inFlight) {
      if (flight.taskKey.startsWith(runId + '/')) {
        flight.controller.abort()
        this.inFlight.delete(key)
      }
    }
    this.events.append('run/paused', { runId, data: { reason: `provider quota exhausted — resume from the Swarm dashboard after topping up (${cause})` } })
    this.notifyDispatchSession(runId, 'paused', cause)
  }

  /** A3/K2: resume a paused (or requeue a terminally failed) run, keeping completed tasks. */
  resumeRun(runId: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    if (run.status !== 'paused' && run.status !== 'failed' && run.status !== 'aborted') {
      throw new Error(`run ${runId} is ${run.status}; only paused or failed runs can be resumed`)
    }
    this.events.append('run/resumed', { runId })
    for (const id of run.taskIds) {
      const task = this.view().tasks.get(`${runId}/${id}`)
      if (task?.status === 'failed') {
        this.events.append('task/failed', { runId, taskId: id, data: { retry: true, reason: 'run resumed — requeued' } })
      }
    }
    this.scheduleTick()
  }

  /** J7: the human verdict on a human-gated review, from the dashboard. */
  review(runId: string, taskId: string, verdict: 'approve' | 'reject'): void {
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status !== 'reviewing' || task.humanReview !== true) {
      throw new Error(`task ${taskId} is not awaiting a human review`)
    }
    const reviews = (task.reviews ?? 0) + 1
    if (verdict === 'approve') {
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'approve', feedback: 'approved by human review' } })
    } else {
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'reject', reviews, feedback: 'rejected by human review — fix and resubmit' } })
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
    if (this.tickScheduled) return
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
      setTimeout(() => this.scheduleTick(), cooldown + 100)
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
    const state = this.view()
    for (const run of state.runs.values()) {
      if (run.status !== 'running') continue
      const tasks = run.taskIds
        .map((id) => state.tasks.get(`${run.id}/${id}`))
        .filter((t): t is Task => t !== undefined)
      // Cascade: a task whose blocker terminally failed/blocked can never
      // become ready — block it now so the run can reach a terminal status
      // instead of hanging in 'running' with a pending task forever.
      for (const task of tasks) {
        if (task.status === 'blocked') {
          // A5 auto-unblock: every blocker reached completed after a rescue/retry.
          const blockers = (task.blockedBy ?? []).map((b) => state.tasks.get(`${run.id}/${b}`)?.status)
          if (blockers.length > 0 && blockers.every((s) => s === 'completed')) {
            this.events.append('task/unblocked', { runId: run.id, taskId: task.id })
          }
          continue
        }
        if (task.status !== 'pending' && task.status !== 'retrying') continue
        const dead = (task.blockedBy ?? []).find((blocker) => {
          const status = state.tasks.get(`${run.id}/${blocker}`)?.status
          return status === 'failed' || status === 'blocked'
        })
        if (dead !== undefined) {
          this.events.append('task/blocked', {
            runId: run.id, taskId: task.id,
            data: { reason: `upstream task ${dead} did not complete` },
          })
        }
      }
      // A5: refresh — the appends above may have unblocked tasks just now.
      const fresh = this.view()
      const runTasks = run.taskIds
        .map((id) => fresh.tasks.get(`${run.id}/${id}`))
        .filter((t): t is Task => t !== undefined)
      // H-2 circuit breaker: when ≥3 tasks failed within 30s (provider outage),
      // pause retries for the cooldown period instead of launching into a dead
      // provider. The breaker auto-clears when the cooldown expires.
      if (this.isCircuitOpen(run.id)) {
        this.checkRunCompletion(run.id)
        continue
      }
      const roleRunning = new Map<string, number>()
      for (const task of runTasks) {
        if (task.status === 'running' || task.status === 'dispatching' || task.status === 'reviewing') {
          roleRunning.set(task.role, (roleRunning.get(task.role) ?? 0) + 1)
        }
      }
      let capacity = this.effectiveConcurrency(run.id) - runningCount(fresh, run.id)
      // Global agent cap: swarm agents are in-process on the DSH host, sharing
      // its Node.js heap. Without a global cap, two concurrent runs × 5 agents
      // each = 10 heap-resident sessions → potential OOM crash. The cap is
      // shared across all runs: concurrent runs split the budget (3+2, not 5+5).
      const globalCap = this.rt('maxTotalConcurrentAgents')
      const globalRunning = this.countGlobalRunning()
      if (globalRunning + capacity > globalCap) {
        capacity = Math.max(0, globalCap - globalRunning)
      }
      let wave = 0
      for (const task of runTasks) {
        if (capacity <= 0) break
        if (!isReady(fresh, task)) continue
        if (this.inFlight.has(taskKeyOf(task))) continue
        // H-1 retry backoff: a retrying task waits base × 2^(attempt-1) from
        // its failure timestamp (updatedAt) before relaunching — prevents
        // synchronized retry cascades when a provider outage kills all tasks
        // at once. First-attempt tasks launch immediately.
        if (task.status === 'retrying' && this.rt('retryBackoffBaseMs') > 0) {
          const backoffMs = Math.min(
            this.rt('retryBackoffBaseMs') * Math.pow(2, Math.max(0, task.attempts - 1)),
            60000,
          )
          if (Date.now() - task.updatedAt < backoffMs) continue // too soon — next tick will retry
        }
        const role = this.duty.role(task.role)
        const roleCap = role?.maxConcurrent
        if (roleCap !== undefined && (roleRunning.get(task.role) ?? 0) >= roleCap) continue
        const delayMs = wave === 0 ? 0 : this.rt('spawnStaggerMs') * wave
        this.launchTask(run.id, task, delayMs)
        capacity -= 1
        wave += 1
        roleRunning.set(task.role, (roleRunning.get(task.role) ?? 0) + 1)
        fresh.tasks.get(taskKeyOf(task))!.status = 'dispatching'
      }
      this.checkRunCompletion(run.id)
    }
  }

  /** P-C: mark a task completed from outside the swarm (dispatcher rescue path). */
  completeTaskExternally(runId: string, taskId: string, actorSessionId: string | undefined, summary: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    // Gated to the dispatching session; the dashboard bypasses via its own action.
    const owner = run.dispatch?.sessionId
    if (actorSessionId !== undefined && owner !== undefined && actorSessionId !== owner) {
      throw new Error('swarm_complete is gated to the dispatching session; use the Swarm dashboard instead')
    }
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status === 'completed') throw new Error(`task ${taskId} is already completed`)
    for (const [key, flight] of this.inFlight) {
      if (flight.taskKey === `${runId}/${taskId}`) {
        flight.controller.abort()
        this.inFlight.delete(key)
      }
    }
    this.events.append('task/completed', {
      runId, taskId,
      data: { summary: (summary.length > 0 ? summary : `task ${taskId} completed outside the swarm (dispatcher rescue)`) },
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
    if (actorSessionId !== undefined && owner !== undefined && actorSessionId !== owner) {
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
      data: { retry: true, reason: 'interrupted by the dispatching session (stalled child)' },
    })
    this.scheduleTick()
  }

  private launchTask(runId: string, task: Task, delayMs = 0): void {
    const role: RoleConfig | undefined = this.duty.role(task.role)
    const run = this.view().runs.get(runId)
    if (run === undefined || role === undefined) {
      this.events.append('task/blocked', { runId, taskId: task.id, data: { reason: 'run context unavailable' } })
      return
    }
    // K4: per-task model override wins; A1: per-attempt effort comes from the ladder.
    let candidates = this.resolveCandidates(run, task.role, task)
    if (candidates === undefined) {
      // No route and nothing to inherit — retrying cannot fix this.
      this.events.append('task/failed', {
        runId, taskId: task.id,
        data: {
          retry: false,
          reason: `no model route for role "${task.role}": pin a provider/model in the Swarm Roster, or dispatch from a session with a configured model`,
        },
      })
      return
    }
    // A6: from the second attempt on, rotate the chain so a persistently failing
    // primary gets a different model even when its error is not classed as
    // "model unavailable".
    if (task.attempts >= 1 && candidates.length > 1) {
      const offset = task.attempts % candidates.length
      candidates = [...candidates.slice(offset), ...candidates.slice(0, offset)]
    }
    const effort = this.resolveEffort(role, task.attempts + 1)
    const controller = new AbortController()
    const key = taskKeyOf(task)
    const spawnTimeoutMs = this.rt('spawnTimeoutSeconds') * 1000
    this.inFlight.set(key, { controller, taskKey: key })

    const startSpawn = (): void => {
      const deps = this.spawnDeps()
      // J8: a hard ceiling on the whole task run. The heartbeat watchdog only
      // reclaims tasks in `running`, so a task whose child never publishes
      // `agent-started` sits in `dispatching` holding its concurrency slot
      // forever (observed: 14 tasks across 9 runs). This timeout is the only
      // cover for that state. 0 disables.
      const spawnSignal = new AbortController()
      const onLaunchAbort = (): void => spawnSignal.abort()
      let spawnTimer: ReturnType<typeof setTimeout> | undefined
      if (spawnTimeoutMs > 0) {
        spawnTimer = setTimeout(() => {
          this.ctx.logger('swarm').warn('task %s exceeded the %ds spawn ceiling — aborting child', key, Math.round(spawnTimeoutMs / 1000))
          spawnSignal.abort()
        }, spawnTimeoutMs)
        spawnTimer.unref?.()
      }
      controller.signal.addEventListener('abort', onLaunchAbort, { once: true })
      if (controller.signal.aborted) spawnSignal.abort()
      const clearSpawnTimeout = (): void => {
        if (spawnTimer !== undefined) clearTimeout(spawnTimer)
        controller.signal.removeEventListener('abort', onLaunchAbort)
      }
      void this.ensureAnchor(runId).then(async (parent) => {
        if (parent === undefined) {
          clearSpawnTimeout()
          this.inFlight.delete(key)
          this.events.append('task/failed', {
            runId, taskId: task.id,
            data: {
              retry: task.attempts <= this.swarmConfig.maxRetries,
              reason: 'no spawn anchor available (agents service absent and the dispatching session is gone)',
            },
          })
          return
        }
        // A4: feed the retry its own history so it resumes instead of restarting.
        const priorNotes = task.attempts > 0
          ? this.events.all()
            .filter((e) => e.taskId === task.id && e.runId === runId && e.kind === 'task/heartbeat' && typeof e.data?.note === 'string')
            .slice(-6)
            .map((e) => String(e.data?.note))
          : undefined
        // J15: drop tool names this host does not actually expose. `tools.restrict()`
        // THROWS on an unknown name, and that throw happens during child creation, so
        // one typo in a role's toolFilter fails EVERY task agent in the run. That is
        // exactly what happened in production: a filter naming "modlens" (the tool is
        // really `modlens_read_image`) took out all 10 tasks across 3 waves and failed
        // the whole run. A bad name is now a warning on that role, not an outage.
        const roleFilter = this.sanitizeToolFilter(role)
        const outcome = await spawnTaskAgent(deps, {
          parent, run, task, role, candidates, signal: spawnSignal.signal,
          // J14: bound delegation depth so task agents cannot spawn hidden
          // descendants the dispatcher cannot see or account for.
          ...(this.swarmConfig.maxSubagentDepth > 0 ? { maxDepth: this.swarmConfig.maxSubagentDepth } : {}),
          ...(roleFilter !== undefined ? { toolFilter: roleFilter } : {}),
          ...(priorNotes !== undefined && priorNotes.length > 0 ? { priorNotes } : {}),
          ...(task.evidence !== undefined ? { evidence: task.evidence } : {}),
          onFallback: (failed, next) => {
            this.events.append('task/model-fallback', {
              runId, taskId: task.id,
              data: {
                from: `${failed.provider}/${failed.model}`,
                ...(next !== undefined ? { provider: next.provider, model: next.model } : {}),
                reason: 'unavailable',
              },
            })
          },
          onStarted: (childSessionId) => {
            this.trackChildSession(childSessionId, key, effort)
            this.events.append('task/agent-started', { runId, taskId: task.id, data: { sessionId: childSessionId } })
          },
        })
        this.inFlight.delete(key)
        clearSpawnTimeout()
        if (outcome.childSessionId !== undefined) this.forgetChildSession(outcome.childSessionId)
        const fresh = this.view().tasks.get(key)
        if (fresh === undefined) return
        if (this.view().runs.get(runId)?.status === 'aborted' || this.view().runs.get(runId)?.status === 'paused') return
        // The watchdog (or abort path) may already have recorded a terminal transition.
        if (fresh.status !== 'running' && fresh.status !== 'dispatching') return
        if (outcome.ok) {
          this.growConcurrency(runId)
          // J2: the evidence contract gates completion.
          if (task.evidence !== undefined) {
            const evidenceFailure = await this.checkEvidence(task)
            if (evidenceFailure !== null) {
              this.events.append('task/failed', {
                runId, taskId: task.id,
                data: {
                  retry: fresh.attempts <= this.swarmConfig.maxRetries,
                  reason: `evidence contract failed — ${evidenceFailure}`,
                },
              })
              return
            }
          }
          this.events.append('task/completed', {
            runId, taskId: task.id,
            data: { summary: outcome.summary ?? '' },
          })
          if (task.reviewBy !== undefined && task.reviewBy.length > 0) {
            if (task.reviewGate === 'human') {
              // J7: park the task for a human verdict on the dashboard.
              this.events.append('task/review-started', { runId, taskId: task.id, data: { reviewer: task.reviewBy, human: true } })
              this.scheduleTick()
            } else {
              void this.runReview(runId, task.id, task.reviewBy)
            }
          }
        } else {
          const reason = outcome.reason ?? `stop: ${outcome.stopReason ?? 'unknown'}`
          // J10: before charging a failure, check whether the child finished the
          // work but died before the dispatcher could record it. A valid on-disk
          // task report means the deliverable is real — adopt it instead of
          // requeueing a task that has nothing left to do.
          const adopted = this.adoptTaskReport(runId, task)
          if (adopted !== undefined) {
            this.events.append('task/completed', {
              runId, taskId: task.id,
              data: { summary: adopted },
            })
            if (task.reviewBy !== undefined && task.reviewBy.length > 0 && task.reviewGate !== 'human') {
              void this.runReview(runId, task.id, task.reviewBy)
            } else {
              this.scheduleTick()
            }
            return
          }
          const failureClass = classifyFailure(reason)
          if (failureClass !== 'other') this.shrinkConcurrency(runId)
          if (failureClass === 'quota') {
            // A3: park the whole run — more attempts would just burn quota.
            this.events.append('task/failed', {
              runId, taskId: task.id,
              data: { retry: false, reason: `provider quota exhausted (before this failure: ${reason})` },
            })
            this.pauseRun(runId, reason)
            return
          }
          const retry = fresh.attempts <= this.swarmConfig.maxRetries
          this.events.append('task/failed', {
            runId, taskId: task.id,
            data: { retry, reason },
          })
          // H-2: record for the circuit breaker (trips when threshold reached).
          this.recordFailure(runId)
          // H-1: schedule a tick after the retry backoff window so the task
          // relaunches when the delay expires (the event append alone doesn't
          // schedule a future tick — only an immediate microtask).
          if (retry && this.rt('retryBackoffBaseMs') > 0) {
            const backoffMs = Math.min(
              this.rt('retryBackoffBaseMs') * Math.pow(2, Math.max(0, fresh.attempts - 1)),
              60000,
            )
            setTimeout(() => this.scheduleTick(), backoffMs + 100)
          }
        }
      }).catch((err: unknown) => {
        this.inFlight.delete(key)
        clearSpawnTimeout()
        this.ctx.logger('swarm').warn('task %s crashed dispatcher bookkeeping: %s', key, String(err))
        // J10: bookkeeping failed, but the child may have finished and written its
        // report. Adopt it so a dispatcher fault does not discard finished work.
        try {
          const adopted = this.adoptTaskReport(runId, task)
          if (adopted !== undefined && this.view().tasks.get(key)?.status === 'running') {
            this.events.append('task/completed', { runId, taskId: task.id, data: { summary: adopted } })
            this.scheduleTick()
          }
        } catch {
          // Adoption is best-effort: never mask the original bookkeeping failure.
        }
      })    }

    this.events.append('task/started', {
      runId, taskId: task.id,
      data: {
        label: `swarm:${task.id}`,
        provider: candidates[0]?.provider,
        model: candidates[0]?.model,
      },
    })
    if (delayMs > 0) setTimeout(startSpawn, delayMs)
    else startSpawn()
  }

  /**
   * Review loop: a reviewer-role agent judges the completed task's output.
   * Approve → task stands; reject → requeue with feedback (capped at reviewLoops,
   * then fail-open with reviewExhausted); reviewer unavailable → fail-open.
   */
  private async runReview(runId: string, taskId: string, reviewerRoleId: string): Promise<void> {
    const key = `${runId}/${taskId}`
    const reviewerRole = this.duty.role(reviewerRoleId)
    const run = this.view().runs.get(runId)
    if (reviewerRole === undefined || run === undefined) {
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'error', feedback: `reviewer role "${reviewerRoleId}" or run context unavailable` } })
      this.checkRunCompletion(runId)
      return
    }
    const candidates = this.resolveCandidates(run, reviewerRoleId)
    if (candidates === undefined) {
      // No reviewer route — fail-open per the review contract.
      this.events.append('task/reviewed', {
        runId, taskId,
        data: { verdict: 'error', feedback: `no model route for reviewer role "${reviewerRoleId}": pin a provider/model in the Swarm Roster` },
      })
      this.checkRunCompletion(runId)
      return
    }
    const controller = new AbortController()
    this.inFlight.set(key, { controller, taskKey: key })
    // task/review-started must land in the SAME synchronous block as the
    // task/completed append that scheduled this review: if an await separated
    // them, an interleaving dispatcher tick would see every task completed and
    // end the run before the review (let alone a reject-requeue) could run.
    this.events.append('task/review-started', { runId, taskId, data: { reviewer: reviewerRoleId } })
    const parent = await this.ensureAnchor(runId)
    if (parent === undefined) {
      this.inFlight.delete(key)
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'error', feedback: 'no spawn anchor available (agents service absent and the dispatching session is gone)' } })
      this.checkRunCompletion(runId)
      return
    }

    const deps = this.spawnDeps()
    const task = this.view().tasks.get(key)
    if (task === undefined) { this.inFlight.delete(key); return }
    let outcome
    try {
      outcome = await spawnTaskAgent(deps, {
        parent, run, task, role: reviewerRole, candidates, signal: controller.signal,
        prompt: buildReviewPrompt(run, task, reviewerRole),
        onFallback: (failed, next) => {
          this.events.append('task/model-fallback', {
            runId, taskId,
            data: {
              from: `${failed.provider}/${failed.model}`,
              ...(next !== undefined ? { provider: next.provider, model: next.model } : {}),
              reason: 'unavailable',
            },
          })
        },
        onStarted: (childSessionId) => {
          this.trackChildSession(childSessionId, key, reviewerRole.reasoningEffort)
          this.events.append('task/agent-started', { runId, taskId, data: { sessionId: childSessionId } })
        },
      })
    } catch (err) {
      this.inFlight.delete(key)
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'error', feedback: String(err instanceof Error ? err.message : err) } })
      this.checkRunCompletion(runId)
      return
    }
    this.inFlight.delete(key)
    if (outcome.childSessionId !== undefined) this.forgetChildSession(outcome.childSessionId)
    if (this.view().runs.get(runId)?.status === 'aborted') return
    if (this.view().tasks.get(key)?.status !== 'reviewing') return // watchdog/abort raced us

    if (!outcome.ok) {
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'error', feedback: outcome.reason ?? `reviewer stopped: ${outcome.stopReason ?? 'unknown'}` } })
      this.checkRunCompletion(runId)
      return
    }
    const verdict = parseVerdict(outcome.summary ?? '')
    const feedback = (outcome.summary ?? '').trim()
    if (verdict === 'reject') {
      const reviews = (this.view().tasks.get(key)?.reviews ?? 0) + 1
      const exhausted = reviews >= this.swarmConfig.reviewLoops
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'reject', reviews, ...(exhausted ? { exhausted: true } : {}), feedback } })
      if (exhausted) this.checkRunCompletion(runId)
      else this.scheduleTick()
      return
    }
    this.events.append('task/reviewed', { runId, taskId, data: { verdict: verdict === 'approve' ? 'approve' : 'error', feedback: verdict === 'approve' ? feedback : 'reviewer gave no explicit verdict (fail-open)' } })
    this.checkRunCompletion(runId)
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
    if (actorSessionId !== undefined && owner !== undefined && actorSessionId !== owner) {
      throw new Error(`swarm_retry is gated to the dispatching session (${owner}); use the Swarm dashboard instead`)
    }
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status !== 'failed' && task.status !== 'blocked') {
      throw new Error(`task ${taskId} is ${task.status}; only failed or blocked tasks can be retried`)
    }
    // A5: a terminal run comes back to life when one of its tasks is retried.
    if (run.status === 'failed' || run.status === 'aborted' || run.status === 'completed') {
      this.events.append('run/resumed', { runId })
    }
    this.events.append('task/failed', { runId, taskId, data: { retry: true, reason: 'manual retry' } })
  }

  /** Track a spawned child session for report authentication + effort pinning. */
  trackChildSession(childSessionId: string, taskKey: string, effort?: string): void {
    this.sessionTasks.set(childSessionId, { taskKey, ...(effort !== undefined ? { effort } : {}) })
  }

  forgetChildSession(childSessionId: string): void {
    this.sessionTasks.delete(childSessionId)
  }

  /** Per-request reasoning effort for a tracked child (undefined = leave untouched). */
  effortFor(agentId: string): string | undefined {
    return this.sessionTasks.get(agentId)?.effort
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
