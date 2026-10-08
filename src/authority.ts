import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { captureDelegatedPolicyOverrides, type DelegatedPolicyOverrides } from '@deepseek-ai/dsh-subagent'

export type AuthorityMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Durable, caller-derived authority. Never accepted from a model or dashboard body. */
export interface ExecutionAuthority {
  version: 1
  sandbox: { mode: AuthorityMode; workspaceRoot: string }
  delegated: { sandboxMode: AuthorityMode; approvalPolicy: 'never' }
}

interface PolicyService {
  resolve(request?: { session?: Agent['session'] }): { mode: AuthorityMode; workspaceRoot: string }
}

export function validAuthority(value: unknown): value is ExecutionAuthority {
  if (value === null || typeof value !== 'object') return false
  const a = value as Partial<ExecutionAuthority>
  const mode = a.sandbox?.mode
  return a.version === 1
    && (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access')
    && typeof a.sandbox?.workspaceRoot === 'string' && isAbsolute(a.sandbox.workspaceRoot)
    && a.delegated?.sandboxMode === mode && a.delegated.approvalPolicy === 'never'
}

/** Capture synchronously, before dispatch yields. Deployment defaults are pinned too. */
export function captureAuthority(ctx: Context, parent: Agent | undefined, workspace?: string): ExecutionAuthority {
  const policyService = ctx.get('sandboxPolicy') as PolicyService | undefined
  const delegated: DelegatedPolicyOverrides | undefined = parent?.ctx === undefined
    ? undefined : captureDelegatedPolicyOverrides(parent)
  const resolved = policyService?.resolve(parent?.session === undefined ? {} : { session: parent.session })
  // An agentless/undeclared composition never grants full access by omission.
  const rank: Record<AuthorityMode, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
  const requested = delegated?.sandboxMode ?? resolved?.mode ?? 'read-only'
  const ceiling = resolved?.mode ?? 'read-only'
  const mode = parent === undefined ? 'read-only' : rank[requested] <= rank[ceiling] ? requested : ceiling
  const authority: ExecutionAuthority = {
    version: 1,
    sandbox: { mode, workspaceRoot: resolved?.workspaceRoot ?? resolve(workspace ?? process.cwd()) },
    delegated: { sandboxMode: mode, approvalPolicy: 'never' },
  }
  if (!validAuthority(authority)) throw new Error('could not capture a valid dispatch sandbox authority')
  return authority
}

/** Small structural seam matching the inspected current Shell API, not a raw host process. */
export interface EvidenceShell {
  readonly sandboxMode?: AuthorityMode
  resolve(request: {
    command: string
    workdir: string
    timeoutMs: number
    onExpiry: 'kill'
    stdoutMaxBytes: number
    signal: AbortSignal
    sandboxPolicy: ExecutionAuthority['sandbox']
  }): unknown
  execute(spec: never): Promise<{
    kill(): boolean
    done: Promise<void>
    result(): Promise<{
      exitCode: number | null
      timedOut: boolean
      aborted: boolean
      stdout: { text: string }
      stderr: { text: string }
      sandbox?: { mode: AuthorityMode; denied: boolean; runnerFailed?: boolean }
    }>
  }>
}
