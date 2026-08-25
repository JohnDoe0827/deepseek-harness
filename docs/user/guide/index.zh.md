# 使用终端界面（TUI）

[English](index.md) | 中文

在终端中运行 `dsh`，即可在调用目录打开全屏终端界面（TUI）；调用目录同时也是 agent 的工作区，文件系统与 shell 工具都从它解析路径。会话持久化在 Harness home 之下，因此 `/resume` 可以到达所有工作区。

## 配置模型

`dsh` 从凭据存储解析 DeepSeek 路由：在环境中、调用目录的 `.env` 或 Harness home 的 `.env`（默认 `~/.dsh/.env`）里设置 `DEEPSEEK_API_KEY`，然后运行 `dsh`。在 TUI 内使用 `/model` 可以为后续请求切换提供方或模型。

[模型配置指南](./providers.md)介绍其他提供方和自定义 OpenAI 兼容端点。

## 运行任务

输入提示词并按回车：

> Summarize this repository and identify its main packages.

agent 可以读取和编辑工作区文件、运行命令、委派工作并维护计划。当操作在当前权限策略下需要审批时，TUI 会先询问你。回合运行时按 `Ctrl+C` 可取消；空闲时再按一次即可退出。

## 会话

每个会话都持久化在调用目录的工作区。TUI 退出时会打印恢复该会话的命令；`/resume` 可以列出跨工作区的持久化会话。之后可用以下命令重新进入：

```sh
dsh --resume <id>
```

TUI 会恢复对话记录，并进入被恢复会话所在的目录，文件系统与 shell 工具再次从该目录解析路径。

## 继续使用

- [配置模型](./providers.md)
- [使用 Web UI](./web.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)
