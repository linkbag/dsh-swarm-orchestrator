# Changelog

Notable changes to `dsh-swarm-orchestrator`. Versions follow the npm package.

## 0.5.8

Reliability release. Every fix below came out of diagnosing 47 recorded swarm runs
and 184 task failures, and each one has a regression test.

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

### Packaging

- **`typescript` is now a declared devDependency.** The build previously resolved
  `tsc` from a parent workspace only, so `prepare` failed under `cmd.exe` and
  `npm publish` / a git install could not build on a clean checkout.

### Verification

- **73 tests pass** (was 58): new coverage for the orphan-recovery gate (positive and
  control), the spawn ceiling (positive and `0`-disables), the evidence shell, the
  missing-workspace guard, durable adoption (adopt and refuse-to-adopt cases), the
  `swarm_report` binding, write-scope nesting, and the role `toolFilter` pass-through.
- **End-to-end smoke on a real host.** The plugin was installed into an isolated DSH
  profile from source and driven by a live headless agent. Confirmed in that run: the
  resolved evidence interpreter is Windows PowerShell 5.1 and is invoked as
  `powershell.exe -NoProfile -NonInteractive -Command <cmd>`; and every task agent
  wrote its `.dsh-swarm/task-<id>.json` report, including a two-node run where the
  report was consumed by the downstream node. A separate probe against the packaged
  executor confirmed the quoted form `if (Test-Path "artifact.txt") { exit 0 } else { exit 1 }`
  exits 0 when the file exists and 1 when it does not.

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
