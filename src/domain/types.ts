// Core domain types for the swarm orchestrator. Everything here is plain,
// lossless JSON — safe to persist, serve over HTTP/SSE, and render in the UI.

export type RoleId = string

/** One model assignment: provider route + model id (+ optional effort, applied via request interception). */
export interface ModelRef {
  provider: string
  model: string
  reasoningEffort?: string
}

/** A role in the duty table (architect / builder / reviewer / integrator, or custom). */
export interface RoleConfig {
  id: RoleId
  label: string
  description: string
  /** Unset provider/model = inherit the deployment's default model. */
  provider?: string
  model?: string
  maxTokens?: number
  /** Applied by intercepting the child's LLM requests (AgentOptions has no effort field). */
  reasoningEffort?: string
  /** Ordered fallback chain tried when the primary model is unavailable. */
  fallbacks: ModelRef[]
  /** Per-child persona shadowing the deployment persona for agents in this role. */
  persona?: string
}

/** The persisted duty table (v4 duty-table.json successor). */
export interface DutyTable {
  version: 1
  updatedAt: number
  /** When set with enabled=true, dashboard edits are locked (manual override lock). */
  override?: { enabled: boolean; note?: string; setBy?: string; at: number }
  roles: Record<RoleId, RoleConfig>
}

export type RunStatus = 'planning' | 'awaiting-endorsement' | 'running' | 'completed' | 'aborted'
export type TaskStatus =
  | 'pending' | 'ready' | 'dispatching' | 'running' | 'reviewing'
  | 'retrying' | 'completed' | 'failed' | 'blocked'

/** Task as submitted by the swarm-lead (main session) via swarm_dispatch. */
export interface TaskSpec {
  id: string
  subject: string
  description: string
  role: RoleId
  blockedBy?: string[]
  /** Role that reviews this task's output before it counts as done (review loop, capped by reviewLoops). */
  reviewBy?: RoleId
}

/** Task state folded from the event log. */
export interface Task extends TaskSpec {
  runId: string
  status: TaskStatus
  attempts: number
  agent?: { label: string; provider?: string; model?: string }
  blockedReason?: string
  lastNote?: string
  summary?: string
  /** Review-loop bookkeeping. */
  reviews?: number
  reviewFeedback?: string
  reviewed?: boolean
  reviewExhausted?: boolean
  updatedAt: number
}

/** End-of-run report (ESR successor), attached to the run on completion. */
export interface RunReport {
  completedAt: number
  durationMs: number
  taskCount: number
  byStatus: Record<string, number>
  stats: { fallbacks: number; retries: number; reviewsPassed: number; reviewsRejected: number }
  tasks: Array<{ id: string; role: RoleId; model?: string; status: TaskStatus; reviewed?: boolean; summary?: string }>
}

export interface Run {
  id: string
  title: string
  spec: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  endorsedAt?: number
  completedAt?: number
  taskIds: string[]
  report?: RunReport
  /** Live counters folded from task events. */
  stats?: { fallbacks: number; retries: number; reviewsPassed: number; reviewsRejected: number }
}

/** One append-only event record (JSONL line). */
export interface SwarmEventRecord {
  seq: number
  at: number
  kind: string
  runId?: string
  taskId?: string
  data?: Record<string, unknown>
}

/** Canonical event kinds (documented vocabulary; unknown kinds are preserved on replay). */
export type SwarmEventKind =
  | 'run/created'
  | 'run/endorsed'
  | 'run/started'
  | 'run/completed'
  | 'run/aborted'
  | 'task/started'
  | 'task/agent-started'
  | 'task/heartbeat'
  | 'task/model-fallback'
  | 'task/completed'
  | 'task/failed'
  | 'task/blocked'
  | 'task/review-started'
  | 'task/reviewed'
  | 'duty/updated'

/** Input to SwarmService.dispatch. */
export interface DispatchInput {
  title: string
  spec: string
  tasks: TaskSpec[]
  endorse?: boolean
  parentSessionId?: string
}

export interface DispatchResult {
  runId: string
  status: RunStatus
  taskCount: number
  invalid?: string[]
}
