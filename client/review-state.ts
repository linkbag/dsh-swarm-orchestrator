import type { BoardTask } from './board-store'
import type { Translate } from './locale'

export type ReviewState = 'approved' | 'exhausted' | 'unavailable' | 'skipped' | 'not-requested' | 'invalidated' | 'human-pending' | 'pending' | 'changes-requested' | 'waiting'

/** reviewed means a verdict was recorded, not necessarily an approval. */
export function reviewState(task: BoardTask): ReviewState {
  if (task.attemptRevoked === true) return 'invalidated'
  if (task.reviewExhausted === true) return 'exhausted'
  if (task.reviewUnavailable === true) return 'unavailable'
  if (task.status === 'reviewing') return task.humanReview === true || task.reviewGate === 'human' ? 'human-pending' : 'pending'
  if (task.reviewed === true) return task.status === 'completed' ? 'approved' : 'changes-requested'
  if (task.reviewBy === undefined && task.reviewGate !== 'human' && task.humanReview !== true && task.reviewerAgent === undefined) return 'not-requested'
  return task.status === 'completed' ? 'skipped' : 'waiting'
}

export function reviewLabel(task: BoardTask, t: Translate): string {
  return t(`review.state.${reviewState(task)}`)
}

export function agentIdentity(agent: BoardTask['agent'], fallback: string): string {
  if (agent === undefined) return fallback
  return [agent.label, agent.model === undefined ? undefined : `${agent.provider ?? ''}/${agent.model}`, agent.effort].filter(Boolean).join(' · ')
}
