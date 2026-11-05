import type { LlmFailure } from '@deepseek-ai/dsh-llm'

export type FailureKind = 'cancelled' | 'permanent' | 'quota' | 'transient' | 'effort' | 'unknown'
export interface ClassifiedFailure { kind: FailureKind; code: string; status?: number; retryAfterMs?: number; requestId?: string }

export function structuredFailure(value: unknown): ClassifiedFailure | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.code !== 'string') return undefined
  return classifyLlmFailure({ code: record.code, ...(typeof record.status === 'number' ? { status: record.status } : {}), ...(typeof record.providerRetryAfterMs === 'number' ? { providerRetryAfterMs: record.providerRetryAfterMs } : {}), ...(typeof record.requestId === 'string' ? { requestId: record.requestId as LlmFailure['requestId'] } : {}) })
}

/** Typed codes/status take priority; elapsed time or empty output prove nothing. */
export function classifyLlmFailure(failure: Pick<LlmFailure, 'code' | 'status' | 'providerRetryAfterMs' | 'requestId'> | undefined, cancelled = false): ClassifiedFailure {
  const code = failure?.code ?? 'UNKNOWN'
  const status = failure?.status
  let kind: FailureKind = 'unknown'
  if (cancelled || /^(ABORTED|CANCELLED|CANCELED)$/.test(code)) kind = 'cancelled'
  else if (status === 401 || status === 403) kind = 'permanent'
  else if (/^(UNSUPPORTED_REASONING_EFFORT|INVALID_REASONING_EFFORT)$/.test(code)) kind = 'effort'
  else if (/QUOTA|CREDITS_EXHAUSTED|INSUFFICIENT_BALANCE/.test(code)) kind = 'quota'
  else if (status === 401 || status === 403 || /^(AUTHENTICATION|AUTH|UNAUTHORIZED|FORBIDDEN|INVALID_API_KEY|CONFIG|INVALID_REQUEST|MODEL_NOT_FOUND|PROVIDER_NOT_FOUND|BUDGET_EXHAUSTED|INVALID_CREDENTIAL|MISSING_CREDENTIAL|OBSERVED_REQUEST_LIMIT|LEDGER_CAPACITY|LEDGER_POISONED|APPEND_UNCERTAIN)$/.test(code)) kind = 'permanent'
  else if (status === 429 || status !== undefined && status >= 500 && status <= 599 || /^(RATE_LIMIT|SERVER|TIMEOUT|TRANSPORT|EMPTY_RESPONSE|ECONNRESET|ETIMEDOUT)$/.test(code)) kind = 'transient'
  else if (status !== undefined && status >= 400 && status < 500) kind = 'permanent'
  return { kind, code, ...(status !== undefined ? { status } : {}), ...(failure?.providerRetryAfterMs !== undefined ? { retryAfterMs: Math.min(60000, Math.max(0, failure.providerRetryAfterMs)) } : {}), ...(failure?.requestId !== undefined ? { requestId: String(failure.requestId).slice(0, 256) } : {}) }
}
