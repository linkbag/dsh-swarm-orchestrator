# Changelog

Notable changes to `dsh-swarm-orchestrator`. Versions follow the npm package.

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
