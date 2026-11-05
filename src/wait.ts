import type { SwarmEventRecord } from './domain/types.js'

export type WaitMode = 'meaningful' | 'any' | 'terminal' | 'drained' | 'any-final'
export interface WaitOptions { afterSeq?: number; mode?: WaitMode; maxChars?: number }
export const WAIT_MODES: readonly WaitMode[] = ['meaningful', 'any', 'terminal', 'drained', 'any-final']

export function meaningfulEvent(event: SwarmEventRecord): boolean {
  return !['task/heartbeat', 'task/nudged', 'task/progress', 'run/heartbeat'].includes(event.kind)
}

export function validateWaitOptions(options: WaitOptions): void {
  if (options.afterSeq !== undefined && (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0)) throw new Error('afterSeq must be a nonnegative safe cursor')
  if (options.mode !== undefined && !WAIT_MODES.includes(options.mode)) throw new Error('invalid wait mode')
  if (options.maxChars !== undefined && (!Number.isSafeInteger(options.maxChars) || options.maxChars < 512 || options.maxChars > 24000)) throw new Error('maxChars must be 512..24000')
}
