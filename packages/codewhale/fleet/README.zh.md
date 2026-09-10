# @deepseek-ai/dsh-codewhale-fleet

[English](README.md) | 中文

DeepSeek Harness 上的 CodeWhale 风格舰队：在活跃舰队运行的每一回合结束后，评审角色——每个角色有自己的 provider、model 和推理档——通过直接 LLM 调用评审任务与代理的最新响应。要求修复的评审会把反馈重新注入会话，让下一步处理它；所有评审通过时运行干净结束。经过 `Config.maxRounds` 轮评审仍未修复时，运行以 `fixes-exhausted` 结束。

`cadence: 'tick'` 的角色是**观察者**而非评审者：它在舰队自己的时钟上评估实时工作者事实——回合时长、静默（无进展）、回合数、重复工具调用——对照 `Config` 中的数值预算，按三级干预（注入 → 转向 → 取消）并记录 `kind: 'observer'` 的持久 `fleet/review` 事件。三级回合上限取消以 `observer-triggered` 结束运行。带 `judge: true` 的 tick 角色还会在自己的间隔上对实时活动窗口做一次直接 LLM 判读，因此舰队能发现持续推进却偏离任务的工作者——确定性预算永远不能。

会话日志就是运行台账：`fleet/run`、`fleet/review`、`fleet/end` 事件都是持久的，因此状态、resume、fork 和 replay 都从日志折叠而来，无需实时镜像。

## 组合方式

插件挂钩 `agent/turn-stopping`（循环在关闭回合前等待的停止边界），在自有 `setInterval` 上运行 tick 观察者角色，并通过 `ctx.commands` 注册 `/fleet` 命令：

- `/fleet run [task]` — 开始一次运行；可选任务作为用户消息注入。
- `/fleet resume` — 手动为活跃运行重新执行评审。
- `/fleet` / `/fleet status` — 渲染台账。

每个角色可以指定自己的 `provider`/`model`/`reasoningEffort`；都不指定的角色回退到会话的默认路由（`ctx.agentDefaultModel`），因此一次运行可以横跨多家厂商，也可以保持部署默认。评审输出解析为 JSON 对象 `{"verdict": "pass" | "fix", "feedback": "..."}`；无法解析的输出按携带原文的修复请求处理，因此评审永远不会冒充通过。tick 预算规则零模型调用：预算是持久日志上的确定性计数器。`judge: true` 的 tick 角色确实在运行活跃期内每 `judgeIntervalMs` 花一次调用，评估任务加近期活动窗口；`fix` 判定转向其反馈并把运行以 `observer-triggered` 结束。

## 配置

```yaml
- id: codewhale-fleet
  name: '@deepseek-ai/dsh-codewhale-fleet'
  config:
    maxRounds: 2
    maxTranscriptChars: 8000
    tickMs: 1000            # tick cadence for observer roles
    maxTurnSeconds: 300     # 0 disables; turn-budget inject
    maxSilenceSeconds: 120  # 0 disables; silence-budget steer
    maxTurns: 50            # 0 disables; turn-cap cancel
    maxRepeatedToolCalls: 3 # 0 disables; repeat-budget steer
    judgeIntervalMs: 5000   # cadence for a judge: true tick role (default tickMs)
    judgeTranscriptChars: 8000  # window cap for the judge (default maxTranscriptChars)
    roles:
      - id: reviewer
        instructions: Review the response against the task.
      - id: observer
        cadence: tick
        instructions: Watch for stalls and loops.
      - id: judge
        cadence: tick
        judge: true
        provider: judge-model   # optional; falls back to the session default
        instructions: Judge whether the worker is serving the task.
```

`cadence` 默认 `turn-stopping`（评审者）；`cadence: tick` 的角色是观察者。预算值是普通数字；`0`、负数或 `NaN` 禁用该规则。`judge: true` 要求 `cadence: tick`，并可命名可选路由。

## 模型体验

### 评审反馈

#### 模型看到什么

`fix` 判定把评审反馈作为用户角色插件消息注入。`pass` 判定与台账事件本身只写日志：代理不会被告知干净的评审。

#### Token 影响

每评审轮有条件：每个角色一次评审调用，每次发送任务加最新助手响应（上限 `Config.maxTranscriptChars`），请求修复时还有注入的反馈。tick 预算规则零 token（只确定性计数器）；`judge: true` 的 tick 角色在运行活跃期内每 `judgeIntervalMs` 加一次调用，每次发送任务加近期活动窗口（上限 `Config.judgeTranscriptChars`）。

#### KV Cache 影响

与主会话的请求前缀独立：评审调用是各自路由上的独立一次性请求。注入的反馈作为新的用户角色消息进入主请求。

### 观察者干预

#### 模型看到什么

一级回合预算提醒为下一步注入；二级（静默、重复）与三级（回合上限）干预在收件箱边界转向或取消，如同用户插话。每次干预还追加 `kind: 'observer'`、`verdict: 'fix'` 的持久 `fleet/review` 事件，记录携带规则 id，投递文本在 `feedback`。判读（无论 `pass` 还是 `fix`）也追加 `kind: 'observer'` 评审；只有判读 `fix` 转向其反馈并把运行以 `observer-triggered` 结束。

#### Token 影响

预算规则本身零 token（无模型调用）。只有投递的提醒/转向文本进入会话作为保留历史，每规则每回合至多一次（且每会话至多一次转向/取消）。`judge: true` 角色在运行活跃期每 `judgeIntervalMs` 花一次模型调用；`pass` 判定只写日志（代理不会被告知干净的判读）。

#### KV Cache 影响

转向终止该代理的可复用请求前缀，直到回合稳定；后续步骤开启新前缀。判读调用是角色自有路由上的独立一次性请求。

## 已知限制与待办

- **评审者只见转录，不见工作区** — 评审者只收到任务与最新响应文本；文件 diff 和工具结果不包含在内。
- **一次只修一个** — 多个角色请求修复时，只注入第一个角色的反馈；其余写日志并在 `/fleet status` 中呈现。
- **无按运行提示分段** — 舰队运行不通过系统提示分段宣告；注入的任务与评审反馈承载模型可见的事实。
- **tick 观察为内存态** — 每会话观察者状态不持久；恢复的会话重新累积预算。
- **判读窗口是近期日志，不是工作区** — `judge: true` 的 tick 角色评估任务加近期 step/tool/助手日志窗口；文件 diff 与工具结果不包含在内。
- **舰队级运行取消按会话** — TS 舰队的 tick 取消其会话所属的那一个工作者；多节点兄弟策略属于 Rust `codewhale_new` 舰队。
