# dsh-swarm-orchestrator

Role-based AI swarm orchestration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

A **duty table** pins each role (architect / builder / reviewer / integrator — or your own) to any model configured in DSH,
tasks execute as a parallel DAG of one-shot subagents with optional review loops, and a live **Swarm** dashboard tab in the web GUI
shows the org structure, task flow, per-agent progress, and per-role model pickers fed by your live model catalog.

Inspired by [OpenClaw Swarm v4](https://github.com/linkbag/epic-ai-swarm-orchestration) — re-architected native to DSH:
no daemon, no separate process; the orchestrator is a Cordis plugin inside your `dsh web` host, and task agents are real DSH subagents.

## Features

- **Duty table with model pinning** — per-role provider/model, ordered fallback chain, reasoning effort, max tokens, persona.
  Models come from whatever providers you have configured in DSH (DeepSeek official, GLM, Kimi, Claude, …) — same list as the Models settings page.
- **Task DAG, parallel one-shot agents** — independent tasks run concurrently (bounded by `maxConcurrent`), blocked tasks wait on their blockers.
- **Review loops** — a task with `reviewBy: reviewer` gets its output judged by the reviewer role; rejections loop back with feedback, capped at `reviewLoops`.
- **Model fallback** — if the pinned model is unavailable, the role's fallback chain is tried silently before the task fails (and failing tasks retry up to `maxRetries`).
- **Endorsement gate** — runs start in *planning*; you endorse them on the dashboard (or pass `endorse: true` when the human already approved).
- **Live dashboard** — Swarm tab in the web GUI: run list, task columns (Queued / Running / Done / Failed), task drawer with briefs, notes, summaries, reviewer feedback, and per-task retry.
- **Run reports** — end-of-run report with per-task summaries, models used, fallback/retry/review stats.
- **Event-sourced state** — everything is an append-only JSONL event log under `$DSH_HOME/storages/swarm`; host restarts recover mid-flight tasks.
- **Watchdog** — silent task agents are aborted and requeued after `staleTimeoutSeconds`.

## Tools the model sees

| Tool | Purpose |
| --- | --- |
| `swarm_dispatch` | Submit a run: title, objective spec, task DAG (id / subject / description / role / blockedBy / reviewBy). |
| `swarm_status` | Compact board report (runs, task states, models, latest notes). |
| `swarm_report` | Task agents post one-line interim progress notes to the dashboard. |

Example dispatch:

```json
{
  "title": "Add settings export",
  "spec": "Add an export button to the settings page that downloads current settings as JSON.",
  "tasks": [
    { "id": "design", "subject": "Design the export format", "description": "Decide the JSON schema …", "role": "architect" },
    { "id": "impl", "subject": "Implement export", "description": "Add the button + handler …", "role": "builder", "blockedBy": ["design"], "reviewBy": "reviewer" },
    { "id": "docs", "subject": "Document it", "description": "Update the user guide …", "role": "builder", "blockedBy": ["impl"] }
  ]
}
```

The run appears on the Swarm tab immediately; endorse it there to launch.

## Install

Once published to the marketplace:

```sh
dsh plugin --profile web add dsh-swarm-orchestrator
```

From a checkout:

```sh
pnpm install && pnpm build
dsh plugin --profile web add ./dsh-swarm-orchestrator
```

Then restart `dsh web` (or reload the profile) and open the **Swarm** tab next to Chat / Trajectory.

## Configuration

Row in `cordis.patch.yml` (defaults shown):

```yaml
- id: swarm
  require: dsh-swarm-orchestrator
  config:
    storageDir: !!js dshHomePath("storages/swarm")   # keep unquoted
    maxConcurrent: 5        # simultaneous task agents
    staleTimeoutSeconds: 14400
    maxRetries: 2           # per task
    reviewLoops: 3          # max review rejections per task
```

## Dashboard

- **Board** — run list on the left; selected run shows task columns, and a task drawer with the full brief, model, attempts, reviewer feedback, and retry/endorse/abort actions. Completed runs carry a run report.
- **Roster** — the duty-table editor: per-role model picker (live catalog, grouped by provider), fallback-chain ordering, effort, max tokens, persona, custom roles, and a manual override lock that freezes the table against edits.

## Architecture

- Host half (Node): `SwarmService` — duty-table store, JSONL event store, projection fold, dispatcher (spawn provider subagents, bounded concurrency), review loop, watchdog, `/swarm/*` HTTP + SSE routes.
- Client half (browser): the Swarm tab (board + roster), fed by board snapshots over SSE pings; model catalog via the same llm RPCs the Models settings page uses.
- Per-role reasoning effort is applied per-request through the `agent/request` waterfall (DSH `AgentOptions` has no effort field) and scoped to tracked swarm children only.

## Development

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # lib/ (host half) + lib/client.js (browser half)
```

## License

MIT © linkbag

---

# dsh-swarm-orchestrator（中文）

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的角色化 AI 群体编排插件。

**职责表（duty table）**为每个角色（架构 / 施工 / 评审 / 集成，或自定义角色）指定 DSH 中已配置的任意模型；
任务以并行 DAG 的方式由一次性子代理执行，可选评审回环；Web GUI 中的 **Swarm** 仪表盘标签页实时展示组织结构、
任务流转、各代理进度，以及基于实时模型目录的角色模型选择器。

灵感来自 [OpenClaw Swarm v4](https://github.com/linkbag/epic-ai-swarm-orchestration)，并按 DSH 原生架构重新实现：
没有守护进程、没有额外进程——编排器就是 `dsh web` 宿主内的一个 Cordis 插件，任务代理是真正的 DSH 子代理。

## 特性

- **职责表模型锁定**：按角色配置 provider/模型、有序回退链、思考等级、max tokens、人设；模型列表来自 DSH 已配置的所有 provider（DeepSeek 官方、GLM、Kimi、Claude……），与“模型设置”页一致。
- **任务 DAG + 并行一次性代理**：无依赖任务并发执行（`maxConcurrent` 限流），被阻塞任务等待前置完成。
- **评审回环**：带 `reviewBy` 的任务完成后由评审角色判定；驳回则携带反馈回到队列，上限 `reviewLoops` 次。
- **模型回退**：主模型不可用时静默尝试回退链；任务失败按 `maxRetries` 重试。
- **人工背书门**：运行先处于 planning 状态，在仪表盘点“背书”后才启动。
- **实时仪表盘**：运行列表、任务四列看板、任务抽屉（简报 / 备注 / 总结 / 评审反馈）、失败重试。
- **运行报告**：运行结束时生成含各任务总结、所用模型、回退/重试/评审统计的报告。
- **事件溯源**：全部状态是 `$DSH_HOME/storages/swarm` 下的 JSONL 追加日志；宿主重启自动恢复中断任务。
- **看门狗**：超过 `staleTimeoutSeconds` 无进展的任务代理被中止并重新排队。

## 模型可见的工具

| 工具 | 用途 |
| --- | --- |
| `swarm_dispatch` | 提交运行：标题、目标说明、任务 DAG（id / subject / description / role / blockedBy / reviewBy）。 |
| `swarm_status` | 紧凑看板汇报（运行、任务状态、模型、最新备注）。 |
| `swarm_report` | 任务代理向仪表盘发送单行进度备注。 |

## 安装

发布到插件市场后：

```sh
dsh plugin --profile web add dsh-swarm-orchestrator
```

或从源码目录安装：

```sh
pnpm install && pnpm build
dsh plugin --profile web add ./dsh-swarm-orchestrator
```

重启 `dsh web` 后，在 Chat / Trajectory 旁打开 **Swarm** 标签页。

## 许可证

MIT © linkbag
