# Changelog

Notable changes to `dsh-swarm-orchestrator`. Versions follow the npm package.

## 0.6.16

**An evidence-only failure no longer re-does the work, and it finally says why.**

### Fixed

- **A failed evidence command no longer respawns the child.** The gate treated an
  evidence-contract failure like any other failure: `retry = attempts <= maxRetries`
  respawned the task agent to redo work that was already on disk and already
  reported done. Production evidence (`run-mudxdhwt-16yt`, seq 3998-4006): the
  integrator reported `done: c5-revalidate complete. F10 real daily-path parity
  (13/13 tests both repos) + 6 real integration defects found and fixed`, and the
  only failing check was one command's exit code - so the dispatcher respawned the
  integrator, and looped in `retrying` until a human forced the task closed.
  Now a failure whose only problem is the evidence runs **one command-only
  recheck** (no child), and if that also fails the task goes to a **human gate**:
  `blocked` with `humanReview`, resolved with `swarm_retry` or `swarm_complete`.
- **The failure now explains itself.** `runEvidenceCommand` kept only
  `err.message.slice(0, 300)`, so the exit code, the timeout state, stdout, stderr
  and the elapsed time were all discarded - a hung command and a failing command
  were literally indistinguishable in `events.jsonl`. It now returns a structured
  outcome (exit code, spawn error, `timedOut`, elapsed ms, bounded output tail)
  and the reason carries the verdict plus a tail. Verdicts are never truncated;
  only tails are.
- **Timeouts are distinct from non-zero exits**, in both the record and the reason.
- **A command that cannot even start is named.** `ENOENT` arrives as a string
  `code` with no exit status, which used to be recorded as the useless "exit code
  unknown"; it now reports `could not be started (ENOENT) - the run workspace or
  the interpreter is missing`.
- **`evidenceTimeoutMs`** (default `120000`, range 1 s-10 min) replaces the
  hard-coded 120 s ceiling, so a genuinely long suite can be accommodated instead
  of always failing the gate.

### Not changed

The contract itself is not weakened: file checks stay advisory, command failures
stay hard, `exit 0` is still required, and a task whose child did **not** report
done keeps the previous retry path exactly. The fix routes and records
intelligently rather than accepting a failing command as success.

Note for operators: a blocked task settles the *run* as `failed` - that is the
existing run-settlement semantics and it is deliberate, because the run now needs
a human decision instead of silently looping. `swarm_retry` revives it (appending
`run/resumed`); `swarm_complete` accepts the finished work despite the artefact.

### Tests

- 4 new A7 tests: exactly one command-only recheck with the child spawned exactly
  once (counted via a marker file the command appends to, not inferred), followed
  by `blocked` + `humanReview`; the record carrying the exit code and output tail;
  a hung command reported `TIMED OUT` with no exit code; a genuine child failure
  keeping the untouched retry path with the evidence command never run.
- `J3: a nonexistent run workspace is reported as such, not as a failed gate` -
  expectation updated: an evidence command that cannot start is an evidence-only
  failure of finished work, so it now blocks for a human instead of burning the
  retry budget on a respawn that cannot help. The test's intent (name the real
  cause) is preserved and strengthened.
- Suite: **159 tests, 159 pass, 15/15 files.**

## 0.6.15

**The effort pin is now validated against what the adapter will actually accept.**

### Fixed

- **A pin a pi-ai model cannot accept is stripped before spawning, not sent.**
  `dsh-llm-pi-ai` resolves a model's reasoning support from its declared
  `reasoningEfforts` map: a hand-declared model with no map is reported as
  supporting only `off`, and any explicit level then throws
  `LlmError(..., 'UNSUPPORTED_REASONING_EFFORT')` at request time. The J21
  preflight used to *decline to judge* exactly that shape —
  `if (!sawAnyEffortsMap) declaredWithoutMap.clear()` — so the impossible request
  went out anyway and the child died in tens of milliseconds.
- **The preflight no longer drops candidates.** It strips the pin for the attempt
  and keeps the whole model chain, because the pin is a preference: a value the
  model refuses is never useful, and spending model diversity to protect it was
  the wrong trade. The verdict is evaluated against the attempt's primary
  candidate, so a rotated chain can legitimately re-enable the pin on a model
  that declares support.
- **Declared levels are parsed and honored.** `reasoningEfforts` maps are read
  level by level, so a model that declares only `high` no longer accepts a `max`
  pin, while a declared level is pinned exactly as configured.

### Evidence

Live incident: `xiaomi/mimo-v2.6-pro` — hand-declared in `settings.yaml` with no
`reasoningEfforts` — died 41 ms after `task/agent-started` with `max` pinned, and
94 ms with `high`. The *presence* of the field was the rejection, not its value.
`deepseek-official/deepseek-flash` survived the same pin because it is the
`llm-deepseek` adapter, which does accept an effort. Against the real settings
file the corrected preflight now reports
`declaredWithoutMap: [..., 'mimo-v2.6-pro']` and judges an explicit level
incompatible for it, so no child is wasted on the impossible request.

The effort ladder (A1) and the 0.6.14 same-model fast-fail rung retry are
unchanged and remain the runtime safety net for a pin that is refused despite a
declaration.

### Repo hygiene

`src/config.ts` was omitted from the 0.6.14 commit, so that commit's
`PLUGIN_VERSION` stayed `0.6.13` while `package.json` said `0.6.14`. The built end
published artifact was correct (it came from the working tree); the commit is now
consistent at 0.6.15.

### Tests

- 5 new preflight tests: the parser records a map's declared levels and only
  those; an undeclared pi-ai model gets the pin stripped while keeping its place
  in the chain; a model declaring only `high` has a `max` pin stripped; a declared
  level is pinned exactly as configured; a model outside the validating roots
  (deepseek) keeps its pin.
- `tests/preflight-live.test.ts` — expectations corrected to the adapter's real
  rule, now asserting directly against the live `settings.yaml`.
- `tests/service.test.ts` — the harness boots against a fixture `settings.yaml`
  in a temp `DSH_HOME`, so the A1/J18 tests exercise a deployment where the pin is
  legal instead of silently depending on a file outside the repo.
- Suite: **155 tests, 155 pass, 15/15 files.**

## 0.6.14

**Effort varies faster than the model — and the effort ladder can no longer dead-end.**

### Fixed

- **The ladder can no longer collapse to a single clamped pin.** The chain was
  `[reasoningEffort, ...effortFallbacks]` filtered of empties, with the attempt
  index clamped to the LAST entry — so a role whose primary was unset and whose
  `effortFallbacks` was `['max']` pinned `max` on *every* attempt and *every*
  model, the opposite of a fallback. The ladder now starts at this attempt's rung,
  keeps every following rung, and **always ends at no pin**, so an exhausted ladder
  degrades to the provider default instead of re-pinning a value the model has
  already refused.
- **A refused pin no longer costs the whole attempt.** On a first-pass failure that
  is effort-suspect — the provider rejecting the effort explicitly, or a child that
  died fast having produced no output at all — the spawn layer retries the **same
  model** at the next rung (`max` → `high` → … → no pin) *before* the task rotates
  models. The retry is internal: it consumes no retry budget, does not change the
  task's attempt number, and does not advance the A6 model rotation. It is bounded
  by the rung count and stops at the first failure that is no longer effort-suspect.
- **The pinned effort is recorded.** `task/started` now carries `effort` and the
  board shows it, so this class of failure is diagnosable from the event log rather
  than inferred from a timing signature.

### Why

Production incident (2026-09-23, seq 3913-3915): attempt 1 pinned `max` on
`xiaomi/mimo-v2.6-pro` and the child died **42 ms** after `task/agent-started` with
stopReason `error` and no diagnostic. The generic reason `"child stopped: error"`
never matched the J18 unsupported-effort signature, so the dispatcher rotated to
`deepseek-official/deepseek-flash` (which accepted the same `max` five seconds
later) instead of varying the pin. The model itself runs unpinned as the
deployment default, so the pin was the suspect — not the model.

Note for operators: with the primary effort unset, `effortFallbacks: ['max']` still
means `max` is the *first* rung tried. List the conservative effort first, or leave
the ladder empty, if you want the unpinned request attempted first.

### Fast-failure heuristic

`FAST_FAILURE_MS = 10_000`: a failure that produced no output at all within 10 s of
the child starting is treated as a request-level rejection. An attempt that ran and
genuinely failed keeps the previous behaviour — the model chain remains the model
chain's business. The J18 full-chain degrade on an explicit unsupported-effort
error is unchanged.

### Tests

- `tests/service.test.ts` — 6 new A1 tests: ladder construction (`[]`, `['max']`,
  attempt-indexed `['max','high']`), the same-model rung retry after a fast
  output-less failure, no rung burned when the failure produced output or was slow,
  no retry-budget or rotation consumption, and the effort surviving projection.
- Suite: **150 tests, 150 pass, 15/15 files.**
- `tests/boot-audit-live.test.ts` — the all-terminal premise is now explicit: the
  production store has since gained an in-flight run whose recovery legitimately
  appends one `task/failed` event. The zero-append assertion still governs the
  terminal case it was written for.

## 0.6.13

**Scheduler correctness restored: everything from 0.6.9, on top of 0.6.11 and 0.6.12.**

0.6.9 and 0.6.10 were rolled back from `main` on 2026-09-23 while the "web UI
freezes" report was being chased. That rollback proved unnecessary — the freeze
was a client connection-budget bug, fixed in 0.6.12 — so this release returns the
0.6.9 scheduler work on top of every later fix. The 0.6.11 client hardening and
the 0.6.12 single-stream fix are unchanged; nothing was traded away.

### Reconciliation notes

- `src/service.ts` (the scheduler core), `src/dispatch/spawn.ts`,
  `src/domain/types.ts`, `src/domain/projection.ts`, `client/DutyTableEditor.tsx`,
  `client/locale.ts`, `tests/service.test.ts` and `tests/preflight-live.test.ts`
  took the 0.6.9 change verbatim — none of them had been touched since.
- `client/board-store.ts` carries both changes at once: 0.6.9's
  `BoardRole.spawnTimeoutSeconds` field and 0.6.12's reference-counted single
  stream.
- The progress-based spawn ceiling (item 7) lives in `src/service.ts`, where the
  sliding no-progress window is armed per attempt, cleared on progress, and
  honors the per-role `spawnTimeoutSeconds` override over the runtime default.
- `tests/preflight-live.test.ts` was adapted by 0.6.9 to the current deployment
  shape, which also clears the suite's one long-standing failure.

### Tests

- Suite: **144 tests, 144 pass, 15/15 files** — the first fully green run since
  the rollback. It carries the 0.6.9 regressions (a verdict beyond the 2000-char
  cap is approved, the re-ask is spawned once and recorded, the projection clears
  the previous attempt's note on `task/started`, watchdog escalation adopts a
  fresh on-disk report), the 0.6.11 hardening pins, the 0.6.12 connection budget,
  the 10-test fault matrix, and the live boot audit against the production store
  (3.86 MB / 3,885 events, zero appended events).

## 0.6.12

**Web-UI freeze fixed — one SSE connection for the whole plugin.**

### Fixed

- **The `swarm_dispatch` toolview no longer opens a stream per card.** That card
  renders once for every historical dispatch in a chat, and each instance opened
  its own persistent `EventSource('/swarm/events')` plus its own full-board
  fetch. A browser allows ~6 concurrent connections per origin and an SSE stream
  never ends, so a long history consumed the entire budget: every other request
  on the page — chat history, the plugin-market catalog, the swarm board itself
  — queued forever. The host stayed healthy throughout (a second client could
  still act), which is why it read as "the UI is stuck" rather than a crash.
  Cards now render their live dots from the shared board snapshot.
- **The 🐝 badge, the header popover and the settings section ride that same
  stream** instead of opening their own; the badge previously held a second SSE
  plus a 60s poll.
- **The shared store is reference-counted** (`retain()` / release). It is a
  module-level singleton, so the previous `start()`/`stop()` coupling meant one
  component unmounting killed the stream every other consumer was still riding.

Result: **exactly one** `/swarm/events` connection for the plugin, one debounced
refetch per event batch, and no per-card network traffic.

### Why this was misdiagnosed twice

The 2026-09-22 audit blamed the client's hard `inject` list; 0.6.11 removed it
and the freeze persisted, which exonerated the inject. The 0.6.9/0.6.10 commits
were never the cause either — the failure scales with *history length*, not with
the DSH version, so it surfaced only once enough runs had accumulated.

### Tests

- `tests/client-connection-budget.test.ts` (3) — pins exactly one `EventSource`
  in the client and only in `board-store.ts`, forbids per-widget board fetches,
  and requires every consumer to `retain()` the shared store rather than
  `stop()` it.
- Suite: **143 tests, 142 pass**; the pre-existing `preflight-live` assertion
  about the deployment default model still fails on this host, unchanged.

## 0.6.11

Client-plugin hardening: the freeze fix from the withdrawn 0.6.9/0.6.10 line,
applied on top of the 0.6.8 dispatcher. **No scheduler changes.**

### Fixed

- **The client plugin no longer hard-injects version-specific service faces.**
  `inject` is now `['slots']` only. A hard inject blocks plugin activation until
  every named service exists, so a host that renames or omits `connection`,
  `remote`, `remote.llm`, `remote.session` or `locale` left the module
  unactivated and stalled the whole client tree — observed as "web UI freezes,
  no chat history, no plugin-market catalog, no swarm host connection". Those
  faces are now wired through a dynamically scoped `ctx.inject([...], cb)` that
  fires only when the host provides all of them; when one is missing the plugin
  still activates and degrades (English labels, no live model catalog) instead
  of blocking activation.
- **Every raw service property read is guarded.** `ctx.remote` and `ctx.locale`
  are read inside `try` blocks — an undeclared service access throws on cordis,
  and an escaping throw from the catalog getter is how a degraded host becomes a
  broken UI.

### Reproduced on the failing host

DSH 0.1.7-alpha.2 with a mixed install (`@deepseek-ai/dsh` 0.1.7-alpha.2 beside
0.1.6-alpha.2 companion packages, plus a second, incomplete `npx`-installed DSH
in the user root serving the port). The live client service catalog on that host
exposes `layout, locale, sessions, slots, theme, timer, uiWorkspace, workspaces`
— **no** `remote`, `remote.llm`, `remote.session` or `connection` — so the 0.6.8
hard inject could never be satisfied, and enabling the plugin stalled the client
tree while the host process stayed healthy (a second client could still reach it
and disable the plugin).

### Tests

- `tests/client-hardening.test.ts` (4) — pins the soft `inject`, forbids
  re-hardening any optional face, asserts the scoped wiring exists, and requires
  every `ctx.<service>` property read to sit inside a `try` block.
- `tests/boot-audit-live.test.ts` (1) — boots the host half against the real
  production store (3.86 MB / 3,885 events) and asserts zero appended events, no
  storm, no hang.
- Suite: **140 tests, 139 pass**. The one failure is the pre-existing
  `tests/preflight-live.test.ts` assertion that the deployment default is
  `glm-5.3-flash`; it fails identically on the pristine 0.6.8 tree and is
  unrelated to this patch.

## 0.6.9

Scheduler correctness release — diagnosed from the overnight StockSelector run
(W00–W15): a review that failed open, a healthy retry killed after 7 minutes, and a
run stranded in `retrying` for 7+ hours until a human resumed it.

### Fixed

- **The review verdict is parsed from the complete final message.** The review prompt
  places `VERDICT: …` at the end of the reply, but the parser read `outcome.summary` —
  truncated at 2000 chars — so every review thorough enough to exceed the cap failed
  open. (Item 1.)
- **One explicit re-ask before failing open.** A reviewer that omits the verdict line
  gets its own assessment back with the demand for the exact line; only a second
  refusal fails open. (Item 8.)
- **The watchdog reclaim honors finished work.** The stale, escalation, and
  spawn-ceiling paths now run the J10 report adoption before charging a failure —
  W01's attempt 2 had written a completed report moments before the watchdog killed
  it, and the old path discarded it. (Item 4.)
- **A reclaim arms the H-1 retry-backoff timer.** The watchdog paths had no settle
  handler to arm it, and dispatcher ticks are event-driven — so the tick's
  "too soon" skip never got its follow-up tick. This is what stranded the run for
  seven hours. (Item 3.)
- **`recoverOrphans` re-arms stranded `retrying` tasks and schedules a boot tick per
  running run.** A restart kills the in-memory retry timer; recovery used to skip
  `retrying` entirely. (Item 3.)
- **A fresh attempt starts with a clean silence clock.** `task/started` clears the
  previous attempt's note/timestamp and a relaunch resets the nudge counters — a
  healthy 7-minute-old retry is no longer reclaimed as "61 min silent". (Item 2.)

### Added

- **Progress-based liveness replaces the fixed spawn kill (item 7).** The spawn
  ceiling is now a *sliding no-progress window* — re-armed by every heartbeat
  (default `spawnTimeoutSeconds`): a working child is never killed for elapsed
  time; a silent one is reclaimed after the window, with report adoption. The
  pre-start blind spot the ceiling was built for is unchanged.
- **Per-role `spawnTimeoutSeconds`** in the duty table (Roster field included),
  overriding the runtime default for the spawn phase.
- **Reviewers start from the task's own report** (`.dsh-swarm/task-<id>.json`) and
  are asked to re-run evidence commands rather than trust the builder's claims.
  (Item 5.)

### Verification

- New tests: a verdict beyond the 2000-char cap is approved (item 1); the re-ask is
  spawned once and its verdict recorded (item 8); the projection clears the previous
  attempt's note on `task/started` (item 2); watchdog escalation adopts a fresh
  on-disk report instead of failing (item 4).
- 136 tests pass.

## 0.6.8

The Swarm interface now speaks your language.

### Added

- **简体中文 interface, following the DSH language preference automatically.**
  Every Swarm surface — board columns, flow chart, roster editor, runtime tuning,
  the header popover, the dispatch card and the global 🐝 badge — translates through
  the client locale service: a `swarm` namespace registered in English and 简体中文,
  bound once, read at render time. Switching Settings → General → Language re-renders
  the Swarm UI in place; no reload. Statuses (planning / 运行中 / 评审中 / …), column
  names, field labels, placeholders, tooltips and time-ago strings are all covered.
  Unknown statuses and host-originated content (task summaries, error bodies) pass
  through untranslated, by design.
- **🐝 badge labels are injectable templates** translated through the same service,
  re-rendered on locale changes.

### Verification

- `tests/locale.test.ts` — 7 tests: en/zh key parity (a missing key renders as a raw
  `tab.board`-style key in one language only — the ugliest failure mode), non-empty +
  CJK spot checks, `{var}` interpolation, status passthrough, English fallback without
  a locale service, and active-locale switching through a bound service.
- 135 tests pass.

## 0.6.7

Client fix for DSH 0.1.6. No scheduler behaviour changed.

### Fixed

- **The Roster's model pickers went blank ("host connection unavailable") on
  DSH 0.1.6.** 0.1.6 moved client RPCs from the `connection.api` wire face to the
  typert Remote face (`ctx.remote.llm.*`); the `connection` service still exists but
  carries connection *state* only, so the catalog's api handle resolved to
  `undefined` and every dropdown degraded to a single "inherit deployment default"
  entry. The catalog now speaks the remote face — `listProviders`,
  `listConfigurableProviders`, then per-provider `discoverModels`, which for routes
  the adapters already know answers from the adapter's own registry without a network
  call — and keeps the legacy face as a fallback, so one published bundle serves old
  and new hosts alike. A provider that refuses discovery is skipped instead of
  blanking the picker, and the failure message now names the face that is missing.
  The Remote face is inject-guarded: the client plugin now declares `remote` +
  `remote.llm` in its cordis inject — the same keys the shipped Models settings page
  declares — otherwise access fails with `cannot get property "remote" without
  inject`. (Model pickers therefore need DSH 0.1.6+; board, flow and roster editing
  work without it.)
- **The pickers list configured providers only, from the Host's own catalog, and
  stay current.** The primary source is now `remote.session.modelCatalog()` — the
  same Host-generation catalog the composer's model picker renders, so every
  configured provider's models appear uniformly. (The per-provider discovery
  fallback could only answer for adapters that register model discovery, which is
  why DeepSeek models were missing while zai showed.) Updates arrive as Host events
  (`llm/adapters-updated`, `settings/document-updated`,
  `credentials/reference-updated`) instead of waiting on the 30s poll, which remains
  as a fallback for hosts without the event face.

### Verification

- `tests/catalog.test.ts` — 12 tests over all faces: the Host session catalog
  (DeepSeek models included; refusal falls back), the llm face (configured-only
  filtering with a dormant route excluded; per-provider discovery; a refusing
  provider skipped, not fatal), the legacy fallback, remote-wins-when-both exist,
  catalog-event subscriptions with dispose, and a diagnostic that names both missing
  faces.
- **J21 preflight learned the 0.1.6 settings shape.** The 0.1.6 rewrite of
  `settings.yaml` dropped every per-model `reasoningEfforts:` map, which made the
  preflight flag *every* pi-ai model as effort-unknown and drop all effort pins. The
  parser now recognises the new shape: a file that declares no maps judges no model,
  and `agent-default-model` (`provider`/`model` + `reasoningEffort`) counts as
  first-hand evidence that this exact model/effort pair runs. The old map format is
  still parsed for older hosts. `tests/preflight-live.test.ts` now pins the real
  0.1.6 file.
- 128 tests pass.

## 0.6.6

Reliability fix. Dispatch behaviour is unchanged except in one failure path.

### Fixed

- **An adopted task report must belong to the attempt that is settling.** The handoff
  file `.dsh-swarm/task-<id>.json` is keyed by task id, not by run, so every run that
  reuses an id shares it. Adoption checked only that the file was well-formed, claimed
  `status: "completed"`, and named the right task — so a child that died before writing
  its own report could be credited with an **earlier run's** work, and a task whose
  evidence gate had already failed in an earlier attempt could be marked complete by
  the very report that attempt wrote. Adoption now also requires the file to have been
  written during the live attempt (`mtime >= task/started`). An older report is logged
  and ignored, and the task is charged as failed instead of completed.

  The live trigger: the post-upgrade compatibility run reused the task ids `alpha` and
  `beta` from an earlier run in the same workspace. Both agents independently found the
  previous run's reports still on disk and rewrote them — which is what kept that run
  honest, not the dispatcher.

### Verification

- `J22` (`tests/service.test.ts`): a well-formed, aged `completed` report for the same
  task id is not adopted, and the task is charged as failed. Confirmed to fail with the
  guard removed — the task completed on the stale file.
- The two `J10` cases now write their reports from a spawn-time hook, so each isolates
  one reason to refuse adoption: a fresh report with the wrong status, and a stale
  report with the right one.
- 116 tests pass.

## 0.6.5

Client-only correction. No scheduler behaviour changed.

### Fixed

- **The global 🐝 status pill could report a false failure.** The badge announced the
  newest run whose status was `failed` or `paused`, not the newest run — and because
  `/swarm/board` is sorted newest-first, that `find` returned the newest *bad* run. A
  single failure anywhere in the last 50 runs therefore pinned the pill to
  "last swarm run: failed" indefinitely, even while the newest run had completed. The
  report that prompted this ("it says failed but the run actually succeeded") named a
  failure two runs old while the board's newest run was `completed`.
- **The label now describes live state, never accumulated history.** In-flight runs
  (`planning` / `running`) are counted as active; otherwise a `paused` run is reported as
  paused rather than active; a run waiting on a human reads "awaiting endorsement"
  instead of the swarm reading as idle; and only then does the pill report the newest
  run's real status, chosen by `createdAt` rather than array position. Alert styling now
  means the reported run is `failed` or `aborted` — it is no longer a latch that any past
  failure can set.
- **A malformed board payload no longer freezes stale text.** `board.runs` is read
  defensively; an error body previously threw inside the promise chain, and the resulting
  rejection left the previous label on screen.

### Verification

- `tests/badge.test.ts` — 11 unit tests over the extracted label function, starting from
  the exact board that produced the report (newest `completed`, two older `failed`), plus
  order-independence, paused, awaiting-endorsement and malformed-payload cases.

## 0.6.4

Verification and candour release. No scheduler behaviour changed.

### Added

- **A fault matrix (`J20`)** — `tests/fault-matrix.test.ts`, 10 adversarial tests over
  the dispatcher's invariants. Every defect found in this project (J16, J17, J18) was
  discovered in a **live** run rather than by the scenario-based tests; this moves that
  discovery into CI. Scenarios, and the reference scenario each translates: late writes
  and a 20-return late burst ("50 late writes"); terminal overruns ("40 terminal
  overruns"); a 12-way tick storm proving in-flight tasks are not double-launched
  ("7-way claim race"); abort during in-flight work ("concurrent takeover");
  cold-restart recovery including 13 repeated recoveries against a terminal run (the
  shape of the real zombie incident); a 40-heartbeat burst ("42-message burst"); a
  12-task / 3-level DAG; and a bounded-retry check.

  Invariants asserted: terminal tasks never move again; a superseded attempt's result
  never overwrites newer work; one live attempt per task with monotonic attempts;
  `attempts` equals the `task/started` count; a run always reaches a terminal state;
  retries stay within `maxRetries`.

  The matrix immediately earned its keep: three of its tests fail on the
  attempt-**identity** assertions, because the dispatcher has no attempt identity at
  all — the exact gap the parked `wip/attempt-fencing` branch addresses. Those
  assertions tighten **automatically** once fencing lands, so the same file verifies
  the fence without a test edit.

- **A "Known limits" section in the README (EN + ZH).** Stated plainly, because a limit
  discovered in production costs far more than one read up front. It records, among
  others: the board reports disk truth and the disk can lag the model; evidence
  contracts are advisory for files and hard only for commands, so scope control is a
  completion-time audit and not write interception; state is serialised within one DSH
  process only; **attempt identity is not yet enforced, so a retry launched while the
  previous child is still running can still have the older child's result recorded**;
  member messaging is one-directional; one role may hold several concurrent tasks;
  recovery is bounded per boot rather than globally; the board's version string is the
  version loaded at boot; and `lib/` is built, not committed.

## 0.6.3

Flow-chart and surface legibility.

### Fixed

- **Arrows no longer show through the flow-chart boxes.** Two causes, both fixed:
  `.dsh-swarm-flow-node` is absolutely positioned with no `z-index`, while the edge
  layer is at `z-index: 0` — so the SVG arrows painted *over* the boxes — and the node
  fill was only 6–8% opaque, so anything behind it was visible regardless of stacking.
  Nodes now sit at `z-index: 1` and their fill is genuinely **opaque**.
- **Opaque without losing theme adaptation.** A translucent tint cannot hide what is
  behind it, so the fills are now
  `color-mix(in srgb, canvas 94%, rgb(128 128 128))` — a neutral 6% grey blended into
  the page background. The result is fully opaque *and* still derived from the
  background, so light / dark / system all work with no per-theme rules. Cards, flow
  nodes, wave pills, the header popover and the floating badge all use it; a plain
  `rgba(...)` declaration precedes each `color-mix` as a fallback for engines without
  `color-mix` (those degrade to translucent, as before).
- **Near-white text that vanished on light themes.** The floating badge pinned
  `color: #e8e8e8`, so on a light background it was close to invisible. It now inherits
  the page colour.
- **The model-picker dropdown no longer forces a dark popup.** It had a hardcoded
  `background: #14161a; color: #e8e8e8` to avoid white-on-white native popups — which
  is why the roster's dropdown looked wrong in light mode. The list now derives both
  its background and its text colour from the page theme
  (`color-mix(…canvas…)` + `canvastext`).

## 0.6.2

Packaging and theme release.

### Fixed

- **The client bundle is now rebuilt with the theme change.** `client/swarm.css` was
  updated in `24e4320`, but `lib/client.js` was still the previous evening's build, so
  the browser kept loading the **old hardcoded dark fills**
  (`rgba(20, 22, 26, 0.82–0.97)`) and the theme fix was invisible however often the page
  was refreshed. Every claim around it was individually true — committed, pushed,
  served — and the UI was still wrong, because the served artifact was stale. `lib/` is
  gitignored and built on demand, so "pushed" does not imply "rebuilt".
  `tests/bundle-freshness.test.ts` now fails when any file under `client/` is newer than
  `lib/client.js`, and when a hardcoded dark fill reappears in the built bundle.

### Added

- **Card and flow-node fills are neutral semi-transparent tints** that adapt to the DSH
  light/dark/system theme (`var(--dsh-swarm-card, rgba(128,128,128,0.07))` with
  `color: inherit`), replacing the opaque dark boxes that were unreadable on a light
  theme.

## 0.6.1

- Version bump only (no behaviour change).

## 0.6.0

- **Higher concurrency defaults**: `maxConcurrent` 5 → 10, `maxTotalConcurrentAgents`
  5 → 20. Both remain runtime-tunable from the dashboard.
- **Schema fix**: `maxTotalConcurrentAgents`'s own maximum was 16 while the new default
  was 20, so the config schema rejected its own default. The bound is now 64.
- Evidence `files` entries became **advisory warnings** rather than hard gate failures,
  and the board carries success-rate telemetry.

## 0.5.9

- Documented the Runtime tuning section (EN + ZH) — concurrency and hardening
  parameters are editable from the dashboard and applied live.

## 0.5.8

Reliability release. Every fix below came out of diagnosing 47 recorded swarm runs
and 184 task failures, and each one has a regression test.

### Added

- **`maxSubagentDepth` (default 1) — task agents can no longer spawn invisible
  descendants.** The swarm never passed `maxDepth` to the subagent provider, and the
  provider's recursion cap is opt-in, so a task agent could delegate freely. Those
  descendants were invisible to the dispatcher: not counted by the global agent cap,
  not tracked by the watchdog, not shown on the board, and each one resident on the
  same Node heap. This was not hypothetical — auditing 512 session transcripts found
  **16 sessions spawned by swarm task agents**, including one task
  (`vhp-cryo-embed`) that spawned **12 distinct subagents in 42 minutes** while the
  orchestrator saw exactly one task, and a chain that reached delegation depth 3
  (`swarm:v6b-integration → Verify 8 landed task claims → Verify content+identity+photofit data`).
  A task agent runs at depth 1, so `maxDepth: 1` permits the agent itself and rejects
  any further delegation with `SubagentDepthError`. Set `0` to disable the bound.

  Note on blast radius: growth is multiplicative, not runaway — 93 top-level chats →
  394 first-level children → 23 grandchildren → 2 great-grandchildren. Reaching those
  deeper levels needs an agent that explicitly delegates. The bound removes the
  possibility rather than relying on model restraint.

### Fixed

- **Evidence commands ran under `cmd.exe`, not a POSIX shell.** `checkEvidence`
  called `exec` with no `shell`, so a normal PowerShell gate such as
  `if (Test-Path app/build.gradle.kts) { exit 0 } else { exit 1 }` was rejected with
  `'…') was unexpected at this time.` and the task failed for a reason unrelated to
  its work. Evidence now runs through PowerShell on Windows (`pwsh`/`powershell` are
  probed by absolute path, then by name) and bash elsewhere, from the run workspace.
  This accounted for **59 of the 184 recorded failures (32%)**. The
  `evidence.commands` schema now states the shell, and points at `evidence.files` as
  the shell-free alternative.
- **A nonexistent run workspace is now reported as such** instead of surfacing the
  interpreter's `ENOENT` as a failed gate — a missing directory and a red test look
  nothing alike to the agent reading the failure.
- **Orphan recovery could re-fail the same task forever.** `recoverOrphans` did not
  check whether the *owning run* was still running, while `fold` refuses task
  transitions on terminal runs (J5). So each host restart appended a `task/failed`
  event that the projection ignored: the task stayed `running`, `attempts` never
  advanced, and the retry cap could never engage. One aborted run's task collected
  **13 "host restarted mid-flight" failures over 21.5 hours**. Recovery is now
  scoped to running runs, and the skip is logged.
- **`swarm_report` required the model to pass `taskId`.** The service already
  authenticates the caller by child session id and knows which task it owns, so the
  requirement produced 33 `missing required property "taskId"` tool errors for no
  benefit. `taskId` is now optional and resolved from the authenticated session; an
  explicit id is still validated, so an agent cannot report against another's task.
- **A brief `maxTotalConcurrentAgents` misread.** The runtime value from
  `runtime.json` was ignored in favour of the profile config, so the dashboard showed
  one effective cap while the scheduler enforced another. Both the scheduler and the
  board snapshot now read the runtime override.
- **A runtime settings draft was clobbered on every board update** (SSE refresh), and
  the file did not compile (`useRef` used but never imported). The draft now
  initialises once and re-syncs from the saved result.

### Added

- **A model that rejects the role's reasoning-effort pin no longer fails the run
  (`J18`).** The per-role effort is pinned through the host's `agent/request`
  waterfall, so it is applied to whichever model actually serves the request —
  including a FALLBACK whose model does not support that level. Observed live on the
  "Stock Selector Audit and Update" chat: a role pinned `reasoningEffort: "max"` with a
  `zai/glm-5.3` fallback (the deployment declares effort mappings only for
  `glm-5.3-flash`), so every task died about a second in with
  `UNSUPPORTED_REASONING_EFFORT` — **all 6 tasks failed within one second**, twice.

  Two things made this fatal rather than a hiccup: the error arrives as the child's
  *stopReason*, not as a `start()` throw, so the candidate fallback chain was never
  consulted; and the effort was re-pinned on every retry, so retrying could not help.

  The dispatcher now detects that specific error and retries the same candidate chain
  once with the effort pin removed — degrading beats failing, and preserving the chain
  means a real outage is still reported as one.
- **The task prompt now states the workspace root explicitly (`J16`).** The prompt
  referred to "the workspace" eight times without ever saying where it was, so each
  agent guessed. Caught by a live 4-task audit: one task wrote to the run root while
  its siblings wrote into a subdirectory named in the spec, their evidence contracts
  failed against the dispatcher's own resolution, and the integrator then refused to
  certify the result because the artifacts were split across two directories. Agents
  now receive the absolute workspace root, plus the rule that every relative path in
  the brief — evidence, write scope, task report — resolves against it.
- **Skipped reviews are now visible (`J17`).** When a reviewer produced no usable
  `VERDICT:` line the task completed fail-open (deliberate), but `reviewed` stayed
  unset and `reviewsPassed` was never incremented — so a run report could not
  distinguish a silently skipped review from a clean pass. The audit run reported
  `reviewsPassed: 0` for a task that had "passed review". Runs now carry
  `reviewsUnavailable` and the task is marked `reviewUnavailable`.

- **`spawnTimeoutSeconds` (default 3600).** A hard ceiling on one task-agent run. The
  heartbeat watchdog only reclaims tasks in `running`; a task whose child never
  publishes `agent-started` sits in `dispatching` holding its concurrency slot
  indefinitely (14 tasks across 9 runs). On expiry the child is aborted and the task
  is retried like any other failure. `0` disables.
- **`bootGraceSeconds` (default 3).** How long after plugin load to wait before
  running orphan recovery, using the wait to poll for the `subagents` spawn provider.
  A requeue that fires before the provider mounts fails with
  `subagents service unavailable`, burning a retry for a reason that was never the
  task's fault (18 recorded failures).
- **Durable task handoff.** Each task agent now writes
  `.dsh-swarm/task-<id>.json` (`{"taskId","status":"completed","summary"}`) as its
  final action. If the host restarts and kills the agent between finishing the work
  and being recorded, the dispatcher adopts that report and records the task as
  completed instead of discarding the finished work and re-running it. Production hit
  exactly this: four tasks reported "code landed on disk before the host restart", a
  reviewer report was "written before the crash", and all five were thrown away.
  Only an explicit `"status": "completed"` is ever adopted.
- **Nested write-scope detection.** Dispatch warnings previously required an *exact*
  shared path. A review or integration task declaring a whole directory (`src`,
  `scripts`, `docs`) nests every builder's files, and that was the production pattern:
  13 of 23 runs declaring scopes had unserialised overlap and produced 20
  "file changed since it was read" failures, while the 24 runs without overlap
  produced none. Broad directory scopes that contain a concurrent sibling's files are
  now named in the dispatch warnings.
- **`spawnTimeoutSeconds` is editable in the Runtime settings** section of the swarm
  settings, alongside the other hardening knobs.
- **A single bad tool name in a role's `toolFilter` failed the entire run.** The host's
  `tools.restrict()` **throws** on a name it does not expose, and that throw happens
  during child creation — so an unknown name is not a per-task failure, it is a
  run-wide outage. Observed in production: a filter naming `modlens` (the real tool is
  `modlens_read_image`) failed **all 10 tasks across 3 waves** in 2 minutes and killed
  the run. Unknown names are now dropped with a per-role warning, validated before the
  child is created. An `allow` list that loses every entry is refused outright rather
  than applied empty — an empty allow-list would permit everything, the opposite of the
  operator's intent.
- **Orphan recovery no longer kills a task this process is actively running.** This
  one was caught by the end-to-end smoke below, not by unit tests: recovery runs on a
  timer after boot, and in a one-shot/headless host the dispatching agent can have
  already launched a task by then. The live run showed
  `task/started → task/agent-started → task/failed "host restarted mid-flight" →
  task/heartbeat`, i.e. recovery failing a task it did not own. An in-memory flight is
  now treated as the authoritative ownership signal. The old fixed 3000 ms grace had
  the same race window for anyone who dispatched within it.

### Packaging

- **`typescript` is now a declared devDependency.** The build previously resolved
  `tsc` from a parent workspace only, so `prepare` failed under `cmd.exe` and
  `npm publish` / a git install could not build on a clean checkout.

### Verification

- **88 tests pass** (was 58): new coverage for the orphan-recovery gate (terminal-run,
  live-task, and genuine-restart-orphan cases), the spawn ceiling (positive and
  `0`-disables), the evidence shell, the missing-workspace guard, durable adoption
  (adopt and refuse-to-adopt cases), the `swarm_report` binding, write-scope nesting,
  the role `toolFilter` pass-through and its name sanitisation, and the
  delegation-depth bound (default, opt-out, and rejection-surfaces-as-failure).
- **End-to-end smoke on a real host, twice.** The plugin was installed from source
  into an isolated DSH profile and driven by a live headless agent. The final run is
  fully green:

  ```
  run/created → run/endorsed → task/started → task/agent-started
  → task/heartbeat → task/heartbeat → task/completed → run/completed
  artifact.txt = "OK"     .dsh-swarm/task-t1.json written
  ```

  Also confirmed in those runs: the evidence interpreter resolves to Windows
  PowerShell 5.1 and is invoked as
  `powershell.exe -NoProfile -NonInteractive -Command <cmd>` (an agent independently
  reported "`pwsh` is not installed on this host"), task agents write their
  `.dsh-swarm/task-<id>.json` report including in multi-node runs, and a probe against
  the packaged executor confirmed the quoted form
  `if (Test-Path "artifact.txt") { exit 0 } else { exit 1 }` exits 0 when the file
  exists and 1 when it does not.

### Known limitation

- If an evidence command is **syntactically broken** (for example a quoting mistake
  in the dispatching agent's tool arguments), the reported failure is the shell's
  parse error. It is distinguishable from a genuine gate failure by reading the
  message — a parse error names the interpreter and quotes the offender — but the
  task reason line does not yet label the two cases differently, so an agent may
  retry a malformed command rather than fixing it. Prefer `evidence.files` where a
  file check can express the gate.

## 0.5.7

- **Global agent cap (`maxTotalConcurrentAgents`, default 5).** Swarm agents run
  in-process on the DSH host and share its Node.js heap; concurrent runs now split one
  budget (3+2, not 5+5).

## 0.5.6

- Removed the endorsement gate from the workflow documentation (EN + ZH).
- Added the `runtime` field to the board action body type.

## 0.5.5

- Boot grace before orphan recovery, runtime settings UI.
- Hardening: retry backoff (base × 2^n, capped at 60s) and a circuit breaker
  (≥3 failures in 30s pauses retries for the cooldown) to stop synchronized retry
  cascades after a provider outage.

## 0.5.4

- `swarm_interrupt` to abort and requeue a stalled task in the same run.
- Escalating watchdog: three nudges then automatic reclaim.
- Fixed a memory leak in the nudge tracking maps.

## 0.5.3

- Deterministic Flow-chart layout and per-run `PLAN-<runId>.md` files so parallel runs
  in one workspace stop overwriting each other's plan.

## 0.5.0 – 0.5.2

- Orchestrator discipline: one run per goal, mandatory architect review producing
  `PLAN.md` before any builder starts, and a workspace run policy (`warn`/`block`/`off`).
- Fixed `dispatch.sessionId` and `task.writes` never being folded.
