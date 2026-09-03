# dsh-swarm-orchestrator

[English](README.md) · [简体中文](README.zh-CN.md)

Role-based AI swarms for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Give it a goal, get a team: an architect breaks the work into a task graph, parallel builders execute it, reviewers hold the line, and an integrator ships the result — while you watch the whole thing move on a live kanban board.

It runs **inside** your `dsh web` host. No daemon, no second process, no glue scripts. Task agents are ordinary DSH subagents with your tool access and your models; the orchestrator is just a well-behaved Cordis plugin.

It has already shipped real work: the first production run reverse-engineered a biotech research dashboard and rebuilt it as a **six-indication suite** (680 curated clinical trials across six cancers) in a single afternoon — five data-curation agents working in parallel, every deliverable machine-verified.

---

## Why not just ask one agent?

Because one agent serializes. Long research tasks queue behind quick edits, context fills up, quality drifts, and nothing checks the output but the same model that wrote it.

This plugin takes the coordination seriously so you don't have to:

- **Parallel by construction.** Tasks declare dependencies (`blockedBy`); everything independent runs at once, bounded by a concurrency cap that adapts when the provider struggles.
- **Every role gets its own model.** Pin DeepSeek, GLM, Kimi, Claude — any model configured in DSH — to any role, with an ordered fallback chain and a per-role reasoning-effort ladder. The picker reads your live model catalog, so new providers show up automatically.
- **Review before "done" means done.** Tasks tagged `reviewBy` are judged by a reviewer agent against the task brief; a rejection loops back to the builder with the feedback attached. Want the last word yourself? Set `reviewGate: "human"` and approve from the dashboard.
- **Failure is a state, not a mystery.** Provider timeouts, quota exhaustion, bad evidence — each is detected, reported plainly, and handled: retries with resume hints, run pause/resume instead of burn-down, automatic model rotation after repeated failures.
- **Nothing starts without you.** Runs sit in *planning* until you endorse them on the board. A server-side option (`requireManualEndorsement`) makes that gate impossible to bypass from chat, even by a model that decides to be helpful.

## The dashboard

A **Swarm** tab lives next to Chat in the web GUI:

- **Board** — runs on the left, task columns (Queued / Running / Done / Failed) front and center. Click a task for its full brief, model, attempt count, interim agent notes, reviewer feedback, and retry. Completed runs fold into a report with per-task summaries and fallback/retry/review stats.
- **Roster** — the duty-table editor: per-role model pickers fed by your live catalog, fallback-chain ordering, effort ladder, concurrency caps, tool filters, personas, custom roles, and an override lock for "hands off my table".
- **Everywhere else** — a 🐝 status button in every session header, a small badge for active runs, and a live progress card right in chat where the run was dispatched.

## How a run works

1. **Dispatch** — tell your agent what you want; it calls `swarm_dispatch` with a task graph. Runs start gated: *planning*, zero agents spawned.
2. **Endorse** — you review the plan on the board and hit **Endorse**. (Approved it in chat already? The agent can pass `endorse: true`.)
3. **Execute** — the dispatcher spawns task agents through a service-owned anchor, so the run keeps going even if the chat that started it is long gone.
4. **Review** — tasks with a reviewer get judged; rejections requeue with feedback. Tasks with an evidence contract must produce the files and passing commands they promised.
5. **Report** — the run closes with a report: who did what, on which models, with fallback/retry/review stats. The whole history is an append-only JSONL event log you can replay.

## Install

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

From a source checkout:

```sh
pnpm install && pnpm build
dsh plugin --profile web add ./dsh-swarm-orchestrator
```

Then restart `dsh web` and open the **Swarm** tab next to Chat.

## Talking to it

Everything is driven from normal chat — no config files to hand-edit:

> *"Spawn a swarm: audit every package.json in this repo for stale deps, one task per package, then an integrator compiles a summary table. Review the integrator's output."*

or the one-shot form: `/swarm build a landing page for this project` (plans it, then executes it).

| Tool | What it does |
| --- | --- |
| `swarm_dispatch` | Submit a run: title, objective, task DAG (id / subject / description / role / blockedBy / reviewBy / reviewGate / model / evidence). |
| `swarm_status` | The board in text: runs, task states, models in use, latest notes. |
| `swarm_wait` | Block until the board changes or a timeout hits — supervision without sleep-polling. |
| `swarm_retry` | Requeue a failed/blocked task after you've fixed the cause (dispatching session only). |
| `swarm_report` | Task agents post interim notes to the board (authenticated to their own task). |

Tasks also accept an **evidence contract** — `evidence: { files: [...], commands: [...] }` — that is machine-checked before a task may close, and a **human review gate** that parks the verdict on the dashboard.

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
    staleTimeoutSeconds: 14400  # watchdog: silent agents get reclaimed
    maxRetries: 2               # per task
    reviewLoops: 3              # review rejections per task
    requireManualEndorsement: false  # true = the endorse gate cannot be bypassed from chat
```

## Under the hood

- **Host half** (Node): a `SwarmService` — duty-table store, append-only JSONL event store, projection fold, the dispatcher (parallel one-shot subagents behind a service-owned anchor agent), review loop, watchdog, pause/resume, and `/swarm/*` HTTP + SSE routes.
- **Client half** (browser): the Swarm tab, the chat progress card, the header popover, and the Settings section — all fed by board snapshots over SSE. Model pickers use the same LLM RPCs as the Models settings page.
- **Per-role reasoning effort** rides DSH's `agent/request` waterfall, scoped to tracked swarm children only.
- **Deterministic replay**: state is a fold over the event log, with legality guards — a hostile or duplicated event stream cannot resurrect an aborted run or complete a task twice.

## Status

v0.3.0, running in daily use. The test suite covers the dispatcher end-to-end against a fake spawn provider (38 tests: dispatch, endorsement, review loops, fallbacks, quota pause, rescue paths, evidence contracts, event-log legality), plus live verification on a real deployment.

## License

MIT © linkbag

---

简体中文文档见 [README.zh-CN.md](README.zh-CN.md)。
