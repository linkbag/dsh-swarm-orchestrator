# dsh-swarm-orchestrator

[简体中文](https://github.com/linkbag/dsh-swarm-orchestrator/blob/main/docs/zh-CN.md) · [English](https://github.com/linkbag/dsh-swarm-orchestrator/blob/main/README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）装上一个角色化 AI 蜂群：你出目标，它出团队。架构师拆解任务，多个施工代理并行干活，评审代理把关质量，集成代理负责收尾——整个过程在看板上实时可见。

它就跑在你的 `dsh web` 宿主进程里：没有守护进程、没有第二套服务、没有粘合脚本。任务代理就是普通的 DSH 子代理，用你的工具、你的模型；编排器本身只是一个守规矩的 Cordis 插件。

它已经交付过真实工作：首次生产运行就把一个生物信息研究看板逆向拆解，重建为**六个癌种的指标套件**（680 条人工核验的临床试验数据）——五个数据整编代理并行作业，全部交付物通过机器校验，一个下午完成。

---

## 一图速览

**dsh-swarm-orchestrator** 在 DeepSeek Harness 内把一个目标变成一支有监督的代理团队：架构师把你的方案审阅精炼成 `PLAN.md`，多个建造者按任务 DAG 并行执行，评审代理把关质量，集成代理收尾交付。每个角色都钉选你实时目录里的模型，每项交付都可机器校验，全程在实时看板与流程图上可见。

```text
        你 ── “起一个 swarm：⟨目标⟩”
         │
         ▼
   你的聊天 Agent            （自行规划/调研完全没问题——
         │  swarm_dispatch    它的方案会成为待审提案）
         ▼
  ┌─────────────────┐
  │ architect-review │  对照仓库深审提案，合并并行工作流（证据合约把关），
  │  → PLAN.md       │  产出 PLAN.md
  └────────┬────────┘
    ┌──────┼──────┐
    ▼      ▼      ▼
 builder builder builder    ▸ 并行波次——每个角色一个模型，
    │      │      │           带回退链与独占写入范围
    ▼      ▼      ▼
 reviewer reviewer (human)   ▸ 驳回带反馈返工；
    └──────┼──────┘            `reviewGate: "human"` 交由你裁决
           ▼
       integrator             ▸ 合并、验证、交付
           ▼
       📄 run report          ▸ 各任务总结 · 所用模型 · 统计
```

## 看板流程实时监测示例

<img width="1059" height="475" alt="image" src="https://github.com/user-attachments/assets/f52b26ae-2c24-49d0-b713-1b584f92c043" />


## 为什么不只问一个 Agent

单个 Agent 是串行的：耗时的调研排在琐碎修改后面排队，上下文越填越满，质量随之下滑，而且检查输出的还是写输出的那个模型。

这个插件把协调本身做成产品：

- **结构化并行。** 任务用 `blockedBy` 声明依赖，无依赖的任务立刻并发执行；并发上限自适应——provider 顶不住时自动收缩，缓过来再恢复。
- **每个角色一个模型。** DeepSeek、GLM、Kimi、Claude——DSH 里配了什么模型就能钉给什么角色，带有序回退链和逐角色的思考等级阶梯。角色选择器读的是实时模型目录，新增 provider 自动出现。
- **先过评审，才算完成。** 标了 `reviewBy` 的任务由评审代理对照任务简报裁决；驳回就带着反馈回到队列返工。想自己拍板？`reviewGate: "human"`，裁决权回到看板上的你。
- **失败是状态，不是谜语。** provider 超时、配额耗尽、证据缺失——每一类都会被识别、直白地报告，并各有各的处理：带续作提示的重试、整体暂停后一键恢复、反复失败后自动换模型。
- **只看你所在的战场。** 每个聊天的 Swarm 标签页默认只显示该工作区的运行；一个常驻开关随时切到"全部运行"。
- **一个目标一次运行，先审后建。** 向已有活跃运行的工作区再派发会收到警告（或按配置直接拦截）；默认情况下，架构师代理会先把派发方的计划审阅精炼成 PLAN.md，建造者才开始动工。
- **内存安全的并发。** 蜂群代理运行在 DSH 宿主进程内，共享其 Node.js 堆内存。全局代理上限（`maxTotalConcurrentAgents`，默认 5）确保来自不同工作区的并发运行共享代理预算（3+2 而非 5+5）——防止过多代理同时运行导致堆内存耗尽、宿主崩溃。
- **成果比代理活得久。** 每个任务代理在最后一步写一份完成报告。如果宿主重启、代理在"干完活"与"被记录"之间被杀掉，调度器会采纳磁盘上的报告，而不是把已完成的成果丢掉重跑。任务也不会永远卡在 `dispatching`：`spawnTimeoutSeconds` 提供了心跳看门狗覆盖不到的硬上限。
- **每个代理都在看板上。** 任务代理不能自己再派生子代理（`maxSubagentDepth`，默认 1）。没有这道限制时，代理可以派生调度器既看不见、也无法计量的助手——不计入全局上限、不受看门狗跟踪、不出现在看板上，却同样占用宿主的堆内存。实测：某个任务在后台派生了 12 个这样的隐藏助手，而看板上始终只显示一个任务。

> ⚠️ **从不同工作区并行运行多个 swarm**：受支持且在全局上限内是安全的。但请注意，每个蜂群代理都是宿主上的一个进程内会话。我们建议**最多 2 个并发运行**，全局代理上限保持默认的 5。如果遇到 `ERR_CONNECTION_REFUSED`（宿主崩溃），请在 Runtime 设置中将 `maxTotalConcurrentAgents` 降到 3。

### 可靠性说明（v0.5.8）

以下问题来自对 47 次运行、184 次任务失败的诊断，均已修复并补上回归测试：

- **证据命令现在通过 PowerShell 执行**（其他平台为 bash），工作目录为运行工作区，`evidence.commands` 的 schema 也明确写了这一点。此前它们被交给 `cmd.exe`，于是一条再正常不过的 PowerShell 断言（`if (Test-Path …) { exit 0 }`）就会让任务失败——占全部任务失败的 32%。能用文件检查表达的断言请优先用 `evidence.files`：它完全不涉及 shell。
- **shipped 名册默认对 swarm 角色禁用 `modlens`**：它是一个交互式工具，会反过来向用户提问，而蜂群子代理是非交互运行的。如果你的部署有可用的无头视觉 provider，可在名册里按角色加回来。
- **未声明 `"status": "completed"` 的任务报告永远不会被采纳**——采纳机制不可能掩盖未完成的工作。
- **恢复仅限运行中的运行。** 孤儿恢复只会重排"所属运行仍在运行"的任务，因此终结状态的运行其任务保持冻结，不会在每次宿主重启时被反复失败。

## 看板

**Swarm** 标签页就在 Web GUI 里 Chat 旁边，共三个视图：

- **Board** —— 左侧运行列表，中间任务四列看板（Queued / Running / Done / Failed）。点开任务：完整简报、所用模型、尝试次数、过程中的代理备注、评审反馈、重试按钮。跑完的运行折叠成报告：谁做了什么、用了哪个模型、回退/重试/评审统计。
- **Flow** —— 任务 DAG 的实时流程图：顶部调度器、任务按波次扇出（同一波 = 并行执行）、依赖箭头在前置完成时变绿、节点上带评审与写入范围提示，最终汇入运行报告。谁并行、谁串行、跑到哪一步，一眼可见。
- **Roster** —— 分工表编辑器：按角色选模型（实时目录、按 provider 分组）、回退链排序、思考等级阶梯、角色并发上限、工具过滤、人设、自定义角色，还有一个"锁定分工表"的覆盖开关。
- **其他地方也能看到** —— 每个会话头部有 🐝 状态按钮，全局有活跃运行徽标，派发运行的那个聊天里直接长出实时进度卡片。
- **工作区感知** —— 每个聊天的 Swarm 标签页只显示该工作区的运行；**All** 开关随时查看机器上的全部运行。Roster 保持全局（一张分工表，管所有工作区）。

## 一次运行的生命周期

1. **派发** —— 用自然语言告诉 Agent 你要什么，它调 `swarm_dispatch` 提交任务图。新运行先停在 *planning*，一个代理都不会启动。
3. **执行** —— 调度器通过服务自有的锚定代理派发任务代理：就算派发它的那个聊天早就关了，运行照样继续。
4. **评审** —— 带评审者的任务先被裁决；驳回即带反馈重新入队。带证据合约的任务必须交出它承诺的文件和通过的命令。
5. **报告** —— 运行收尾时给出报告：谁做了什么、用的什么模型、回退/重试/评审统计。全程是可回放的 JSONL 追加日志。

## 上手指南（约 5 分钟）

### 1 · 安装

直接从 GitHub 安装（pnpm 会运行包的 `prepare` 脚本现场构建）：

```sh
dsh plugin --profile web add github:linkbag/dsh-swarm-orchestrator
```

pnpm ≥ 10 会先要求你放行这次构建——把它打印的包名原样加进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-swarm-orchestrator: true
```

然后重新执行 `add`。（这一步等于授权在安装时执行本包的代码，请按信任原则处理；也可以钉住 commit：`github:linkbag/dsh-swarm-orchestrator#<sha>`。）

或从 npm 安装预构建版本——无需放行构建：

```sh
dsh plugin --profile web add dsh-swarm-orchestrator
```

然后重启 `dsh web`。你会在 Chat 旁看到 **Swarm** 标签页、每个会话头部的 🐝 按钮，以及 **Settings → AI Swarm**（标题旁显示运行版本号——可用来确认安装生效）。

### 2 · 给角色分配模型

在任意聊天打开 **Swarm** 标签页，切到 **Roster**——或打开 **Settings → AI Swarm**（同一编辑器，随处可达）。四个内置角色：

| 角色 | 职责 |
| --- | --- |
| **architect** | 审阅提案，精炼为 `PLAN.md` |
| **builder** | 完整实现一个任务并自行验证 |
| **reviewer** | 对照任务简报评判完成的工作 |
| **integrator** | 合并并行成果并交付 |

为每个角色在下拉框里选模型：列表列出 **DSH 已配置的所有 provider**（DeepSeek、GLM、Kimi、Claude……），按 provider 分组——与“模型设置”页同一份实时目录。保持 **inherit deployment default** 则沿用派发聊天所用的模型。

可选配置（均有合理默认值）：

- **回退链** —— 主模型不可用时按序尝试。
- **思考等级 + 等级阶梯** —— 该角色的推理力度，重试时逐级下调。
- **并发上限** —— 限制该角色同时运行的代理数。
- **工具过滤** —— 对该角色的代理禁用指定工具（比如只读评审员）。
- **人设** —— 角色的常设指令。

找不到某个模型？先在 DSH **Settings → Models** 添加 provider，再回 Roster 点 **refresh catalog**。

### 3 · 派发第一个 swarm

在任意聊天里直接说：

> *“起一个 swarm：把仓库里每个 package.json 的依赖过期情况都查一遍，每个包一个任务，最后让 integrator 汇总成一张表。integrator 的产出要过评审。”*

或一句话形态：

```text
/swarm 给这个项目做一个落地页
```

你的 Agent 会调 `swarm_dispatch` 提交任务 DAG。（它先自行规划也没问题——架构师会审阅并精炼它提交的任何方案。）

### 4 · 观察运行

- **Board** 是看板视图；**Flow** 是同一运行的流程图（调度器 → 并行波次 → 报告）；点开任务看抽屉——简报、模型、过程备注、评审反馈、重试。
- 带 `reviewGate: "human"` 的任务会停在看板上等你 Approve/Reject。
- 派发运行的那个聊天会长出实时进度卡片；🐝 头部按钮与右下角徽标在任何页面都能看到活跃运行。

### 5 · 阅读报告

运行结束后折叠成报告：各任务总结、所用模型、回退/重试/评审统计。全程是可回放的追加式事件日志。

> **值得知道的默认行为：** 每个运行默认先做架构师审阅（单次派发可用 `architectReview: false` 跳过）；向已有活跃运行的工作区再派发会收到警告——并行工作流应该放进同一个 DAG；Roster、徽标、头部按钮跨工作区全局生效。

## 怎么用

全部通过自然语言驱动，不需要手改配置：

> *"起一个 swarm：把仓库里每个 package.json 的依赖过期情况都查一遍，每个包一个任务，最后让 integrator 汇总成一张表。integrator 的产出要过评审。"*

也有一句话形态：`/swarm 给这个项目做一个落地页`（自动先规划、再执行）。

| 工具 | 用途 |
| --- | --- |
| `swarm_dispatch` | 提交运行：标题、目标、任务图（id / subject / description / role / blockedBy / reviewBy / reviewGate / model / evidence / writes）。 |
| `swarm_status` | 文字版看板：运行、任务状态、所用模型、最新备注。 |
| `swarm_wait` | 阻塞等待看板变化或超时——监督运行不再需要 sleep 轮询。 |
| swarm_retry | 排障之后重新入队失败/阻塞的任务（限派发会话）。 |
| swarm_interrupt | 中断一个停滞/失控的蜂群任务：中止其子代理并在同一运行内重新入队——无需另起救援运行（限派发会话）。 |
| swarm_complete | 当工作在蜂群外部完成时（如救援子代理或直接编辑），将任务标记为已完成——保持运行记录与现实同步（限派发会话）。 |
| `swarm_report` | 任务代理向看板发送过程备注（按任务鉴权）。 |

任务还支持**证据合约**——`evidence: { files: [...], commands: [...] }`，机器校验通过任务才算关闭；**写入范围**——`writes: [files]`，并发建造者互不越界（调度器会对重叠范围给出警告）；以及**人工评审门**，裁决权交还看板。

## 配置

所有项都有默认值；需要覆盖时写进 profile 的 `cordis.patch.yml`：

```yaml
- id: swarm
  require: dsh-swarm-orchestrator
  config:
    storageDir: !!js dshHomePath("storages/swarm")   # 事件日志 + 分工表
    maxConcurrent: 5            # 同时运行的任务代理数
    adaptiveConcurrency: true   # provider 吃紧时收缩，恢复后回升
    spawnStaggerMs: 750         # 同一波派发的启动间隔
    nudgeAfterMinutes: 20       # 长时间静默的任务在看板上打点（0 = 关闭）
    workspaceRunPolicy: warn      # 单运行守门：warn | block | off
    requireArchitectReview: true  # 架构师先审阅并精炼派发计划（产出 PLAN.md）
    staleTimeoutSeconds: 14400  # 看门狗：静默任务被回收
    maxRetries: 2               # 每个任务的重试次数
    reviewLoops: 3              # 每个任务的评审驳回上限
    notifyDispatchSession: true  # 运行结束时向派发聊天推送完成通知
    retryBackoffBaseMs: 5000    # 重试退避基础间隔（毫秒）
    circuitBreakerThreshold: 3  # 熔断器阈值：30 秒内此数量的失败将暂停所有重试
    circuitBreakerCooldownMs: 60000  # 熔断器暂停持续时间
    maxTotalConcurrentAgents: 5 # 所有运行的总代理数上限
```

## 运行时调优

所有并发、熔断和看门狗参数都**可以在仪表盘上直接调整**——无需改 YAML、无需重启。打开 **Settings → AI Swarm → Runtime tuning**（或 **Roster 标签页 → Runtime tuning**）：

| 参数 | 默认值 | 控制什么 |
|---|---|---|
| Max concurrent agents | 5 | **单个运行**内同时运行的任务代理数 |
| Global agent cap | 5 | **所有运行**加起来的总代理上限——并发运行共享此预算（3+2 而非 5+5）。防止并行运行多个 swarm 时堆内存耗尽导致宿主崩溃 |
| Spawn stagger (ms) | 750 | 同一波内启动间隔——减轻 provider 瞬时压力 |
| Retry backoff base (ms) | 5000 | 失败任务按 base × 2^n 递增等待后重试（5s → 10s → 20s）——防止 provider 全局故障时所有任务同时重试的级联风暴 |
| Circuit breaker threshold | 3 | 30 秒内多少次失败后暂停所有重试（0 = 关闭）——识别 provider 级故障 |
| Circuit breaker cooldown (ms) | 60000 | 熔断后暂停多久再自动恢复 |
| Nudge after silence (min) | 20 | 静默任务在看板上打标记的阈值——0 = 关闭 |
| Stale timeout (sec) | 14400 | 完全静默代理的最后回收手段（4 小时） |

修改**立即生效**（无需重启）并**持久化到 `runtime.json`**（在 swarm 存储目录中），覆盖 profile `cordis.patch.yml` 中的同名值，重启后仍然有效。

> 💡 如果从不同工作区并行运行多个 swarm，建议全局代理上限保持默认 5、最多 2 个并发运行。如果遇到 `ERR_CONNECTION_REFUSED`（宿主崩溃），请将全局上限降到 3。

## 实现方式

- **宿主半区**（Node）：`SwarmService` —— 分工表存储、JSONL 追加事件日志、投影折叠、调度器（锚定代理背后的并行一次性子代理）、评审循环、看门狗、暂停/恢复、`/swarm/*` HTTP + SSE 路由。
- **浏览器半区**：Swarm 标签页、聊天进度卡片、头部弹窗、设置页分区——全部由 SSE 推送的看板快照驱动；模型选择器与"模型设置"页使用同一套 LLM RPC。
- **逐角色思考等级**通过 DSH 的 `agent/request` waterfall 按请求注入，只作用于受追踪的蜂群子代理。
- **确定性回放**：状态是事件日志的折叠，并带合法性守卫——再刁钻的事件序列也无法让已中止的运行复活、让任务被重复完成。

## 状态

v0.5.9，日常使用中。测试覆盖调度器对假 spawn provider 的端到端行为（88 个用例：派发、放行、评审循环、人工评审门、模型回退轮换、配额暂停/恢复、救援路径、证据合约、写入范围警告、事件日志合法性），并已在真实部署上完成在线验证。

## 许可证

MIT © linkbag
