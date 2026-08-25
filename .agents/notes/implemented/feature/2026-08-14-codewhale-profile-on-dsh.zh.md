# Agent Note: DeepSeek Harness 上的 CodeWhale profile

Status: implemented

[English](2026-08-14-codewhale-profile-on-dsh.md) | 中文

## 问题

CodeWhale（原 DeepSeek-TUI）把三个标志性机制——多模型舰队评审、带写保护的工作区宪法、带 undo/restore 的回合级工作区快照——打包在一个 Rust 二进制里。移植进 DeepSeek Harness 意味着在 harness 的插件接缝上重新实现每个机制，而不是复刻二进制：会话日志是持久台账，fs 决策瀑布是写保护的执行点，命令注册表是斜杠命令界面。

## 决策

**`packages/codewhale/` 下三个函数插件，加一个 profile bundle。** `dsh-codewhale-constitution` 把工作区 YAML 文件渲染进 `codewhale:constitution` 提示分段（order 60），并以 `prepend: true` 占据 `fs/write-intent`/`fs/edit-intent` 单槽决策瀑布：被保护目标抛 `FS_PERMISSION_DENIED`，其余通过 `next()` 委托。prepend 对装载顺序免疫：base bundle 的观测策略先于本插件挂载，而单槽瀑布按注册顺序运行监听器。`dsh-codewhale-snapshot` 挂钩 `session/event` 的 `turn/end`，在内容指纹变化时把工作区（减去配置的 excludes）复制到 `$DSH_HOME/codewhale/snapshots/<sessionId>/<seq>/`，并注册 `/undo` 与 `/restore`；恢复是持久的 `snapshot/restore` 事件加上一条注入的模型可见提示。`dsh-codewhale-fleet` 挂钩 `agent/turn-stopping`，按角色在其自有 provider/model 路由上各跑一次直接 LLM 调用（回退 `ctx.agentDefaultModel`），并把 fix 反馈重新注入会话；会话日志本身就是舰队台账（`fleet/run`、`fleet/review`、`fleet/end`），因此状态、resume 和 replay 都从日志折叠而来，无需实时镜像。`dsh-codewhale` bundle 在 `dsh-base` 之上插入三行；`codewhale` profile 通过 `dsh plugin --profile codewhale add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-codewhale` 启动。

**评审判定是固定 JSON 协议。** `{"verdict": "pass" | "fix", "feedback": "..."}` 是协议常量；无法解析的评审输出按携带原文的修复请求处理，因此评审永远不会冒充通过。

## 曾考虑的替代方案

**在工具层执行写保护。** 不采用：包装器不算执行，仓库规则要求在做出决策的操作里拒绝——对面向模型的 fs 工具而言，fs 瀑布就是那个操作。

**给 `FsWriteIntent` 加 reject 变体。** 不采用：单槽瀑布中的拒绝通过抛 `FsError` 表达，正如观测策略拒绝未观测编辑一样；扩宽 intent 联合会为一个消费者改动核心契约。

**基于文件的舰队台账。** 不采用：会话日志已经是追加式、可重放的台账，把舰队事件记入日志就满足 model-visible ⟺ logged 不变量，无需第二套持久化。

**沙箱级写保护。** 本里程碑不采用：沙箱策略内的路径级拒绝能覆盖 shell 写入，但要改动沙箱服务和提供方；fs 瀑布执行覆盖面向模型的 fs 工具，shell 写入覆盖记为已知限制。

## 后果

`codewhale` profile 把 CodeWhale 机制变成可组合插件交给 harness：`/fleet run [task]` 在每回合后启动多模型评审轮（上限 `maxRounds`），`/undo` 与 `/restore` 把工作区回滚到精确快照，工作区 `codewhale.constitution.yml` 注入常驻指令并拒绝写入受保护路径（与审批姿态无关）。每个插件都通过文档化的扩展点注册；agent-loop 与核心契约零改动。评审调用只发送任务与最新助手响应，转录上限约束其成本；快照是整工作区拷贝，大型仓库每回合付出拷贝成本——两者都记为后续已知限制。bundle 不附带 TUI；终端用户在其旁挂载社区 TUI 插件。
