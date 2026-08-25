# @deepseek-ai/dsh-codewhale-constitution

[English](README.md) | 中文

DeepSeek Harness 上的 CodeWhale 风格宪法：工作区文件声明常驻指令（注入每次模型请求）和写保护（无论审批姿态如何都拒绝工作区文件改动）。

宪法文件（`Config.file`，相对每个会话的工作目录解析）在每次使用时惰性读取并校验，因此编辑后在下一次写决策或请求组装时立即生效，无需重载命令。文件缺失表示没有宪法；文件损坏会响亮地失败写决策或请求组装，而不是被忽略。

## 组合方式

插件注册 `codewhale:constitution` 系统提示分段（order 60）和两个 fs 决策瀑布（`fs/write-intent`、`fs/edit-intent`），使用 `prepend: true`，因此无论挂载顺序如何，本策略都先于观测策略运行。被保护路径的写入从工具管道已经为模型映射错误的同一槽位抛出 `FsError`（`FS_PERMISSION_DENIED`）。`/constitution` 命令（通过 `ctx.commands` 组合）打印当前文件、指令长度和写保护列表。

### 宪法文件

带两个可选键的 YAML 映射：

```yaml
instructions: |
  Standing guidance for every request in this workspace.
writeHolds:
  - '**/secrets/**'
  - package-lock.json
```

`writeHolds` 条目是相对工作区路径匹配的 glob 模式（`dot: true`，因此 `.env` 这样的显式模式可以匹配）。匹配目录后代需要递归形式（`**/secrets/**`）。指令分段还会列出当前生效的保护，让模型在尝试写入前就知道哪些路径被保护。

## 模型体验

### 宪法指令与写保护

#### 模型看到什么

`codewhale:constitution` 分段文本：文件的 `instructions` 原文，加上一行列出当前生效的写保护（如果有）。没有宪法文件的会话贡献空分段。

#### Token 影响

每请求有条件：分段文本即宪法文件大小，文件不变则各请求间不变。

#### KV Cache 影响

文件不变时前缀稳定；编辑文件会改变请求前缀并使下一次请求的缓存复用失效。

## 已知限制与待办

- **Shell 写入绕过保护** — 瀑布只守护面向模型的 fs 工具（`tool-fs`、`tool-str-replace-editor`）；通过 shell 命令写入被保护路径不会被阻止。沙箱策略内的路径级拒绝留待后续。
- **仅限按会话文件** — 宪法相对每个会话的工作目录解析；不支持与工作区无关的 home 级宪法。
- **同步文件读取** — 提示分段同步渲染，因此每次组装都会阻塞读取宪法文件一次（在单次启动内按 mtime 缓存）。
