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
  /** Effort ladder (A1): on spawn/turn failure the next entry is tried, ending at inherit. */
  effortFallbacks?: string[]
  /** Optional tool restriction applied to this role's task agents (J1; spawn provider toolFilter capability). */
  toolFilter?: { deny?: string[]; allow?: string[] }
  /** Per-role concurrency cap (C3); unset = the global maxConcurrent applies. */
  maxConcurrent?: number
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

export type RunStatus = 'planning' | 'awaiting-endorsement' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'
export type TaskStatus =
  | 'pending' | 'ready' | 'dispatching' | 'running' | 'reviewing'
  | 'retrying' | 'completed' | 'failed' | 'blocked'

/** Machine-checkable proof a task must produce before it may close (J2 evidence contract). */
export interface TaskEvidence {
  /** Files (relative to the run workspace) that must exist and be non-empty. */
  files?: string[]
  /** Shell commands that must exit 0 (run in the task agent's workspace). */
  commands?: string[]
}

/** Task as submitted by the swarm-lead (main session) via swarm_dispatch. */
export interface TaskSpec {
  id: string
  subject: string
  description: string
  role: RoleId
  blockedBy?: string[]
  /** Role that reviews this task's output before it counts as done (review loop, capped by reviewLoops). */
  reviewBy?: RoleId
  /** Per-task model override (K4): wins over the role's pinned chain; unset = role chain / run default. */
  model?: ModelRef
  /** Evidence contract (J2): machine-checked before the task may close. */
  evidence?: TaskEvidence
  /** 'human' routes the review verdict to a dashboard Approve/Reject instead of an agent reviewer (J7). */
  reviewGate?: 'agent' | 'human'
  /** Files this task may write (exclusive scope). Overlapping scopes between concurrent tasks produce a dispatch warning. */
  writes?: string[]
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
  /** Human-gated review pending (J7). */
  humanReview?: boolean
  /** Timestamp of the last heartbeat — the board greys stale notes (B2). */
  lastNoteAt?: number
  /** Timestamp of the last watchdog silence nudge. */
  nudgedAt?: number
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

/**
 * Dispatch context captured from the dispatching agent while it is alive, so
 * the run can spawn task agents after that session is gone (anchor agents
 * join this preset and route; unpinned duty roles inherit this model).
 */
export interface RunDispatchContext {
  sessionId?: string
  presetId?: string
  provider?: string
  model?: string
  cwd?: string
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
  dispatch?: RunDispatchContext
  /** Set while status = paused (A3): why the run stopped waiting for human action. */
  pauseReason?: string
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
  | 'run/failed'
  | 'run/paused'
  | 'run/resumed'
  | 'run/aborted'
  | 'task/started'
  | 'task/agent-started'
  | 'task/heartbeat'
  | 'task/model-fallback'
  | 'task/completed'
  | 'task/failed'
  | 'task/blocked'
  | 'task/unblocked'
  | 'task/nudged'
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
  /** Non-fatal notices (e.g. concurrent tasks declaring overlapping write scopes). */
  warnings?: string[]
}
