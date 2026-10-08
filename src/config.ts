import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RUNTIME_LIMITS, type RuntimeKey } from './domain/limits.js'

export const PLUGIN_VERSION = '0.6.31'

function runtimeNumber(key: RuntimeKey) {
  const bounds = RUNTIME_LIMITS[key]
  return Schema.natural().default(bounds.default).min(bounds.min).max(bounds.max)
}

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
  workspaceRunPolicy: string
  requireArchitectReview: boolean
  notifyDispatchSession: boolean
  retryBackoffBaseMs: number
  circuitBreakerThreshold: number
  circuitBreakerCooldownMs: number
  spawnTimeoutSeconds: number
  bootGraceSeconds: number
  maxSubagentDepth: number
  evidenceTimeoutMs: number
}

export const Config = Schema.object({
  storageDir: Schema.string().default(defaultStorageDir()).description(
    'Directory for the swarm event log and duty table ($DSH_HOME/storages/swarm by default).',
  ),
  maxConcurrent: runtimeNumber('maxConcurrent').description(
    'Maximum task, reviewer and evidence holders PER RUN. Cancelled work counts until cleanup finishes.',
  ),
  maxTotalConcurrentAgents: runtimeNumber('maxTotalConcurrentAgents').description(
    'Global cap across ALL runs, including reviewers and cancelled holders awaiting cleanup. '
    + 'Agents share the host heap: lower this on a constrained machine.',
  ),
  staleTimeoutSeconds: runtimeNumber('staleTimeoutSeconds').description(
    'Heartbeat timeout in seconds before a task with no progress is reclaimed.',
  ),
  maxRetries: runtimeNumber('maxRetries').description(
    'Failure retries per task before it blocks for human intervention.',
  ),
  evidenceTimeoutMs: runtimeNumber('evidenceTimeoutMs').description(
    'Hard ceiling for ONE sandboxed evidence command, in milliseconds. Timeout is not a verdict on the work.',
  ),
  reviewLoops: runtimeNumber('reviewLoops').description(
    'Maximum reviewer fix loops. Exhaustion accepts the work under the fallback policy, NOT as reviewed approval.',
  ),
  requireManualEndorsement: Schema.boolean().default(false).description(
    'Hard endorsement gate: every run waits for a human on the dashboard, even with endorse=true.',
  ),
  spawnStaggerMs: runtimeNumber('spawnStaggerMs').description(
    'Delay between task-agent launches in one wave, in milliseconds.',
  ),
  adaptiveConcurrency: Schema.boolean().default(true).description(
    'Shrink per-run launch capacity on provider failures and recover it on successful completions.',
  ),
  nudgeAfterMinutes: runtimeNumber('nudgeAfterMinutes').description(
    'Watchdog early warning after this many minutes without progress (0 disables nudges).',
  ),
  workspaceRunPolicy: Schema.string().default('warn').description(
    "Active-workspace run guard: 'warn', 'block', or 'off'. Unknown values act as 'warn'. Parallel workstreams belong in ONE DAG.",
  ),
  requireArchitectReview: Schema.boolean().default(true).description(
    'Inject a mandatory architect review before builders when no architect task exists. '
    + 'Writes a run-specific plan; invalid or oversized injected DAGs are rejected. Per-dispatch opt-out: architectReview=false.',
  ),
  notifyDispatchSession: Schema.boolean().default(true).description(
    'Notify only the owning live chat when its run finishes, pauses or needs a human decision. Closed chats are not woken.',
  ),
  retryBackoffBaseMs: runtimeNumber('retryBackoffBaseMs').description(
    'Retry delay: base × 2^(attempt-1), capped at 60 seconds. Retries wake autonomously.',
  ),
  circuitBreakerThreshold: runtimeNumber('circuitBreakerThreshold').description(
    'Failures within 30 seconds that pause retries for the cooldown (0 disables).',
  ),
  circuitBreakerCooldownMs: runtimeNumber('circuitBreakerCooldownMs').description(
    'Circuit-breaker retry cooldown in milliseconds.',
  ),
  spawnTimeoutSeconds: runtimeNumber('spawnTimeoutSeconds').description(
    'Sliding no-progress timeout while a child starts or runs, in seconds (0 disables). Heartbeats rearm it.',
  ),
  bootGraceSeconds: Schema.natural().default(3).min(3).max(3600).description(
    'After plugin load, wait this many seconds for the spawn provider before orphan recovery.',
  ),
  maxSubagentDepth: Schema.natural().default(1).min(0).max(8).description(
    'Absolute delegation-depth cap. 1 permits task agents but no grandchildren; 0 disables the bound.',
  ),
})
