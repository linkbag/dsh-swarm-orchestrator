// Mock swarm run: exercises the recently shipped hardening against the INSTALLED
// package (the shipped bytes in lib/), not src/.
//
// Nothing here touches operator data: every boot gets a temp storage dir and a temp
// $DSH_HOME, no real agent is dispatched, and `cordis` is resolved from the installed
// package so the plugin and this harness share exactly one module graph.
//
//   node scripts/mock-swarm-run.mjs
//
// Exits non-zero if any check fails.
//
// Harness lessons baked in (each cost a wrong verdict once):
//  * A live settings entry is only a model if `id` AND one of
//    name/contextWindow/maxTokens/input are present (`isModelEntry` in lib/preflight.js),
//    otherwise the source is skipped as "declares nothing" and the file fallback wins.
//  * The plugin logs through a namespaced logger, so `ctx.logger.info` cannot be
//    patched; records are read from `ctx.logger.buffer` (args[0] is the format string).
//  * The spawn request carries only {provider, model} — the effort pin's observable
//    carrier is the task record (`task/started`), not `agentOptions`.
//  * Count command executions with a stamped marker. `echo x >> f` under PowerShell
//    writes UTF-16, which read as utf8 looks like MORE lines than there were.
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = process.env.SWARM_PKG ?? 'C:/Users/tsing/.dsh/profiles/web/node_modules/dsh-swarm-orchestrator'
const PROFILE = 'C:/Users/tsing/.dsh/profiles/web'
const LIVE_DOCUMENT = join(PROFILE, 'cordis.patch.yml')
const req = createRequire(join(PKG, 'package.json'))
const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
const swarmPlugin = await import(pathToFileURL(join(PKG, 'lib', 'index.js')).href)
const pluginVersion = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version

const results = []
const temps = []
const contexts = []

function check(id, name, fn) {
  try {
    const detail = fn()
    results.push({ id, name, ok: true, detail: detail ?? '' })
    console.log(`PASS  ${id}  ${name}${detail ? '\n        ' + detail : ''}`)
  } catch (err) {
    results.push({ id, name, ok: false, detail: String(err?.message ?? err) })
    console.log(`FAIL  ${id}  ${name}\n        ${String(err?.message ?? err)}`)
  }
}
const expect = (cond, message) => { if (!cond) throw new Error(message) }

class FakeSubagents {
  calls = []
  n = 0
  start(_provider, request) {
    this.calls.push(request)
    this.n += 1
    return {
      id: `sess-${this.n}`,
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: `finished ${request?.label ?? 'task'}\nVERDICT: APPROVE` }] }),
      dispose: async () => {},
    }
  }
}

function makeAgents(inbox) {
  return {
    create: () => Promise.resolve({ agent: { id: 'anchor-1', session: { header: { id: 'anchor-1', delegationDepth: 0 } } }, dispose: async () => {} }),
    get: (id) => (id === 'parent-1' ? { followup: (m) => { inbox.push(m?.content?.[0]?.text ?? JSON.stringify(m)) } } : undefined),
  }
}

const makeDispatcher = (cwd) => ({
  id: 'parent-1',
  options: { provider: 'zai', model: 'glm-5.3' },
  session: { header: { id: 'parent-1', cwd } },
  ctx: { get: (n) => (n === 'agentPresets' ? { composedPreset: () => 'standard' } : undefined) },
})

/** A pi-ai model as the REAL document declares one — `name` is what makes it a model. */
const model = (id, reasoningEfforts) => ({
  id, name: id.toUpperCase(), contextWindow: 200000, maxTokens: 131072, input: ['text'],
  ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
})

/** Production shape as a file: hand-declared models with NO reasoningEfforts map. */
const MAPLESS_FILE = ['llm-pi-ai:', '  providers:', '    zai:', '      models:', '        - id: glm-5.3', '        - id: glm-5.3-flash'].join('\n')

/** A live settings service in the document's own shape: `{ns, value}` per entry. */
const settingsService = (models, defaultPair = { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' }) => ({
  describe: () => [
    { ns: 'agent-default-model', value: defaultPair },
    { ns: 'llm-pi-ai', value: { providers: { zai: { apiKeyEnv: 'ZAI_API_KEY', models } } } },
  ],
})

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-mock-'))
  const home = mkdtempSync(join(tmpdir(), 'swarm-mock-home-'))
  temps.push(dir, home)
  writeFileSync(join(home, 'settings.yaml'), opts.fileSettings ?? MAPLESS_FILE)
  process.env.DSH_HOME = home

  const ctx = new Context()
  const fake = new FakeSubagents()
  const inbox = []
  ctx.reflect.provide('subagents', fake)
  if (opts.withInbox === true) ctx.reflect.provide('agents', makeAgents(inbox))
  if (opts.settings !== undefined) ctx.reflect.provide('settings', opts.settings)
  await ctx.plugin(swarmPlugin, {
    storageDir: dir,
    maxConcurrent: 5,
    staleTimeoutSeconds: 14400,
    maxRetries: 2,
    reviewLoops: 3,
    requireArchitectReview: false,
    workspaceRunPolicy: 'off',
    retryBackoffBaseMs: 0,
    circuitBreakerThreshold: 0,
    bootGraceSeconds: 3,
    ...(opts.config ?? {}),
  })
  contexts.push(ctx)
  const service = ctx.get('swarm')[Symbol.for('cordis.original')]
  if (service === undefined) throw new Error('swarm service not registered')
  // The plugin logs through a namespaced logger, so `ctx.logger.info` cannot be patched.
  // The buffer works but is a RING: a busy run scrolls the boot line out (that cost a
  // false FAIL), so prefer the real exporter sink — a Map of objects with export().
  const records = []
  try {
    const exporters = ctx.logger.exporters
    if (exporters instanceof Map) exporters.set('mock-swarm-run', { export: (m) => { records.push(m) } })
  } catch { /* buffer fallback below */ }
  const asRecord = (m) => {
    const args = Array.isArray(m?.args) ? m.args : Array.isArray(m?.message?.args) ? m.message.args : null
    if (args !== null) return { format: String(args[0] ?? ''), args: args.slice(1) }
    const raw = typeof m === 'string' ? m : String(m?.message ?? m?.text ?? '')
    return { format: raw, args: [] }
  }
  const sources = records.length > 0 ? [records] : [ctx.logger.buffer ?? []]
  const preflightRecords = () => sources
    .flat()
    .map(asRecord)
    .filter((r) => (r.format + ' ' + r.args.map(String).join(' ')).includes('effort preflight'))
  const preflightText = () => preflightRecords().map((r) => (r.format + ' ' + r.args.map(String).join(' ')).trim()).join(' | ')
  return { ctx, service, fake, dir, home, inbox, preflightRecords, preflightText }
}

/** Turn-bounded pump: the same lever the suite uses, never a wall-clock budget. */
async function pumpUntil(service, predicate, what, turns = 3000) {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return
    service.tick()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }
  if (predicate()) return
  throw new Error(`unreachable after ${turns} turns: ${what}`)
}

const setRole = (service, patch) => {
  const table = structuredClone(service.duty.get())
  table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3', ...patch }
  service.setDutyTable(table, 'mock')
}
const eventsOf = (dir) => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const startedEffort = (dir, taskId) => eventsOf(dir).filter((e) => e.kind === 'task/started' && e.taskId === taskId).pop()?.data?.effort
const taskOf = (service, runId, id) => service.snapshot().tasks.find((t) => t.runId === runId && t.id === id)

/** Count executions unambiguously: one stamped line per invocation, read as utf8. */
const STAMP = "Add-Content -Path runs.txt -Value ([DateTime]::UtcNow.ToString('HH:mm:ss.fff'))"
const executions = (dir) => (existsSync(join(dir, 'runs.txt')) ? readFileSync(join(dir, 'runs.txt'), 'utf8').trim().split(/\r?\n/).filter(Boolean) : [])

console.log(`mock swarm run against installed dsh-swarm-orchestrator v${pluginVersion}\n${'='.repeat(74)}`)

// ── 1. J21 preflight: live source, honest verdicts, once-only logging ─────────────
{
  // The production shape: a live service whose models carry NO reasoningEfforts map.
  const { service, fake, dir, preflightRecords, preflightText } = await boot({ settings: settingsService([model('glm-5.3')]) })
  setRole(service, { reasoningEffort: 'max' })
  const d = service.dispatch({ title: 'mapless pin', spec: 's', tasks: [{ id: 'p1', subject: 'P', description: 'd', role: 'builder' }] }, makeDispatcher(dir))
  service.endorse(d.runId)
  await pumpUntil(service, () => taskOf(service, d.runId, 'p1')?.status === 'completed', 'task completes')

  check('1a', 'a map-less model KEEPS its pin: absence of a map is not a rejection', () => {
    expect(startedEffort(dir, 'p1') === 'max', `pin was stripped: task/started effort=${JSON.stringify(startedEffort(dir, 'p1'))}`)
    return `task/started effort='max' kept for a model the live source declares with no reasoningEfforts map`
  })

  check('1b', 'the preflight reads the LIVE settings service and says so, once', () => {
    const recs = preflightRecords()
    expect(recs.length === 1, `expected exactly 1 preflight record, saw ${recs.length}: ${preflightText()}`)
    const [source, read, known, mapless] = recs[0].args
    expect(source === 'settings service', `source was ${JSON.stringify(source)} (expected the live service, not the file)`)
    // known=1 is correct here: the default-model pair proves its own level, which counts.
    expect(read === 1 && known === 1 && mapless === 1, `counts: read=${read} known=${known} mapless=${mapless}`)
    return `source="${source}" read=${read} known-levels=${known} declared-without-map=${mapless} (known=1: the default pair proves 'max')`
  })

  // Second dispatch first, so the assertion below stays synchronous like the rest.
  const d2 = service.dispatch({ title: 'second', spec: 's', tasks: [{ id: 'p1b', subject: 'P', description: 'd', role: 'builder' }] }, makeDispatcher(dir))
  service.endorse(d2.runId)
  await pumpUntil(service, () => taskOf(service, d2.runId, 'p1b') !== undefined, 'second dispatch recorded')

  check('1d', 'no per-call spam: still one record after a second run', () => {
    const recs = preflightRecords()
    expect(recs.length === 1, `saw ${recs.length} records after two dispatches`)
    return `${recs.length} record across 2 dispatches (${fake.calls.length} spawns)`
  })
}

{
  // Positive evidence: a declared map that omits the pinned level must still strip.
  // The default pair proves `high` (already in the map, so the union adds nothing) and
  // the pin asks for `max`, which nothing declares -> the only strip-worthy case.
  const { service, dir, preflightRecords } = await boot({
    settings: settingsService([model('glm-5.3', { high: 'high' })], { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' }),
  })
  setRole(service, { reasoningEffort: 'max' })
  const d = service.dispatch({ title: 'positive evidence', spec: 's', tasks: [{ id: 'p2', subject: 'P', description: 'd', role: 'builder' }] }, makeDispatcher(dir))
  service.endorse(d.runId)
  await pumpUntil(service, () => ['completed', 'failed', 'blocked'].includes(taskOf(service, d.runId, 'p2')?.status ?? ''), 'the pinned task reaches a terminal state')

  check('1c', 'a declared map that omits the level DOES strip the pin (positive evidence)', () => {
    const effort = startedEffort(dir, 'p2')
    expect(effort === undefined, `pin survived: task/started effort=${JSON.stringify(effort)} (map declares only 'high')`)
    const [, read, known, mapless] = preflightRecords()[0].args
    expect(known === 1 && mapless === 0, `the declared map was not read as expected: read=${read} known=${known} mapless=${mapless}`)
    return `task/started carries no effort -> stripped; the map was read (read=${read} known=${known} mapless=${mapless})`
  })
}
{
  // The operator's REAL document, read through the same parser.
  const yaml = req('yaml')
  const doc = yaml.parse(readFileSync(LIVE_DOCUMENT, 'utf8'))
  const entries = (Array.isArray(doc) ? doc : []).filter((e) => typeof e?.id === 'string')
  const llm = entries.find((e) => /llm-pi-ai$/i.test(e.id))
  const def = entries.find((e) => /agent-default-model$/i.test(e.id))
  const { service, dir, preflightText, preflightRecords } = await boot({
    settings: { describe: () => [
      ...(def === undefined ? [] : [{ ns: def.id, value: def.config }]),
      ...(llm === undefined ? [] : [{ ns: llm.id, value: llm.config }]),
    ] },
  })
  setRole(service, { reasoningEffort: 'max' })
  const support = service.effortSupport()
  const d = service.dispatch({ title: 'real document', spec: 's', tasks: [{ id: 'r1', subject: 'R', description: 'd', role: 'builder' }] }, makeDispatcher(dir))
  service.endorse(d.runId)
  await pumpUntil(service, () => startedEffort(dir, 'r1') !== undefined || taskOf(service, d.runId, 'r1')?.status === 'failed', 'spawn recorded')

  check('1e', "the operator's REAL settings document: verdicts and counts", () => {
    const models = [...(support?.declaredWithoutMap ?? []), ...(support?.supported ?? [])]
    expect(models.length > 20, `only ${models.length} models read from ${LIVE_DOCUMENT} - entry shape may have changed`)
    expect((support?.declaredLevels?.size ?? 0) === 0, `document unexpectedly declares levels: ${[...(support?.declaredLevels?.keys?.() ?? [])].join(',')}`)
    const text = preflightText()
    const [source, read, known, mapless] = preflightRecords()[0].args
    expect(source === 'settings service', `live source not named: ${text}`)
    expect(read === 51 && known === 0 && mapless === 51, `counts: read=${read} known=${known} mapless=${mapless} (expected 51/0/51)`)
    return `${models.length} models read, ${support.supported.size} with known levels, ${support.declaredWithoutMap.size} without a map`
      + ` | log args: ${JSON.stringify([source, read, known, mapless])}`
      + ` | pinned task kept its pin: ${startedEffort(dir, 'r1') === 'max'}`
  })
}

// ── 2/6. The evidence gate on a false "done", and the human-attention ping ────────
{
  const { service, fake, dir, inbox, preflightRecords, preflightText } = await boot({ withInbox: true })
  // An effort pin is what makes the preflight run at all: it is consulted lazily, only
  // for a role that actually pins a level (see check 1f).
  setRole(service, { reasoningEffort: 'max' })
  const d = service.dispatch({
    title: 'false done',
    spec: 's',
    tasks: [
      { id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { commands: [`${STAMP}; exit 1`] } },
      { id: 'b', subject: 'B', description: 'd', role: 'builder', blockedBy: ['a'] },
    ],
  }, makeDispatcher(dir))
  service.endorse(d.runId)
  await pumpUntil(service, () => taskOf(service, d.runId, 'a')?.status === 'blocked', 'task a blocks')
  await pumpUntil(service, () => taskOf(service, d.runId, 'b')?.status === 'blocked', 'dependent blocks')
  await pumpUntil(service, () => inbox.filter((c) => c.includes('[swarm attention]')).length >= 1, 'ping arrives')

  const taskA = taskOf(service, d.runId, 'a')
  const taskB = taskOf(service, d.runId, 'b')
  const stamps = executions(dir)
  const events = eventsOf(dir)
  const rechecks = events.filter((e) => e.kind === 'task/heartbeat' && e.taskId === 'a' && e.data?.evidence?.recheck === true)
  const pings = inbox.filter((c) => c.includes('[swarm attention]'))

  check('2a', 'a false "done" costs exactly one recheck, then blocks (no respawn)', () => {
    expect(taskA?.status === 'blocked', `status=${taskA?.status}`)
    expect(taskA?.humanReview === true, 'humanReview flag not set')
    expect(fake.calls.length === 1, `child respawned: ${fake.calls.length} spawns`)
    expect(stamps.length === 2, `expected 2 command executions (first + one recheck), saw ${stamps.length}: ${JSON.stringify(stamps)}`)
    expect(rechecks.length === 1, `expected 1 recheck note, saw ${rechecks.length}`)
    expect(/evidence contract failed twice/.test(taskA?.blockedReason ?? ''), `reason=${taskA?.blockedReason}`)
    return `1 spawn, ${stamps.length} executions (${stamps.join(', ')}), ${rechecks.length} recheck note`
  })

  check('2b', 'the verdict records the exit code and an output tail', () => {
    const blocked = events.filter((e) => e.kind === 'task/blocked' && e.taskId === 'a').pop()
    const reason = String(blocked?.data?.reason ?? '')
    const recorded = blocked?.data?.evidence?.commands ?? []
    expect(/exit code 1/.test(reason), `no exit code in: ${reason.slice(0, 120)}`)
    expect(recorded[0]?.exitCode === 1, `recorded exitCode=${JSON.stringify(recorded[0]?.exitCode)}`)
    expect((blocked?.data?.evidence?.firstRun ?? []).length === 1, 'the first run was not recorded separately')
    return `reason="${reason.replace(/\s+/g, ' ').slice(0, 120)}…" exitCode=${recorded[0].exitCode} firstRun recorded`
  })

  check('2c', 'the dependent task blocks on its upstream, not on its own work', () => {
    expect(taskB?.status === 'blocked', `status=${taskB?.status}`)
    expect(/upstream task a did not complete/.test(taskB?.blockedReason ?? ''), `reason=${taskB?.blockedReason}`)
    return `reason="${taskB?.blockedReason}"`
  })

  check('6', 'one aggregated ping names the task, the reason and every option', () => {
    expect(pings.length === 1, `expected 1 ping, saw ${pings.length}`)
    const ping = pings[0]
    for (const needle of ['[swarm attention]', 'task "a"', d.runId, 'swarm_review', 'swarm_retry', 'swarm_complete', 'multiple-choice']) {
      expect(ping.includes(needle), `ping missing ${JSON.stringify(needle)}`)
    }
    return `${pings.length} ping containing the task, run id, all three options and the prompt hint`
  })

  check('1f', 'a busy blocked run still logs the preflight exactly once', () => {
    const recs = preflightRecords()
    expect(recs.length === 1, `saw ${recs.length} records: ${preflightText().slice(0, 200)}`)
    const [, read, known, mapless] = recs[0].args
    return `1 record for a 2-task blocked run (read=${read} known=${known} mapless=${mapless}), captured through the exporter sink — the log buffer is a ring and drops it`
  })
}

// ── 3/5. A true "done" completes, then the run is curated (soft-only) ─────────────
{
  const { service, dir } = await boot({})
  setRole(service, {})
  const before = eventsOf(dir).length
  const d = service.dispatch({
    title: 'true done',
    spec: 's',
    tasks: [{ id: 't1', subject: 'T', description: 'd', role: 'builder', evidence: { commands: ['exit 0'], files: ['events.jsonl'] } }],
  }, makeDispatcher(dir))
  service.endorse(d.runId)
  await pumpUntil(service, () => ['completed', 'failed'].includes(service.snapshot().runs.find((r) => r.id === d.runId)?.status ?? ''), 'run settles')

  check('3', 'a true "done" passes the contract and completes the run', () => {
    const run = service.snapshot().runs.find((r) => r.id === d.runId)
    const task = taskOf(service, d.runId, 't1')
    expect(task?.status === 'completed', `task=${task?.status} reason=${task?.blockedReason}`)
    expect(run?.status === 'completed', `run=${run?.status}`)
    return `task completed and run ${run?.status}`
  })

  check('5a', 'rename trims the title and leaves the status alone', () => {
    service.renameRun(d.runId, '  curated title  ')
    const run = service.snapshot().runs.find((r) => r.id === d.runId)
    expect(run?.title === 'curated title', `title=${JSON.stringify(run?.title)}`)
    expect(run?.status === 'completed', `status changed to ${run?.status}`)
    return `title="curated title", status still ${run?.status}`
  })

  check('5b', 'remove hides it but keeps it restorable', () => {
    service.setRunBoardState(d.runId, 'removed')
    const snap = service.snapshot()
    expect(!snap.runs.some((r) => r.id === d.runId), 'still in the live list')
    expect((snap.removedRuns ?? []).some((r) => r.id === d.runId), 'not in the restorable list')
    return `live=${snap.runs.length}, restorable=${(snap.removedRuns ?? []).length}`
  })

  check('5c', 'restore returns it intact', () => {
    service.setRunBoardState(d.runId, 'visible')
    const run = service.snapshot().runs.find((r) => r.id === d.runId)
    expect(run?.title === 'curated title' && run?.status === 'completed', `title=${run?.title} status=${run?.status}`)
    return `restored as "${run?.title}" [${run?.status}]`
  })

  check('5d', 'permanent removal leaves BOTH lists and destroys nothing', () => {
    service.setRunBoardState(d.runId, 'purged')
    const snap = service.snapshot()
    expect(!snap.runs.some((r) => r.id === d.runId), 'still live')
    expect(!(snap.removedRuns ?? []).some((r) => r.id === d.runId), 'still restorable')
    const view = service.view()
    expect(view.runs.has(d.runId), 'run vanished from the projection - that would be data loss')
    const after = eventsOf(dir).length
    expect(after > before, 'event log did not grow')
    return `absent from both lists; still folded in view() as "${view.runs.get(d.runId)?.title}"; log ${before} -> ${after}`
  })
}

// ── 4. the self-verification prompt ──────────────────────────────────────────────
{
  const { service, fake, dir } = await boot({})
  setRole(service, {})
  const d = service.dispatch({
    title: 'prompt probe',
    spec: 's',
    tasks: [{ id: 'pr', subject: 'P', description: 'd', role: 'builder', evidence: { commands: ['exit 0'], files: ['events.jsonl'] } }],
  }, makeDispatcher(dir))
  service.endorse(d.runId)
  await pumpUntil(service, () => fake.calls.length >= 1, 'child spawned')
  const prompt = (fake.calls[0]?.prompt ?? []).map((p) => p.text ?? '').join('\n')

  check('4', 'the prompt orders the agent to verify its own evidence before claiming done', () => {
    const needles = [
      'run every command above YOURSELF',
      'Never report the task done while any command above fails',
      'report **not done**',
      'the last ~10 lines of output',
      'never a full log',
      'prefer absolute paths',
      'do not assert on git topology',
    ]
    const missing = needles.filter((n) => !prompt.includes(n))
    expect(missing.length === 0, `prompt missing: ${JSON.stringify(missing)}`)
    return `${needles.length}/${needles.length} required instructions present (prompt ${prompt.length} chars)`
  })
}

for (const ctx of contexts) { try { await ctx.registry.delete(swarmPlugin) } catch { /* already down */ } }
for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

const failed = results.filter((r) => !r.ok)
console.log('='.repeat(74))
console.log(`summary: ${results.length - failed.length}/${results.length} checks passed against installed v${pluginVersion}`)
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.name}`)
process.exit(failed.length === 0 ? 0 : 1)
