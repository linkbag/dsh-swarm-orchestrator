# dsh-swarm-orchestrator

[简体中文](README.zh-CN.md) · [English](README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）装上一个角色化 AI 蜂群：你出目标，它出团队。架构师拆解任务，多个施工代理并行干活，评审代理把关质量，集成代理负责收尾——整个过程在看板上实时可见。

它就跑在你的 `dsh web` 宿主进程里：没有守护进程、没有第二套服务、没有粘合脚本。任务代理就是普通的 DSH 子代理，用你的工具、你的模型；编排器本身只是一个守规矩的 Cordis 插件。

它已经交付过真实工作：首次生产运行就把一个生物信息研究看板逆向拆解，重建为**六个癌种的指标套件**（680 条人工核验的临床试验数据）——五个数据整编代理并行作业，全部交付物通过机器校验，一个下午完成。

---

## 为什么不只问一个 Agent

单个 Agent 是串行的：耗时的调研排在琐碎修改后面排队，上下文越填越满，质量随之下滑，而且检查输出的还是写输出的那个模型。

这个插件把协调本身做成产品：

- **结构化并行。** 任务用 `blockedBy` 声明依赖，无依赖的任务立刻并发执行；并发上限自适应——provider 顶不住时自动收缩，缓过来再恢复。
- **每个角色一个模型。** DeepSeek、GLM、Kimi、Claude——DSH 里配了什么模型就能钉给什么角色，带有序回退链和逐角色的思考等级阶梯。角色选择器读的是实时模型目录，新增 provider 自动出现。
- **先过评审，才算完成。** 标了 `reviewBy` 的任务由评审代理对照任务简报裁决；驳回就带着反馈回到队列返工。想自己拍板？`reviewGate: "human"`，裁决权回到看板上的你。
- **失败是状态，不是谜语。** provider 超时、配额耗尽、证据缺失——每一类都会被识别、直白地报告，并各有各的处理：带续作提示的重试、整体暂停后一键恢复、反复失败后自动换模型。
- **没有你点头，什么都不跑。** 运行先停在 *planning*，在看板上人工放行才启动。还提供 `requireManualEndorsement` 服务端开关——打开之后，连模型自己都无法从聊天里绕过这道门。

## 看板

**Swarm** 标签页就在 Web GUI 里 Chat 旁边：

- **Board** —— 左侧运行列表，中间任务四列看板（Queued / Running / Done / Failed）。点开任务：完整简报、所用模型、尝试次数、过程中的代理备注、评审反馈、重试按钮。跑完的运行折叠成报告：谁做了什么、用了哪个模型、回退/重试/评审统计。
- **Roster** —— 分工表编辑器：按角色选模型（实时目录、按 provider 分组）、回退链排序、思考等级阶梯、角色并发上限、工具过滤、人设、自定义角色，还有一个"锁定分工表"的覆盖开关。
- **其他地方也能看到** —— 每个会话头部有 🐝 状态按钮，全局有活跃运行徽标，派发运行的那个聊天里直接长出实时进度卡片。

## 一次运行的生命周期

1. **派发** —— 用自然语言告诉 Agent 你要什么，它调 `swarm_dispatch` 提交任务图。新运行先停在 *planning*，一个代理都不会启动。
2. **放行** —— 在看板上过目计划，点 **Endorse**。（聊天里已经口头批准过？Agent 可以带 `endorse: true`。）
3. **执行** —— 调度器通过服务自有的锚定代理派发任务代理：就算派发它的那个聊天早就关了，运行照样继续。
4. **评审** —— 带评审者的任务先被裁决；驳回即带反馈重新入队。带证据合约的任务必须交出它承诺的文件和通过的命令。
5. **报告** —— 运行收尾时给出报告：谁做了什么、用的什么模型、回退/重试/评审统计。全程是可回放的 JSONL 追加日志。

## 安装

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

从源码目录安装：

```sh
pnpm install && pnpm build
dsh plugin --profile web add ./dsh-swarm-orchestrator
```

重启 `dsh web`，在 Chat 旁边打开 **Swarm** 标签页。

## 怎么用

全部通过自然语言驱动，不需要手改配置：

> *"起一个 swarm：把仓库里每个 package.json 的依赖过期情况都查一遍，每个包一个任务，最后让 integrator 汇总成一张表。integrator 的产出要过评审。"*

也有一句话形态：`/swarm 给这个项目做一个落地页`（自动先规划、再执行）。

| 工具 | 用途 |
| --- | --- |
| `swarm_dispatch` | 提交运行：标题、目标、任务图（id / subject / description / role / blockedBy / reviewBy / reviewGate / model / evidence）。 |
| `swarm_status` | 文字版看板：运行、任务状态、所用模型、最新备注。 |
| `swarm_wait` | 阻塞等待看板变化或超时——监督运行不再需要 sleep 轮询。 |
| `swarm_retry` | 排障之后重新入队失败/阻塞的任务（限派发会话）。 |
| `swarm_report` | 任务代理向看板发送过程备注（按任务鉴权）。 |

任务还支持**证据合约**——`evidence: { files: [...], commands: [...] }`，机器校验通过任务才算关闭；也可以开**人工评审门**，裁决权交还看板。

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
    staleTimeoutSeconds: 14400  # 看门狗：静默任务被回收
    maxRetries: 2               # 每个任务的重试次数
    reviewLoops: 3              # 每个任务的评审驳回上限
    requireManualEndorsement: false  # true = 放行门无法从聊天侧绕过
```

## 实现方式

- **宿主半区**（Node）：`SwarmService` —— 分工表存储、JSONL 追加事件日志、投影折叠、调度器（锚定代理背后的并行一次性子代理）、评审循环、看门狗、暂停/恢复、`/swarm/*` HTTP + SSE 路由。
- **浏览器半区**：Swarm 标签页、聊天进度卡片、头部弹窗、设置页分区——全部由 SSE 推送的看板快照驱动；模型选择器与"模型设置"页使用同一套 LLM RPC。
- **逐角色思考等级**通过 DSH 的 `agent/request` waterfall 按请求注入，只作用于受追踪的蜂群子代理。
- **确定性回放**：状态是事件日志的折叠，并带合法性守卫——再刁钻的事件序列也无法让已中止的运行复活、让任务被重复完成。

## 状态

v0.3.0，日常使用中。测试覆盖调度器对假 spawn provider 的端到端行为（38 个用例：派发、放行、评审循环、模型回退、配额暂停、救援路径、证据合约、事件日志合法性），并已在真实部署上完成在线验证。

## 许可证

MIT © linkbag
