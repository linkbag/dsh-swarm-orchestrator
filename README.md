# dsh-swarm-orchestrator

[English](README.md) · [简体中文](https://github.com/linkbag/dsh-swarm-orchestrator/blob/main/docs/zh-CN.md)

Role-based AI swarms for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Give it a goal, get a team: an architect breaks the work into a task graph, parallel builders execute it, reviewers hold the line, and an integrator ships the result — while you watch the whole thing move on a live kanban board.

It runs **inside** your `dsh web` host. No daemon, no second process, no glue scripts. Task agents are ordinary DSH subagents with your tool access and your models; the orchestrator is just a well-behaved Cordis plugin.

It has already shipped real work: the first production run reverse-engineered a biotech research dashboard and rebuilt it as a **six-indication suite** (680 curated clinical trials across six cancers) in a single afternoon — five data-curation agents working in parallel, every deliverable machine-verified.

---

## At a glance

**dsh-swarm-orchestrator** turns one goal into a supervised agent team inside DeepSeek Harness: an architect reviews your plan into `PLAN.md`, parallel builders execute it as a task DAG, reviewers gate quality, an integrator ships. Every role runs a model you pin from your live catalog, every deliverable can be machine-verified, and the whole pipeline is visible on a live kanban + flow chart.

```text
        you ── "spawn a swarm: ⟨goal⟩"
         │
         ▼
   your chat agent            (free to plan/research on its own —
         │  swarm_dispatch     its plan becomes the proposal)
         ▼
  ┌─────────────────┐
  │ architect-review │  deep-reviews the proposal against the repo,
  │  → PLAN.md       │  consolidates parallel workstreams (evidence-checked)
  └────────┬────────┘
    ┌──────┼──────┐
    ▼      ▼      ▼
 builder builder builder    ▸ parallel wave — one model per role,
    │      │      │           fallback chains, exclusive write scopes
    ▼      ▼      ▼
 reviewer reviewer (human)   ▸ rejections loop back with feedback;
    └──────┼──────┘            `reviewGate: "human"` parks it on you
           ▼
       integrator             ▸ merges, verifies, ships
           ▼
       📄 run report          ▸ per-task summaries · models used · stats
```

## Example Kanban View (real-time workflow)

<img width="1045" height="507" alt="image" src="https://github.com/user-attachments/assets/ab727b4a-c75a-41fe-be3c-3f68e9499c88" />

## Why not just ask one agent?

Because one agent serializes. Long research tasks queue behind quick edits, context fills up, quality drifts, and nothing checks the output but the same model that wrote it.

This plugin takes the coordination seriously so you don't have to:

- **Parallel by construction.** Tasks declare dependencies (`blockedBy`); everything independent runs at once, bounded by a concurrency cap that adapts when the provider struggles.
- **Every role gets its own model.** Pin DeepSeek, GLM, Kimi, Claude — any model configured in DSH — to any role, with an ordered fallback chain and a per-role reasoning-effort ladder. The picker reads your live model catalog, so new providers show up automatically.
- **Review before "done" means done.** Tasks tagged `reviewBy` are judged by a reviewer agent against the task brief; a rejection loops back to the builder with the feedback attached. Want the last word yourself? Set `reviewGate: "human"` and approve from the dashboard.
- **Failure is a state, not a mystery.** Provider timeouts, quota exhaustion, bad evidence — each is detected, reported plainly, and handled: retries with resume hints, run pause/resume instead of burn-down, automatic model rotation after repeated failures.
- **Scoped to where you are.** Each chat's Swarm tab shows the runs for that chat's workspace; a persisted switch reveals everything on the machine when you want the full picture.
- **One run per goal, reviewed before built.** Dispatching into a workspace with an active run raises a warning (or a block, your choice); and unless you opt out, an architect agent reviews the dispatcher's plan into PLAN.md before any builder starts.
- **Memory-safe concurrency.** Swarm agents run in-process on the DSH host, sharing its Node.js heap. A global cap (`maxTotalConcurrentAgents`, default 5) ensures concurrent runs from different workspaces share the agent budget (3+2, not 5+5) — preventing the heap exhaustion that can crash the host when too many agents run simultaneously.
- **Work outlives its agent.** Every task agent writes a small completion report as its final action. If the host restarts and kills an agent between finishing the work and being recorded, the dispatcher adopts the on-disk report instead of throwing the finished work away and re-running the task. A task can also never sit `dispatching` forever: `spawnTimeoutSeconds` is a hard ceiling the heartbeat watchdog cannot provide.
- **Every agent stays on the board.** A task agent cannot spawn subagents of its own (`maxSubagentDepth`, default 1). Without that bound an agent could delegate to helpers the dispatcher cannot see or account for — not counted by the global cap, not tracked by the watchdog, not shown on the board, yet all sharing the host heap. Measured on a real machine: one task spawned 12 such hidden helpers while the board showed a single task.

> ⚠️ **Running multiple swarms from different workspaces in parallel**: this is supported and safe with the global cap. However, be mindful that each swarm agent is an in-process session on the host. We recommend **max 2 concurrent runs** with the default cap of 5 total agents. If you experience `ERR_CONNECTION_REFUSED` (host crash), lower `maxTotalConcurrentAgents` to 3 in the Runtime settings.

### Reliability notes (v0.5.8)

Diagnosed from 47 recorded runs / 184 task failures, then fixed and regression-tested:

- **Evidence commands run under PowerShell** (bash elsewhere) from the workspace root, and the `evidence.commands` schema says so. Previously they were handed to `cmd.exe`, so a perfectly normal PowerShell gate (`if (Test-Path …) { exit 0 }`) failed the task — 32% of all recorded task failures. Prefer `evidence.files` where a file check can express the gate: it involves no shell at all.
- **`modlens` is denied to swarm roles** by default in the shipped roster guidance: it is an interactive tool that asks the user a question, and swarm children run non-interactively. Add it back per-role from the Roster if your deployment has a headless vision provider.
- **A task report that does not claim `"status": "completed"` is never adopted** — adoption cannot mask unfinished work.
- **Recovery is scoped to running runs.** Orphan recovery only requeues tasks whose run is still running, so a terminal run's tasks stay frozen instead of being re-failed on every host restart.

## The dashboard

A **Swarm** tab lives next to Chat in the web GUI, in three views:

- **Board** — runs on the left, task columns (Queued / Running / Done / Failed) front and center. Click a task for its full brief, model, attempt count, interim agent notes, reviewer feedback, and retry. Completed runs fold into a report with per-task summaries and fallback/retry/review stats.
- **Flow** — the task DAG as a living flow chart: the scheduler at the top, tasks fanned out into parallel waves (same wave = runs concurrently), dependency arrows turning green as blockers complete, reviewer and write-scope hints on each node, all converging into the run report. You can see at a glance what ran in parallel, what ran in sequence, and exactly how far the run has gotten.
- **Roster** — the duty-table editor: per-role model pickers fed by your live catalog, fallback-chain ordering, effort ladder, concurrency caps, tool filters, personas, custom roles, and an override lock for "hands off my table".
- **Everywhere else** — a 🐝 status button in every session header, a small badge for active runs, and a live progress card right in chat where the run was dispatched.
- **Workspace-aware** — each chat's Swarm tab shows the runs for that chat's workspace; an **All** switch reveals every run on the machine. The roster stays global (one table, all workspaces).

## How a run works

1. **Dispatch** — tell your agent what you want; it calls `swarm_dispatch` with a task graph. Runs start gated: *planning*, zero agents spawned.
2. **Execute** — the architect reviews the proposal and produces `PLAN.md`; then parallel builders start.
3. **Watch** — **Board** shows the kanban; **Flow** shows the workflow chart; click any task for its drawer.

## Getting started (~5 minutes)

### 1 · Install

From this GitHub repo (pnpm will run the package's `prepare` script to build from source):

```sh
dsh plugin --profile web add github:linkbag/dsh-swarm-orchestrator
```

pnpm ≥ 10 asks you to allow that build first — add the exact key it prints to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-swarm-orchestrator: true
```

and re-run the `add`. (That allowance executes this package's code on your machine at install time — the usual trust rule applies; pin a commit if you prefer: `github:linkbag/dsh-swarm-orchestrator#<sha>`.)

Or install prebuilt from npm — no build allowance needed:

```sh
dsh plugin --profile web add dsh-swarm-orchestrator
```

Then restart `dsh web` (or reload the profile). You should see the **Swarm** tab next to Chat, a 🐝 button in every session header, and **Settings → AI Swarm** (the title shows the running version — a quick way to confirm the install).

### 2 · Assign models to roles

Open the **Swarm** tab in any chat and switch to **Roster** — or open **Settings → AI Swarm**, the same editor reachable from anywhere. The four built-in roles:

| Role | What it does |
| --- | --- |
| **architect** | Reviews the proposal, refines it into `PLAN.md` |
| **builder** | Implements one task to completion, with verification |
| **reviewer** | Judges completed work against the task brief |
| **integrator** | Merges parallel work and ships the result |

For each role, pick a model from the dropdown. It lists **every provider configured in DSH** (DeepSeek, GLM, Kimi, Claude, …), grouped by provider — the same live catalog as the Models settings page. Leave a role on **inherit deployment default** to use whatever model the dispatching chat runs on.

Optional, per role (all have sane defaults):

- **Fallback chain** — models tried in order if the primary is unavailable.
- **Effort + effort ladder** — reasoning effort for the role, downgrading per retry.
- **Concurrency cap** — limit simultaneous agents of this role.
- **Tool filter** — deny specific tools to this role's agents (e.g. a read-only reviewer).
- **Persona** — the role's standing instructions.

Missing a model? Add the provider in DSH **Settings → Models** first, then hit **refresh catalog** in the Roster.

### 3 · Dispatch your first swarm

In any chat, just ask:

> *"Spawn a swarm: audit every package.json in this repo for stale deps, one task per package, then an integrator compiles a summary table. Review the integrator's output."*

or the one-shot form:

```text
/swarm build a landing page for this project
```

Your agent will call `swarm_dispatch` with a task DAG. (It may plan first itself — that's fine: an architect agent reviews and refines whatever plan it sends.)

### 4 · Watch the run

- **Board** shows the kanban; **Flow** shows the same run as a workflow chart (scheduler → parallel waves → report); click any task for its drawer — brief, model, interim notes, reviewer feedback, retry.
- Tasks with `reviewGate: "human"` park on the board for your Approve/Reject.
- The dispatching chat gets a live progress card; the 🐝 header button and the bottom-right badge track active runs from anywhere.

### 5 · Read the report

When the run finishes it folds into a report: per-task summaries, models used, fallback/retry/review stats. The whole history is an append-only event log you can replay.

> **Defaults worth knowing:** every run starts with an architect review of the plan (skip per dispatch with `architectReview: false`); dispatching into a workspace that already has an active run raises a warning — parallel workstreams belong in one DAG; the roster, badge, and header button are global across workspaces.

## Talking to it

Everything is driven from normal chat — no config files to hand-edit:

> *"Spawn a swarm: audit every package.json in this repo for stale deps, one task per package, then an integrator compiles a summary table. Review the integrator's output."*

or the one-shot form: `/swarm build a landing page for this project` (plans it, then executes it).

| Tool | What it does |
| --- | --- |
| `swarm_dispatch` | Submit a run: title, objective, task DAG (id / subject / description / role / blockedBy / reviewBy / reviewGate / model / evidence / writes). |
| `swarm_status` | The board in text: runs, task states, models in use, latest notes. |
| `swarm_wait` | Block until the board changes or a timeout hits — supervision without sleep-polling. |
| `swarm_retry` | Requeue a failed/blocked task after you've fixed the cause (dispatching session only). |
| `swarm_interrupt` | Abort a stalled/running task and requeue it in the same run — no relief sibling needed (dispatching session only). |
| `swarm_complete` | Mark a task completed when its work was finished outside the swarm (dispatching session only) — keeps the run record in sync with reality. |
| `swarm_report` | Task agents post interim notes to the board (authenticated to their own task). |

Tasks also accept an **evidence contract** — `evidence: { files: [...], commands: [...] }` — that is machine-checked before a task may close; a **write scope** — `writes: [files]` — that keeps concurrent builders out of each other's files (the dispatcher warns on overlap); and a **human review gate** that parks the verdict on the dashboard.

## Configuration

Everything has a default; override in your profile's `cordis.patch.yml`:

```yaml
- id: swarm
  require: dsh-swarm-orchestrator
  config:
    storageDir: !!js dshHomePath("storages/swarm")   # event log + duty table
    maxConcurrent: 5            # simultaneous task agents
    adaptiveConcurrency: true   # shrink on provider pain, recover on success
    spawnStaggerMs: 750         # pace launches within a wave
    nudgeAfterMinutes: 20       # board marker for long-silent tasks (0 = off)
    workspaceRunPolicy: warn      # one-run-per-goal guard: warn | block | off
    requireArchitectReview: true  # architect reviews the dispatcher's plan into PLAN.md first
    staleTimeoutSeconds: 14400  # watchdog: silent agents get reclaimed
    maxRetries: 2               # per task
    reviewLoops: 3              # review rejections per task
    notifyDispatchSession: true  # push completion notification to the dispatching chat
    retryBackoffBaseMs: 5000    # retry backoff: base × 2^attempt before retrying
    circuitBreakerThreshold: 3  # failures in 30s before pausing all retries (0 = off)
    circuitBreakerCooldownMs: 60000  # circuit breaker pause duration
    maxTotalConcurrentAgents: 5 # global cap on concurrent agents across ALL runs
```

## Runtime control

All concurrency, hardening, and watchdog parameters are **tunable from the dashboard** — no YAML editing or restart needed. Open **Settings → AI Swarm → Runtime tuning** (or the **Roster tab → Runtime tuning**) and adjust:

| Parameter | Default | What it controls |
|---|---|---|
| Max concurrent agents | 5 | Simultaneously running task agents **per run** |
| Global agent cap | 5 | Max agents across **all** runs — concurrent runs share this budget (3+2, not 5+5). Prevents heap-exhaustion crashes when running multiple swarms in parallel |
| Spawn stagger (ms) | 750 | Delay between launches in one wave — softens simultaneous provider load |
| Retry backoff base (ms) | 5000 | Failed tasks wait base × 2^attempt before retrying (5s → 10s → 20s) — prevents synchronized retry cascades when a provider outage kills all tasks at once |
| Circuit breaker threshold | 3 | Failures within 30 seconds before pausing all retries (0 = off) — detects provider-wide outages |
| Circuit breaker cooldown (ms) | 60000 | How long retries pause after the breaker trips |
| Nudge after silence (min) | 20 | Board marker for silent tasks — 0 = off |
| Stale timeout (sec) | 14400 | Last-resort reclaim for agents that go completely silent (4 hours) |

Changes are **applied immediately** (no restart) and **persisted to `runtime.json`** in the swarm storage directory, overriding the profile's `cordis.patch.yml` values. They survive host restarts.

> 💡 If you run multiple swarms from different workspaces in parallel, keep the global agent cap at 5 (default) and max 2 concurrent runs. If you experience `ERR_CONNECTION_REFUSED` (host crash), lower the global cap to 3.

## Under the hood

- **Host half** (Node): a `SwarmService` — duty-table store, append-only JSONL event store, projection fold, the dispatcher (parallel one-shot subagents behind a service-owned anchor agent), review loop, watchdog, pause/resume, and `/swarm/*` HTTP + SSE routes.
- **Client half** (browser): the Swarm tab, the chat progress card, the header popover, and the Settings section — all fed by board snapshots over SSE. Model pickers use the same LLM RPCs as the Models settings page.
- **Per-role reasoning effort** rides DSH's `agent/request` waterfall, scoped to tracked swarm children only.
- **Deterministic replay**: state is a fold over the event log, with legality guards — a hostile or duplicated event stream cannot resurrect an aborted run or complete a task twice.

## Status

v0.5.9, running in daily use. The test suite covers the dispatcher end-to-end against a fake spawn provider (88 tests: dispatch, endorsement, architect injection, review loops, human gates, fallback rotation, circuit breaker, retry backoff, quota pause/resume, rescue paths, evidence contracts, write-scope warnings, event-log legality, delegation depth, tool filter, workspace scoping, notification containment), plus live verification on a real deployment.

## License

MIT © linkbag

---

简体中文文档见 [docs/zh-CN.md](https://github.com/linkbag/dsh-swarm-orchestrator/blob/main/docs/zh-CN.md)。
