import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_VERSION = '0.2.0'

function defaultStorageDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'swarm')
}

export interface SwarmConfig {
  storageDir: string
  maxConcurrent: number
  staleTimeoutSeconds: number
  maxRetries: number
  reviewLoops: number
  requireManualEndorsement: boolean
  spawnStaggerMs: number
  adaptiveConcurrency: boolean
}

export const Config = Schema.object({
  storageDir: Schema.string().default(defaultStorageDir()).description(
    'Directory for the swarm event log and duty table ($DSH_HOME/storages/swarm by default).',
  ),
  maxConcurrent: Schema.number().default(5).min(1).max(32).description(
    'Maximum simultaneously running task agents.',
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
})
