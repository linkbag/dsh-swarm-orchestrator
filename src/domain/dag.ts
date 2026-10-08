import { assertAllowedKeys, DAG_LIMITS, isPlainRecord } from './limits.js'
import type { TaskSpec } from './types.js'

export interface DagValidation {
  valid: boolean
  errors: string[]
}

const TASK_KEYS = ['id', 'subject', 'description', 'role', 'blockedBy', 'reviewBy', 'model', 'evidence', 'reviewGate', 'writes']
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * Validate shape and resource limits before building a graph. Cycle detection
 * is iterative (Kahn's algorithm), with O(tasks + edges) memory and time; a
 * submitted chain can never exhaust the JavaScript call stack. Roles themselves
 * remain checked against the duty table by the service.
 */
export function validateDag(tasks: TaskSpec[]): DagValidation {
  const errors: string[] = []
  const fail = (message: string): void => { if (errors.length < DAG_LIMITS.errors) errors.push(message) }
  const result = (): DagValidation => ({ valid: errors.length === 0, errors })
  try {
    if (!Array.isArray(tasks)) return { valid: false, errors: ['tasks must be an array'] }
    if (tasks.length === 0) return { valid: false, errors: ['a run needs at least one task'] }
    if (tasks.length > DAG_LIMITS.tasks) return { valid: false, errors: [`a run may have at most ${DAG_LIMITS.tasks} tasks`] }
  } catch {
    return { valid: false, errors: ['task DAG cannot be read safely'] }
  }

  let totalChars = 0
  let edges = 0
  const ids = new Set<string>()
  const text = (value: unknown, label: string, max: number, required = true, identifier = false): boolean => {
    if (typeof value !== 'string') {
      fail(`${label} must be a string`)
      return false
    }
    totalChars += value.length
    if (value.length > max || value.includes('\0') || (required && value.trim().length === 0)) {
      fail(`${label} must be ${required ? 'non-empty and ' : ''}at most ${max} characters without NUL`)
      return false
    }
    if (identifier && (!SAFE_ID.test(value) || RESERVED_IDS.has(value))) {
      fail(`${label} must be a safe identifier (letters, digits, hyphens or underscores)`)
      return false
    }
    return true
  }
  const strings = (value: unknown, label: string, count: number, chars: number, identifier = false): void => {
    if (!Array.isArray(value) || value.length > count) {
      fail(`${label} must be an array of at most ${count} strings`)
      return
    }
    const seen = new Set<string>()
    for (const entry of value) {
      if (text(entry, label, chars, true, identifier)) {
        if (seen.has(entry)) fail(`${label} must not contain duplicate entries`)
        seen.add(entry)
      }
    }
  }

  try {
    // This pass is bounded even when the caller bypasses the TypeScript types.
    for (let index = 0; index < tasks.length; index += 1) {
      const task: unknown = tasks[index]
      const label = `task ${index + 1}`
      if (!isPlainRecord(task)) {
        fail(`${label} must be a plain object`)
        continue
      }
      try { assertAllowedKeys(task, TASK_KEYS, label) } catch (error) { fail((error as Error).message) }
      if (text(task.id, `${label} id`, DAG_LIMITS.idChars, true, true)) {
        if (ids.has(task.id as string)) fail('task ids must be unique within a run')
        ids.add(task.id as string)
      }
      text(task.subject, `${label} subject`, DAG_LIMITS.subjectChars)
      text(task.description, `${label} description`, DAG_LIMITS.descriptionChars, false)
      text(task.role, `${label} role`, DAG_LIMITS.idChars, true, true)
      if (task.reviewBy !== undefined) text(task.reviewBy, `${label} reviewBy`, DAG_LIMITS.idChars, true, true)
      if (task.reviewGate !== undefined && task.reviewGate !== 'agent' && task.reviewGate !== 'human') {
        fail(`${label} reviewGate must be agent or human`)
      }
      if (task.blockedBy !== undefined) {
        strings(task.blockedBy, `${label} blockedBy`, DAG_LIMITS.blockersPerTask, DAG_LIMITS.idChars, true)
        if (Array.isArray(task.blockedBy)) edges += task.blockedBy.length
      }
      if (task.writes !== undefined) strings(task.writes, `${label} writes`, DAG_LIMITS.pathsPerTask, DAG_LIMITS.pathChars)
      if (task.model !== undefined) {
        if (!isPlainRecord(task.model)) fail(`${label} model must be a plain object`)
        else {
          try { assertAllowedKeys(task.model, ['provider', 'model', 'reasoningEffort'], `${label} model`) } catch (error) { fail((error as Error).message) }
          text(task.model.provider, `${label} model.provider`, DAG_LIMITS.modelChars)
          text(task.model.model, `${label} model.model`, DAG_LIMITS.modelChars)
          if (task.model.reasoningEffort !== undefined) text(task.model.reasoningEffort, `${label} model.reasoningEffort`, 64)
        }
      }
      if (task.evidence !== undefined) {
        if (!isPlainRecord(task.evidence)) fail(`${label} evidence must be a plain object`)
        else {
          try { assertAllowedKeys(task.evidence, ['files', 'commands'], `${label} evidence`) } catch (error) { fail((error as Error).message) }
          if (task.evidence.files !== undefined) strings(task.evidence.files, `${label} evidence.files`, DAG_LIMITS.evidenceFiles, DAG_LIMITS.pathChars)
          if (task.evidence.commands !== undefined) strings(task.evidence.commands, `${label} evidence.commands`, DAG_LIMITS.evidenceCommands, DAG_LIMITS.commandChars)
        }
      }
      if (edges > DAG_LIMITS.edges) return { valid: false, errors: [`a run may have at most ${DAG_LIMITS.edges} dependency edges`] }
      if (totalChars > DAG_LIMITS.totalChars) return { valid: false, errors: [`task text exceeds ${DAG_LIMITS.totalChars} characters per run`] }
      if (errors.length >= DAG_LIMITS.errors) return result()
    }
    // Never traverse malformed arrays/objects, duplicate IDs, or excessive input.
    if (errors.length > 0) return result()

    const dependents = new Map<string, string[]>()
    const indegree = new Map<string, number>()
    for (const task of tasks) {
      indegree.set(task.id, task.blockedBy?.length ?? 0)
      for (const blocker of task.blockedBy ?? []) {
        if (!ids.has(blocker)) {
          fail(`task ${task.id} is blockedBy unknown task ${blocker}`)
          continue
        }
        const list = dependents.get(blocker) ?? []
        list.push(task.id)
        dependents.set(blocker, list)
      }
    }
    if (errors.length > 0) return result()
    const ready = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id)
    let visited = 0
    for (let cursor = 0; cursor < ready.length; cursor += 1) {
      visited += 1
      for (const id of dependents.get(ready[cursor]) ?? []) {
        const degree = indegree.get(id)! - 1
        indegree.set(id, degree)
        if (degree === 0) ready.push(id)
      }
    }
    if (visited !== tasks.length) {
      const remaining = tasks.filter((task) => indegree.get(task.id)! > 0).map((task) => task.id)
      fail(`dependency cycle: ${remaining.slice(0, 10).join(' → ')}${remaining.length > 10 ? ' → …' : ''}`)
    }
  } catch {
    fail('task DAG cannot be read safely')
  }
  return result()
}
