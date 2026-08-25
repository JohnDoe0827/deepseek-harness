# @deepseek-ai/dsh-codewhale-fleet

[English](README.md) | 中文

DeepSeek Harness 上的 CodeWhale 风格舰队：在活跃舰队运行的每一回合结束后，评审角色——每个角色有自己的 provider、model 和推理档——通过直接 LLM 调用评审任务与代理的最新响应。要求修复的评审会把反馈重新注入会话，让下一步处理它；所有评审通过时运行干净结束。经过 `Config.maxRounds` 轮评审仍未修复时，运行以 `fixes-exhausted` 结束。

会话日志就是运行台账：`fleet/run`、`fleet/review`、`fleet/end` 事件都是持久的，因此状态、resume、fork 和 replay 都从日志折叠而来，无需实时镜像。

## 组合方式

插件挂钩 `agent/turn-stopping`（循环在关闭回合前等待的停止边界），并通过 `ctx.commands` 注册 `/fleet` 命令：

- `/fleet run [task]` — 开始一次运行；可选任务作为用户消息注入。
- `/fleet resume` — 手动为活跃运行重新执行评审。
- `/fleet` / `/fleet status` — 渲染台账。

每个角色可以指定自己的 `provider`/`model`/`reasoningEffort`；都不指定的角色回退到会话的默认路由（`ctx.agentDefaultModel`），因此一次运行可以横跨多家厂商，也可以保持部署默认。评审输出解析为 JSON 对象 `{"verdict": "pass" | "fix", "feedback": "..."}`；无法解析的输出按携带原文的修复请求处理，因此评审永远不会冒充通过。

## 模型体验

### 评审反馈

#### 模型看到什么

`fix` 判定把评审反馈作为用户角色插件消息注入。`pass` 判定与台账事件本身只写日志：代理不会被告知干净的评审。

#### Token 影响

每评审轮有条件：每个角色一次评审调用，每次发送任务加最新助手响应（上限 `Config.maxTranscriptChars`），请求修复时还有注入的反馈。

#### KV Cache 影响

与主会话的请求前缀独立：评审调用是各自路由上的独立一次性请求。注入的反馈作为新的用户角色消息进入主请求。

## 已知限制与待办

- **评审者只见转录，不见工作区** — 评审者只收到任务与最新响应文本；文件 diff 和工具结果不包含在内。
- **一次只修一个** — 多个角色请求修复时，只注入第一个角色的反馈；其余写日志并在 `/fleet status` 中呈现。
- **无按运行提示分段** — 舰队运行不通过系统提示分段宣告；注入的任务与评审反馈承载模型可见的事实。
