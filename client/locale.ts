// Swarm interface localization. The DSH client locale service owns the language
// preference (Settings → General → Language) and the dictionary registry; this
// module registers the `swarm` namespace in English and 简体中文, binds a
// translate function, and exposes a React hook that re-renders on locale
// switch — so the Swarm UI always follows the DSH system language.
//
// Mechanics (mirrors the shipped model-selection plugin):
//  - `locale.register(ns, tag, dict)` — the untyped form, one locale per call;
//    lookups walk the active language's fallback chain (zh → en) then English.
//  - `locale.bind(ns)` — stable translate function reading the active locale at
//    call time; our React hook subscribes to the snapshot revision so a switch
//    re-renders every translated component.
//  - Templates interpolate `{name}` placeholders; a missing key renders the key
//    itself, and the English dictionary is the completion reference.
//
// `initLocale` is wired from apply(); components call `useT()`. Non-React
// surfaces (the badge) read `t()` directly and refresh on locale change.

import { useCallback, useSyncExternalStore } from 'react'

export const SWARM_LOCALE_NS = 'swarm'

/** The slice of the DSH client locale service this module needs. */
export interface LocaleLike {
  register(ns: string, localeTag: string, dict: Record<string, string>): () => void
  bind(ns: string): (key: string) => string
  getSnapshot?(): { revision: number }
  subscribe?(fn: () => void): () => void
}

const en: Record<string, string> = {
  'tab.board': 'Board',
  'tab.flow': 'Flow',
  'tab.roster': 'Roster',

  'scope.workspace': 'This workspace',
  'scope.all': 'All',
  'scope.title': 'Which runs this tab shows',
  'scope.unresolvableTitle': "Couldn't resolve this chat's workspace — showing all runs",
  'scope.showWorkspace': 'Show runs from this workspace',

  'pill.offline': 'host offline',
  'pill.connecting': 'connecting…',
  'pill.info': 'v{version} · seq {seq} · {count} run{plural}',

  'status.planning': 'planning',
  'status.awaiting-endorsement': 'awaiting endorsement',
  'status.running': 'running',
  'status.dispatching': 'dispatching',
  'status.reviewing': 'reviewing',
  'status.paused': 'paused',
  'status.retrying': 'retrying',
  'status.pending': 'pending',
  'status.completed': 'completed',
  'status.failed': 'failed',
  'status.blocked': 'blocked',
  'status.aborted': 'aborted',

  'time.seconds': '{n}s ago',
  'time.minutes': '{n}m ago',
  'time.hours': '{n}h ago',
  'time.days': '{n}d ago',

  'board.connecting': 'Connecting to the swarm host…',
  'board.emptyTitle': 'No swarm runs yet.',
  'board.emptyHint': 'Ask the agent to decompose work and call swarm_dispatch — runs appear here live.',
  'roster.unresolvable': "Couldn't resolve this chat's workspace — showing the shared roster for all workspaces.",
  'flow.noRun': 'No run selected — dispatch a run or pick one on the Board first.',

  'run.created': 'created {time}',
  'run.finished': 'finished {time}',
  'run.elapsed': 'elapsed {time}',
  'run.others': '⚠ {count} other active run{plural} in this workspace: {titles}',
  'run.endorse': '✓ Endorse & Launch',
  'run.resumeTitle': 'Requeue failed tasks and keep completed ones',
  'run.resume': '↻ Resume',
  'run.abort': 'Abort',
  'run.failedBanner': '✖ Run failed — see the Failed/Blocked column. Fix the cause, then Resume to requeue failed tasks (completed tasks are kept).',
  'run.report': 'Run report — {count} tasks in {seconds}s · {fallbacks} fallback{plural} · {retries} · {passed}/{total} reviews passed',
  'run.reviewExhausted': 'review loop exhausted',

  'col.queued': 'Queued',
  'col.running': 'Running',
  'col.done': 'Done',
  'col.attention': 'Failed / Blocked',

  'task.reviewedByTitle': 'reviewed by {role}',
  'task.humanReviewTitle': 'awaiting human review',
  'task.reviewLoopTitle': 'review loop: {role}',
  'task.noNoteTitle': 'no progress note recently — the watchdog is watching this task',
  'task.noteFrom': 'note from {time}',
  'task.retry': '↻ Retry task',

  'field.task': 'Task',
  'field.status': 'Status',
  'field.role': 'Role',
  'field.model': 'Model',
  'field.deploymentDefault': 'deployment default',
  'field.dependsOn': 'Depends on',
  'field.reviewedBy': 'Reviewed by',
  'field.rounds': '({count} round{plural})',
  'field.loopExhausted': ' — loop exhausted, output stands',
  'field.writeScope': 'Write scope',
  'field.attempts': 'Attempts',
  'field.updated': 'Updated',
  'field.brief': 'Brief',
  'field.finalSummary': 'Final summary',
  'field.reviewerFeedback': 'Reviewer feedback',
  'field.latestNote': 'Latest note',

  'review.pending': 'Human review pending',
  'review.approve': '✓ Approve',
  'review.reject': '✖ Reject (send back with feedback)',

  'roster.catalogLive': '{providers} provider(s) / {models} model(s) live',
  'roster.loadingCatalog': 'loading catalog…',
  'roster.refreshCatalog': 'refresh catalog',
  'roster.overrideLock': 'manual override lock',
  'roster.lockNotePh': 'lock note (why pinned)',
  'roster.saveClearsLock': 'Save (clears lock)',
  'roster.save': 'Save duty table',
  'roster.savedAt': 'saved at {time}',
  'roster.remove': 'remove',
  'roster.field.model': 'model',
  'roster.field.effort': 'effort',
  'roster.field.maxTokens': 'max tokens',
  'roster.field.fallbacks': 'fallback chain',
  'roster.field.noFallbacks': 'none — a failed primary blocks the task',
  'roster.up': 'up',
  'roster.down': 'down',
  'roster.fallbackRemove': 'x',
  'roster.field.effortLadder': 'effort ladder (A1)',
  'roster.ph.effortLadder': 'e.g. high, medium (tried in order)',
  'roster.field.cap': 'role concurrency cap (C3)',
  'roster.ph.globalDefault': 'global default',
  'roster.field.spawnTimeout': 'spawn timeout (sec)',
  'roster.ph.spawnTimeout': 'runtime default',
  'roster.spawnTimeoutHint': "Hard ceiling for the spawn phase only (child has not reported started). After start, liveness is judged by progress checkpoints, not by this clock. Empty = the runtime default.",
  'roster.field.toolFilter': "tool filter (J1 — deny list for this role's agents)",
  'roster.ph.toolFilter': 'e.g. bash, write (comma-separated tool names)',
  'roster.field.persona': 'persona & description',
  'roster.ph.label': 'display label',
  'roster.ph.description': 'one-line role description',
  'roster.ph.personaText': 'persona text',
  'roster.ph.newRole': 'new role id (kebab-case, e.g. doc-writer)',
  'roster.addRole': '+ add role',
  'roster.ph.default': 'default',
  'roster.effortInherit': 'inherit',

  'select.inherit': 'inherit deployment default',
  'select.chooseModel': '(choose a model)',

  'section.title': '🐝 Swarm orchestration',
  'section.description': "Role-based multi-agent runs. Open any chat's Swarm tab for the live board; this section manages the model roster everywhere.",
  'section.offline': 'swarm host offline: {error}',
  'section.summary': '{total} run{plural} total · {active} active{detail} · {done} finished',

  'flow.scheduler': '⌘ scheduler',
  'flow.awaitingEndorsement': 'awaiting endorsement',
  'flow.wave': 'wave {n}',
  'flow.parallelCount': ' · {count} parallel',
  'flow.report': '📄 run report',
  'flow.generated': 'generated',
  'flow.onCompletion': 'on completion',
  'flow.writesTitle': 'writes: {paths}',
  'legend.done': 'done',
  'legend.running': 'running',
  'legend.review': 'review',
  'legend.failed': 'failed',
  'legend.queued': 'queued',

  'phase.doneReviewed': 'done · reviewed',
  'phase.done': 'done',
  'phase.humanReview': 'human review',
  'phase.review': 'review · {role}',
  'phase.running': 'running',
  'phase.dispatching': 'dispatching',
  'phase.retrying': 'retrying (attempt {n})',
  'phase.failed': 'failed',
  'phase.blocked': 'blocked',
  'phase.waiting': 'waiting',
  'phase.queued': 'queued',

  'card.swarmTitle': '🐝 Swarm: {title}',
  'card.dispatchingPill': 'dispatching…',
  'card.runCreated': 'run created',
  'card.failedPill': 'failed',
  'card.live': 'run {runId} · {status} — live progress on the Swarm tab',
  'card.queued': 'queued',
  'card.allDone': 'all done',
  'card.needsAttention': 'needs attention',
  'card.progress': '{running} running · {queued} queued',
  'card.untitled': '(untitled run)',
  'card.reviewedBy': ' · reviewed by {role}',
  'card.after': ' · after {list}',
  'card.endorsed': 'endorsed — dispatching now',
  'card.awaitingEndorsement': 'awaiting your endorsement on the Swarm tab',

  'rt.title': '⚙️ Runtime tuning',
  'rt.description': "Adjust concurrency and hardening parameters — applied live, persisted across restarts. These override the profile's cordis.patch.yml values.",
  'rt.savedAt': 'Saved at {time}',
  'rt.saving': 'Saving…',
  'rt.save': 'Save runtime settings',
  'rt.ph.default': 'default',
  'rt.maxConcurrent.label': 'Max concurrent agents',
  'rt.maxConcurrent.hint': 'Simultaneously running task agents per run (default 5)',
  'rt.maxTotalConcurrentAgents.label': 'Global agent cap',
  'rt.maxTotalConcurrentAgents.hint': 'Max agents across ALL runs (default 5). Agents share the DSH host heap — too many can crash it. Concurrent runs split this budget.',
  'rt.spawnStaggerMs.label': 'Spawn stagger (ms)',
  'rt.spawnStaggerMs.hint': 'Delay between launches in one wave — softens provider load (default 750)',
  'rt.retryBackoffBaseMs.label': 'Retry backoff base (ms)',
  'rt.retryBackoffBaseMs.hint': 'Failed tasks wait base × 2^n before retrying (default 5000 = 5s)',
  'rt.circuitBreakerThreshold.label': 'Circuit breaker threshold',
  'rt.circuitBreakerThreshold.hint': 'Failures within 30s before pausing retries — 0 = off (default 3)',
  'rt.circuitBreakerCooldownMs.label': 'Circuit breaker cooldown (ms)',
  'rt.circuitBreakerCooldownMs.hint': 'How long retries pause after the breaker trips (default 60000 = 60s)',
  'rt.nudgeAfterMinutes.label': 'Nudge after silence (min)',
  'rt.nudgeAfterMinutes.hint': 'Board marker for silent tasks — 0 = off (default 20)',
  'rt.staleTimeoutSeconds.label': 'Stale timeout (sec)',
  'rt.staleTimeoutSeconds.hint': 'Last-resort reclaim for silent agents (default 14400 = 4h)',
  'rt.spawnTimeoutSeconds.label': 'Spawn timeout (sec)',
  'rt.spawnTimeoutSeconds.hint': 'Hard ceiling on one task run — guards the "dispatching" state the watchdog cannot see (default 3600 = 1h; 0 = off)',

  'header.title': 'Swarm runs',
  'header.empty': 'no runs yet — dispatch one from any chat',
  'header.footer': "open a chat's Swarm tab for the live board · Settings → Swarm for the roster",

  'badge.active': '{n} swarm run{plural} active',
  'badge.paused': '{n} swarm run{plural} paused',
  'badge.awaiting': '{n} swarm run{plural} awaiting endorsement',
  'badge.last': 'last swarm run: {status}',
}

const zh: Record<string, string> = {
  'tab.board': '看板',
  'tab.flow': '流程',
  'tab.roster': '分工表',

  'scope.workspace': '本工作区',
  'scope.all': '全部',
  'scope.title': '此标签页显示哪些运行',
  'scope.unresolvableTitle': '无法解析此聊天的工作区——显示全部运行',
  'scope.showWorkspace': '显示此工作区的运行',

  'pill.offline': '主机离线',
  'pill.connecting': '连接中…',
  'pill.info': 'v{version} · seq {seq} · {count} 个运行',

  'status.planning': '规划中',
  'status.awaiting-endorsement': '等待放行',
  'status.running': '运行中',
  'status.dispatching': '派发中',
  'status.reviewing': '评审中',
  'status.paused': '已暂停',
  'status.retrying': '重试中',
  'status.pending': '排队中',
  'status.completed': '已完成',
  'status.failed': '失败',
  'status.blocked': '已阻塞',
  'status.aborted': '已中止',

  'time.seconds': '{n} 秒前',
  'time.minutes': '{n} 分钟前',
  'time.hours': '{n} 小时前',
  'time.days': '{n} 天前',

  'board.connecting': '正在连接 swarm 主机…',
  'board.emptyTitle': '还没有 swarm 运行。',
  'board.emptyHint': '让 agent 分解工作并调用 swarm_dispatch——运行会实时显示在这里。',
  'roster.unresolvable': '无法解析此聊天的工作区——显示所有工作区共用的分工表。',
  'flow.noRun': '未选择运行——请先派发运行，或在看板中选择一个。',

  'run.created': '创建于 {time}',
  'run.finished': '完成于 {time}',
  'run.elapsed': '已运行 {time}',
  'run.others': '⚠ 此工作区还有 {count} 个其他活跃运行：{titles}',
  'run.endorse': '✓ 放行并启动',
  'run.resumeTitle': '重新排队失败任务，保留已完成任务',
  'run.resume': '↻ 恢复',
  'run.abort': '中止',
  'run.failedBanner': '✖ 运行失败——见“失败 / 阻塞”列。修复原因后点“恢复”重新排队失败任务（已完成任务保留）。',
  'run.report': '运行报告 — {count} 个任务，用时 {seconds} 秒 · 回退 {fallbacks} 次 · 重试 {retries} 次 · 评审通过 {passed}/{total}',
  'run.reviewExhausted': '评审循环已用尽',

  'col.queued': '排队',
  'col.running': '运行中',
  'col.done': '完成',
  'col.attention': '失败 / 阻塞',

  'task.reviewedByTitle': '由 {role} 评审',
  'task.humanReviewTitle': '等待人工评审',
  'task.reviewLoopTitle': '评审循环：{role}',
  'task.noNoteTitle': '最近没有进度备注——看门狗正在关注此任务',
  'task.noteFrom': '备注来自 {time}',
  'task.retry': '↻ 重试任务',

  'field.task': '任务',
  'field.status': '状态',
  'field.role': '角色',
  'field.model': '模型',
  'field.deploymentDefault': '部署默认',
  'field.dependsOn': '依赖于',
  'field.reviewedBy': '评审人',
  'field.rounds': '（{count} 轮）',
  'field.loopExhausted': ' — 循环已用尽，结果有效',
  'field.writeScope': '写入范围',
  'field.attempts': '尝试次数',
  'field.updated': '更新时间',
  'field.brief': '任务简报',
  'field.finalSummary': '最终摘要',
  'field.reviewerFeedback': '评审反馈',
  'field.latestNote': '最新备注',

  'review.pending': '等待人工评审',
  'review.approve': '✓ 通过',
  'review.reject': '✖ 驳回（附反馈退回）',

  'roster.catalogLive': '{providers} 个 provider / {models} 个模型（实时）',
  'roster.loadingCatalog': '正在加载模型目录…',
  'roster.refreshCatalog': '刷新目录',
  'roster.overrideLock': '手动覆盖锁定',
  'roster.lockNotePh': '锁定备注（为何锁定）',
  'roster.saveClearsLock': '保存并解除锁定',
  'roster.save': '保存分工表',
  'roster.savedAt': '保存于 {time}',
  'roster.remove': '移除',
  'roster.field.model': '模型',
  'roster.field.effort': '思考等级',
  'roster.field.maxTokens': '最大 tokens',
  'roster.field.fallbacks': '回退链',
  'roster.field.noFallbacks': '无——主模型失败将阻塞任务',
  'roster.up': '上移',
  'roster.down': '下移',
  'roster.fallbackRemove': '移除',
  'roster.field.effortLadder': '思考等级阶梯 (A1)',
  'roster.ph.effortLadder': '例如 high, medium（按顺序尝试）',
  'roster.field.cap': '角色并发上限 (C3)',
  'roster.ph.globalDefault': '全局默认',
  'roster.field.spawnTimeout': '派发超时（秒）',
  'roster.ph.spawnTimeout': '运行时默认',
  'roster.spawnTimeoutHint': '仅限制派发阶段的硬上限（子代理尚未报告启动）。启动之后由进度检查点判断存活性，不受此时钟限制。留空 = 运行时默认。',
  'roster.field.toolFilter': '工具过滤（J1——该角色代理的拒绝列表）',
  'roster.ph.toolFilter': '例如 bash, write（逗号分隔的工具名）',
  'roster.field.persona': '人设与描述',
  'roster.ph.label': '显示名称',
  'roster.ph.description': '一行角色描述',
  'roster.ph.personaText': '人设文本',
  'roster.ph.newRole': '新角色 id（kebab-case，例如 doc-writer）',
  'roster.addRole': '+ 添加角色',
  'roster.ph.default': '默认',
  'roster.effortInherit': '继承',

  'select.inherit': '继承部署默认',
  'select.chooseModel': '（选择模型）',

  'section.title': '🐝 Swarm 编排',
  'section.description': '基于角色的多智能体运行。在任意聊天打开 Swarm 标签页查看实时看板；此区域统一管理模型分工表。',
  'section.offline': 'swarm 主机离线：{error}',
  'section.summary': '共 {total} 个运行 · {active} 个活跃{detail} · {done} 个已结束',

  'flow.scheduler': '⌘ 调度器',
  'flow.awaitingEndorsement': '等待放行',
  'flow.wave': '第 {n} 波',
  'flow.parallelCount': ' · {count} 并行',
  'flow.report': '📄 运行报告',
  'flow.generated': '已生成',
  'flow.onCompletion': '完成后生成',
  'flow.writesTitle': '写入：{paths}',
  'legend.done': '完成',
  'legend.running': '运行',
  'legend.review': '评审',
  'legend.failed': '失败',
  'legend.queued': '排队',

  'phase.doneReviewed': '完成 · 已评审',
  'phase.done': '完成',
  'phase.humanReview': '人工评审',
  'phase.review': '评审 · {role}',
  'phase.running': '运行中',
  'phase.dispatching': '派发中',
  'phase.retrying': '重试中（第 {n} 次）',
  'phase.failed': '失败',
  'phase.blocked': '阻塞',
  'phase.waiting': '等待',
  'phase.queued': '排队',

  'card.swarmTitle': '🐝 Swarm：{title}',
  'card.dispatchingPill': '派发中…',
  'card.runCreated': '运行已创建',
  'card.failedPill': '失败',
  'card.live': '运行 {runId} · {status} —— 在 Swarm 标签页查看实时进度',
  'card.queued': '排队',
  'card.allDone': '全部完成',
  'card.needsAttention': '需要关注',
  'card.progress': '{running} 运行中 · {queued} 排队',
  'card.untitled': '（未命名运行）',
  'card.reviewedBy': ' · 由 {role} 评审',
  'card.after': ' · 在 {list} 之后',
  'card.endorsed': '已放行——正在派发',
  'card.awaitingEndorsement': '等待你在 Swarm 标签页放行',

  'rt.title': '⚙️ 运行时调优',
  'rt.description': '调整并发与加固参数——实时生效，重启后保留。会覆盖 profile 的 cordis.patch.yml 值。',
  'rt.savedAt': '保存于 {time}',
  'rt.saving': '保存中…',
  'rt.save': '保存运行时设置',
  'rt.ph.default': '默认',
  'rt.maxConcurrent.label': '每运行并发代理上限',
  'rt.maxConcurrent.hint': '单个运行同时运行的任务代理数（默认 5）',
  'rt.maxTotalConcurrentAgents.label': '全局代理上限',
  'rt.maxTotalConcurrentAgents.hint': '所有运行共享的代理上限（默认 5）。代理共享 DSH 主机堆内存——过多可能导致崩溃。并发运行会分摊此预算。',
  'rt.spawnStaggerMs.label': '启动错峰 (ms)',
  'rt.spawnStaggerMs.hint': '同一波次内启动之间的延迟——缓解 provider 压力（默认 750）',
  'rt.retryBackoffBaseMs.label': '重试退避基数 (ms)',
  'rt.retryBackoffBaseMs.hint': '失败任务按 基数 × 2ⁿ 等待后重试（默认 5000 = 5 秒）',
  'rt.circuitBreakerThreshold.label': '熔断阈值',
  'rt.circuitBreakerThreshold.hint': '30 秒内的失败次数达到阈值即暂停重试——0 = 关闭（默认 3）',
  'rt.circuitBreakerCooldownMs.label': '熔断冷却时间 (ms)',
  'rt.circuitBreakerCooldownMs.hint': '熔断触发后重试暂停的时长（默认 60000 = 60 秒）',
  'rt.nudgeAfterMinutes.label': '静默提醒阈值（分钟）',
  'rt.nudgeAfterMinutes.hint': '静默任务在看板上的标记——0 = 关闭（默认 20）',
  'rt.staleTimeoutSeconds.label': '僵死超时（秒）',
  'rt.staleTimeoutSeconds.hint': '对静默代理的最后回收手段（默认 14400 = 4 小时）',
  'rt.spawnTimeoutSeconds.label': '派发超时（秒）',
  'rt.spawnTimeoutSeconds.hint': '单个任务运行的硬上限——防止看门狗无法察觉的“派发中”状态（默认 3600 = 1 小时；0 = 关闭）',

  'header.title': 'Swarm 运行',
  'header.empty': '还没有运行——在任意聊天派发一个',
  'header.footer': '打开任意聊天的 Swarm 标签页查看实时看板 · 设置 → Swarm 管理分工表',

  'badge.active': '🐝 {n} 个 swarm 运行进行中',
  'badge.paused': '🐝 {n} 个 swarm 运行已暂停',
  'badge.awaiting': '🐝 {n} 个 swarm 运行等待放行',
  'badge.last': '🐝 上次 swarm 运行：{status}',
}

/** English dictionary — the completion reference and the fallback content. */
export const EN_DICT: Readonly<Record<string, string>> = en

/** Chinese dictionary — must mirror the English key set exactly. */
export const ZH_DICT: Readonly<Record<string, string>> = zh

let boundTranslate: ((key: string) => string) | undefined

/**
 * Register the swarm namespace with the DSH locale service and bind `t`.
 * Safe on hosts without the locale service (translation degrades to English).
 */
export function initLocale(locale: LocaleLike | undefined): void {
  if (locale === undefined) return
  try {
    locale.register(SWARM_LOCALE_NS, 'en', en)
    locale.register(SWARM_LOCALE_NS, 'zh', zh)
    boundTranslate = locale.bind(SWARM_LOCALE_NS)
  } catch {
    boundTranslate = undefined
  }
}

/** Translate `key` through the DSH locale service, interpolating `{var}` slots. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let text: string = key
  try {
    text = boundTranslate !== undefined ? boundTranslate(key) : key
  } catch {
    text = key
  }
  if (text === key) text = en[key] ?? key
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** The translate-function shape components pass down to helpers. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Translate a run/task status word; unknown statuses pass through unchanged. */
export function statusT(status: string): string {
  const translated = t(`status.${status}`)
  return translated === `status.${status}` ? status : translated
}

/**
 * React binding: re-renders the calling component whenever the locale snapshot
 * advances (language switch or late dictionary registration).
 */
export function useLocaleTick(): number {
  const subscribe = useCallback((fn: () => void) => localeRef?.subscribe?.(fn) ?? (() => { }), [])
  const getSnapshot = useCallback(() => localeRef?.getSnapshot?.().revision ?? 0, [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** `useT()` — call inside a component; the component re-renders on locale switch. */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  useLocaleTick()
  return t
}

let localeRef: LocaleLike | undefined

/** Called once from apply(): keeps the service reachable for hooks and events. */
export function setLocaleService(locale: LocaleLike | undefined): void {
  localeRef = locale
}

export function localeService(): LocaleLike | undefined {
  return localeRef
}
