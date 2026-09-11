import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_VERSION = '0.5.7'

function defaultStorageDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'swarm')
}

export interface SwarmConfig {
  storageDir: string
  maxConcurrent: number
  maxTotalConcurrentAgents: number
  staleTimeoutSeconds: number
  maxRetries: number
  reviewLoops: number
  requireManualEndorsement: boolean
  spawnStaggerMs: number
  adaptiveConcurrency: boolean
  nudgeAfterMinutes: number
  /** 'warn' (default) | 'block' | 'off' — normalized at use; any other value behaves as 'warn'. */
  workspaceRunPolicy: string
  requireArchitectReview: boolean
  notifyDispatchSession: boolean
  retryBackoffBaseMs: number
  circuitBreakerThreshold: number
  circuitBreakerCooldownMs: number
}

export const Config = Schema.object({
  storageDir: Schema.string().default(defaultStorageDir()).description(
    'Directory for the swarm event log and duty table ($DSH_HOME/storages/swarm by default).',
  ),
  maxConcurrent: Schema.number().default(5).min(1).max(32).description(
    'Maximum simultaneously running task agents.',
  ),
  maxTotalConcurrentAgents: Schema.number().default(5).min(1).max(16).description(
    'Global cap on concurrently running swarm agents across ALL runs (default 5). '
    + 'Swarm agents run IN-PROCESS on the DSH host, sharing its Node.js heap — '
    + 'too many concurrent agents can exhaust memory and crash the host. '
    + 'Two parallel runs SHARE this budget (e.g. cap=5 means 3+2 or 4+1, not 5+5).',
  ),
  staleTimeoutSeconds: Schema.number().default(14400).min(60).description(
    'Heartbeat timeout in seconds before a running task with no progress is reclaimed.',
  ),
  maxRetries: Schema.number().default(2).min(0).max(5).description(
    'Failure retries per task before the task blocks for human intervention.',
  ),
  reviewLoops: Schema.number().default(3).min(0).max(5).description(
    'Maximum reviewer fix loops per task before review gives up and blocks.',
  ),
  requireManualEndorsement: Schema.boolean().default(false).description(
    'Hard endorsement gate: every run waits for a human Endorse on the Swarm dashboard, '
    + 'even when swarm_dispatch is called with endorse=true. Set true to make the gate '
    + 'impossible to bypass from chat.',
  ),
  spawnStaggerMs: Schema.number().default(750).min(0).max(60000).description(
    'Delay between consecutive task-agent launches in one dispatch wave (C2 spawn stagger; '
    + 'softens simultaneous provider load).',
  ),
  adaptiveConcurrency: Schema.boolean().default(true).description(
    'K1 adaptive concurrency: shrink the per-run launch capacity on provider-class failures '
    + '(timeouts/quota) and recover it on completions, within the maxConcurrent ceiling.',
  ),
  nudgeAfterMinutes: Schema.number().default(20).min(0).max(240).description(
    'Watchdog early-warning tier: a running task with no progress note for this many minutes '
    + 'gets a nudged marker on the board (0 = off). The full stale timeout still applies after.',
  ),
  workspaceRunPolicy: Schema.string().default('warn').description(
    'One-run-per-goal guard for a workspace that already has an active (planning/running/paused) run: '
    + "'warn' (default) — dispatch succeeds, the run banner names the sibling; 'block' — reject the "
    + 'dispatch; \'off\' — no guard. Parallel workstreams belong in ONE DAG, not in sibling runs.',
  ),
  requireArchitectReview: Schema.boolean().default(true).description(
    "Inject an architect-review task as the mandatory first step of every run whose DAG has no "
    + 'architect task: it deep-reviews the dispatching agent\'s plan against the repo, consolidates '
    + 'workstreams into one DAG, and must produce PLAN.md before any builder starts. '
    + 'Per-dispatch opt-out: architectReview: false.',
  ),
  notifyDispatchSession: Schema.boolean().default(true).description(
    'Push a completion notification into the dispatching chat when a run finishes (completed, '
    + 'failed, or paused) — the chat agent wakes once to relay the result, so it never has to '
    + 'poll or guess. Only live sessions are woken; closed chats are never disturbed.',
  ),
  retryBackoffBaseMs: Schema.number().default(5000).min(0).max(120000).description(
    'Retry backoff: a failed task waits base × 2^(attempt-1) before retrying (5s → 10s → 20s). '
    + 'Prevents synchronized retry cascades when a provider outage kills all tasks at once.',
  ),
  circuitBreakerThreshold: Schema.number().default(3).min(0).max(10).description(
    'Circuit breaker: when this many tasks fail within a 30-second window, the run pauses '
    + 'retries for the cooldown period (provider outage detected). 0 disables.',
  ),
  circuitBreakerCooldownMs: Schema.number().default(60000).min(1000).max(600000).description(
    'How long the circuit breaker pauses retries before resuming (default 60 seconds).',
  ),
})
