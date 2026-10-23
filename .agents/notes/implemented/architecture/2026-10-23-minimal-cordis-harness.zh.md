# Agent Note: 一份最小的 Cordis harness 放在产品旁边

Status: implemented

[English](2026-10-23-minimal-cordis-harness.md) | 中文

## 问题

产品 harness 是一棵很大的插件树：会话日志、审批、沙箱、Web UI 和模型适配器一起加载。想看清 agent loop（智能体循环）如何落在 Cordis 上的人，得先读这整棵树。循环本身是个很小的想法：一个工具注册表、一个模型，以及一个反复「询问模型、执行工具」直到模型停止的插件。Harness 0.2.1 还让会话日志成为模型历史的来源，让工具向系统提示词贡献文本，并让每次工具调用经过 `tools/execute` waterfall（瀑布式事件），监听方可以在调用 `next()` 之前返回来停住它。

## 决策

[`mini-harness/`](../../../../mini-harness/README.md) 是一个 Cordis 应用。[`vendor/cordis/bin.js`](../../../../vendor/cordis/bin.js) 加载它的 `cordis.yml`。这些插件共用一个上下文。`session` 是一份只存在于内存中的只追加日志，模型历史是它的投影。`systemPrompt` 把其他插件贡献的片段拼在一起。`prompt` 贡献 `tools.schemaText()`，并同时注入 `systemPrompt` 和 `tools`，因为读取 `ctx.tools` 的 fiber 要在 `inject` 里列出 `tools`。`tools` 保存工具定义，并让每次调用经过 `tools/execute` waterfall。当工具名在 `deny` 里时，`policy` 在调用 `next()` 之前返回 `Denied tool: <name>`（默认空列表，因此每个工具都会运行）。`scripted-llm` 把两句用户输入（`add <number> and <number>`、`echo <text>`）变成一次工具调用，再把工具结果变成最终文本。它收到日志里的系统提示词文本，但不读取这段文本。`agent` 追加这一轮，在系统提示词变化时把它记下来，并反复调用模型与工具，直到模型不再返回工具调用，或用尽 `maxSteps`（默认 4）。`builtins` 注册 `add` 与 `echo`，该插件卸载时它的 disposer 会把这两个工具去掉。`cli` 从命令行读取一句提示，并打印每一步。

模型就是 `llm` 服务。`scripted-llm` 那一行是唯一的模型条目，因此另一个提供 `llm` 的插件可以替换它。这个目录只导入 `@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery`。没有任何 `dsh` profile 挂载它。保存到磁盘的会话文件、审批服务、沙箱和 UI 留在产品里。

## 考虑过的替代方案

**裁剪过的 headless profile。** 那种组合仍然会加载产品包，文件数量也就还是产品的规模。这份示例存在的目的，就是让人在不引入那些包的情况下读懂循环。

**挂上 0.2.1 的产品包。** 那些包带着 profile、可持久化的 JSONL 会话世代、桌面与 Web UI、沙箱、审批服务和 subagent。上面三个机制，才是值得抄进一份仍然很小的程序里的部分。

**放进 `examples/`。** [examples/](../../../../examples/AGENTS.md) 启动的是真正的 harness，每个叶子的测试也驱动那份组合。把一份从零写起的循环放在那里，它就会被按产品名册来要求。

**合成一个源文件。** 单个文件也能打印出答案，但那样就看不出循环、工具和模型是通过上下文相遇的独立插件。

## 后果

这份示例可能与产品循环逐渐分叉。它是一段教学程序：一份内存中的日志、两个工具、由工具 schema 拼成的系统提示词、工具 waterfall 上的拒绝列表，以及一个脚本模型。要调用真实模型，就替换 `llm` 插件。产品代码不导入这份示例。
