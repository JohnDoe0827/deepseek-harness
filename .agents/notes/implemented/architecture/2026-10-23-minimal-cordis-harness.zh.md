# Agent Note: 一份最小的 Cordis harness 放在产品旁边

Status: implemented

[English](2026-10-23-minimal-cordis-harness.md) | 中文

## 问题

产品 harness 是一棵很大的插件树：会话日志、审批、沙箱、Web UI 和模型适配器一起加载。想看清 agent 循环如何落在 Cordis 上的人，得先读这整棵树。循环本身是个很小的想法：一个工具注册表、一个模型，以及一个反复「询问模型、执行工具」直到模型停止的插件。

## 决策

[`mini-harness/`](../../../../mini-harness/README.md) 是一个 Cordis 应用。[`vendor/cordis/bin.js`](../../../../vendor/cordis/bin.js) 加载它的 `cordis.yml`。五个插件共用一个上下文。`tools` 保存工具定义并执行调用。`scripted-llm` 把两句用户输入（`add <number> and <number>`、`echo <text>`）变成一次工具调用，再把工具结果变成最终文本。`agent` 反复调用模型与工具，直到模型不再返回工具调用，或用尽 `maxSteps`（默认 4）。`builtins` 注册 `add` 与 `echo`，该插件卸载时它的 disposer 会把这两个工具去掉。`cli` 从命令行读取一句提示，并打印每一步。

模型就是 `llm` 服务。`scripted-llm` 那一行是唯一的模型条目，因此另一个提供 `llm` 的插件可以替换它。这个目录只导入 `@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery`。没有任何 `dsh` profile 挂载它。

## 考虑过的替代方案

**裁剪过的 headless profile。** 那种组合仍然会加载产品包，文件数量也就还是产品的规模。这份示例存在的目的，就是让人在不引入那些包的情况下读懂循环。

**放进 `examples/`。** [examples/](../../../../examples/AGENTS.md) 启动的是真正的 harness，每个叶子的测试也驱动那份组合。把一份从零写起的循环放在那里，它就会被按产品名册来要求。

**合成一个源文件。** 单个文件也能打印出答案，但那样就看不出循环、工具和模型是通过上下文相遇的独立插件。

## 后果

这份示例可能与产品循环逐渐分叉。它是一段教学程序：一句只存在于内存中的提示、两个工具，以及一个脚本模型。要调用真实模型，就替换 `llm` 插件。示例不增加会话日志、审批、沙箱或 UI，产品代码也不导入它。
