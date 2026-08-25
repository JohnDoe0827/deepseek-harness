# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

以 profile 组合包形式交付的 dsh 终端界面：[`cordis.patch.yml`](cordis.patch.yml) 在 `dsh-base` 行之上应用 TUI patch 层（镜像 [`dsh-web-app`](../web-app/README.md) 叠放 Web 界面的方式），随后插入仅终端使用的行。patch 会替换目标行的整个 `config`，因此下面的每一行都会重述它拥有的每个键。该包除 patch manifest（`dsh.bundle.patch`）与 `startup`／`invariant` 模块外没有运行时 API；profile 组合器通过 manifest 字段解析 patch。

特化 base 值的行：`system-prompt` 设置随发行版交付的编码 agent persona（"You are a coding agent powered by the {{model}} model..."）；`agent-loop` 把单个预创建的 `main` agent 绑定到调用目录的 `deepseek-official`／`deepseek-v4-pro`；`llm-deepseek` 设置全量思考与最大推理强度；`session-query-sqlite` 把 `/resume` 搜索索引指向进程本地的可丢弃 SQLite 文件。插入的行补上仅终端使用的表面：`tui-startup`（`@deepseek-ai/dsh-tui-app/startup`）解析 `--resume` 旗标族并提供 launcher 拥有的启动槽；`session-reference` 与 `storage`／`storage-json`／`storage-domain`／`session-projection-cache` 组在共享的 Harness home 存储根之上挂载派生会话索引与持久检查点缓存；`tmux-context` 挂载终端多路复用器上下文；`tui-prompt`（`@deepseek-ai/dsh-tui/prompt`）支撑键盘式 `ask_user_question` 对话框；`tui`（`@deepseek-ai/dsh-tui`）以 `showReasoning: true` 与 `maxToolOutputLines: 6` 渲染该表面；`tool-ask-user` 提供这些对话框读取的 ask-user 队列。

`tui-startup` 负责启动胶水：它铸造会话身份（全新时为 `main-session-<uuid>`，或 `--resume <id>` 指定的被恢复 id），提供 `configuredAgentIdentities`、再见行、可丢弃的查询索引路径，以及在 `process.execve` 存在时的 `tuiResumeHost` 移交——先 chdir 进入目标工作区，dispose 应用 fiber，再原地替换进程。SQLite 查询索引（OS 临时目录下的 `session-query-<pid>-<uuid>.db`）是进程本地的：只有一个写入者，清理 effect 会在拆除时连同 WAL/SHM 一起删除该文件。

## 模型体验

### 请求路由

#### 模型看到什么

该组合包挂载子插件并 patch base 行；模型可见文本由被组合的行持有，而非本包。`system-prompt` 提供模型看到的 persona，`agent-loop` 固定模型路由与会话身份，`llm-deepseek` 设置思考／推理强度默认值；`tui-startup` 只提供行读取的配置值（`tuiStartup.sessionId`、`tuiStartup.sessionQueryPath`），自身不贡献任何提示词内容。由 `dsh-base` 组装的提示词基座加上 `system-prompt` persona 使 agent 由 `agent-loop` 绑定到 `deepseek-official`／`deepseek-v4-pro`，`tui` 行（`@deepseek-ai/dsh-tui`）渲染该 agent 的 transcript；本组合包没有向对话加入第二个声音。

#### Token 影响

该 patch 自身不组装任何提示词文本，因此除被组合的 base 提示词与会话历史外不增加每个请求的 token。宿主侧机制——`session-projection-cache` 的检查点写入与 `/resume` 背后的 `session-query-sqlite` 索引——不进入模型上下文。

#### KV Cache 影响

无直接影响；组合包选择行并通过 `tui-startup` 提供配置，而适配器（`llm-deepseek`）与 `tui` 渲染器持有任何请求形态的影响。每个被挂载行的包各自记录自己的影响。

## 已知限制与暂缓事项

- **patch 会替换整行 `config`**：`cordis.patch.yml` 重述每行拥有的每个键，针对这些 id 的 profile 或 `--patch` 覆盖层也必须如此；不存在深度合并层。
- **`/resume` 查询索引是进程本地且可丢弃的**：`tui-startup` 在 OS 临时目录下创建 `session-query-<pid>-<uuid>.db`，并在拆除时连同 WAL/SHM 一起删除，因此每个进程都会从持久会话日志根重新构建索引，而不是复用持久的索引文件。
- **原地恢复移交需要 `process.execve`**：`tui-startup` 仅在入口脚本与 `process.execve` 都存在时提供 `tuiResumeHost`；没有 execve 的宿主必须恢复终端后另行重新调用。
