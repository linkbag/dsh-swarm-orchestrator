import type { TaskSpec } from './types.js'

export interface DagValidation {
  valid: boolean
  errors: string[]
}

/**
 * Validate a submitted task DAG: unique ids, non-empty subjects, known roles
 * optionally checked by the caller, blockedBy references that exist, and no
 * cycles. Returns every problem found at once.
 */
export function validateDag(tasks: TaskSpec[]): DagValidation {
  const errors: string[] = []
  const ids = new Set(tasks.map((task) => task.id))
  if (ids.size !== tasks.length) errors.push('task ids must be unique within a run')
  for (const task of tasks) {
    if (task.id.length === 0) errors.push('every task needs a non-empty id')
    if (task.subject.trim().length === 0) errors.push(`task ${task.id || '(no id)'} needs a subject`)
    if (task.role.trim().length === 0) errors.push(`task ${task.id || '(no id)'} needs a role`)
    for (const blocker of task.blockedBy ?? []) {
      if (!ids.has(blocker)) errors.push(`task ${task.id} is blockedBy unknown task ${blocker}`)
    }
  }
  // Cycle detection: DFS over blockedBy edges (blocker → dependent).
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    for (const blocker of task.blockedBy ?? []) {
      const list = dependents.get(blocker) ?? []
      list.push(task.id)
      dependents.set(blocker, list)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (visited.has(id) || errors.length > 20) return
    if (visiting.has(id)) {
      errors.push(`dependency cycle: ${[...path, id].join(' → ')}`)
      return
    }
    visiting.add(id)
    for (const next of dependents.get(id) ?? []) visit(next, [...path, id])
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id, [])
  return { valid: errors.length === 0, errors }
}
