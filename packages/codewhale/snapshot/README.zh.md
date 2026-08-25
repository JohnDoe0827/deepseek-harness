# @deepseek-ai/dsh-codewhale-snapshot

[English](README.md) | 中文

DeepSeek Harness 上的 CodeWhale 风格回合快照：每回合结束后，插件在内容指纹变化时将会话的工作区（减去 `Config.excludes`）复制到 `Config.dir/<sessionId>/<seq>/`，`/undo` 和 `/restore` 命令将工作区回滚到更早的快照。

快照是完整拷贝，因此无论期间有多少编辑，`undo`/`restore` 都精确；指纹跳过让未变化的回合不增长存储。快照在 `turn/end` 之后异步进行，每会话一个进行中的快照。恢复是持久的 `snapshot/restore` 事件，恢复后的状态通过注入的提示告知代理，因此模型绝不会在一个它不知情的工作区上工作。

## 组合方式

插件挂钩 `session/event` 的 `turn/end`，并通过 `ctx.commands` 注册 `/undo` 和 `/restore`：

- `/undo` — 恢复最近一次变化之前的快照（只有一个快照时报错）。
- `/restore` — 列出快照（序号、来源回合、文件数、时间）。
- `/restore <seq>` — 恢复指定快照。

快照存储布局为 `<dir>/<sessionId>/<seq>/`，每个快照带一个 `meta.json` 伴生文件。`Config.workspace` 覆盖会话工作目录作为快照根；`Config.excludes` 跳过路径段匹配的条目（例如 `node_modules`、`.git`）。

## 模型体验

### 快照与恢复提示

#### 模型看到什么

恢复会注入一条提示：`The workspace was restored to snapshot <seq> (taken after turn <turn>).` 快照本身对模型不可见；`snapshot/taken` 与 `snapshot/restore` 是持久的纯日志事件。

#### Token 影响

快照为零直接 token；每次恢复注入一条简短提示。

#### KV Cache 影响

独立：快照从不触碰请求前缀。恢复会改变模型可能已读过的文件，注入的提示作为新的用户角色消息进入下一次请求。

## 已知限制与待办

- **整工作区拷贝** — 每个有变化的回合都复制完整工作区（减去 excludes）；大型仓库每次回合都要付出拷贝成本。增量差异留待后续。
- **恢复保留额外文件** — 快照之后创建且快照中不存在的文件保留原样；恢复只覆盖和重建快照中的文件。
- **无快照投影** — Web UI 没有快照视图；`/restore` 列表是唯一界面。
- **异步快照** — 快照在 `turn/end` 后运行，不阻塞循环；与进行中的快照竞争的 `/undo` 可能恢复到快照仍在写入的状态。
