# 最小 Cordis harness

[English](README.md) | 中文

这个目录是一份用 Cordis 插件写成的 agent loop（智能体循环）。它使用 `vendor/` 里自带的框架，不加载 DeepSeek Harness 的产品包。Harness 0.2.1 里的三个想法在这里以很小的形式出现：一份只追加的会话日志、一份由工具贡献文本的系统提示词，以及一条 `tools/execute` waterfall（瀑布式事件），策略插件可以在调用 `next()` 之前返回来把它停住。

## 运行

在本目录执行：

```sh
node --import tsx ../vendor/cordis/bin.js add 2 and 3
```

进程打印：

```text
step 1: add {"a":2,"b":3}
tool add -> 5
step 2: 5
5
```

`echo hello` 返回 `hello`。其他提示返回 `Ask me to add two numbers, or to echo some text.`

## 插件

| 文件 | 服务 | 职责 |
|---|---|---|
| `src/session.ts` | `ctx.session` | 只追加的会话日志；模型看到的历史是它的投影 |
| `src/system-prompt.ts` | `ctx.systemPrompt` | 收集系统提示词片段并拼在一起 |
| `src/tools.ts` | `ctx.tools` | 注册工具，并通过 `tools/execute` 执行 |
| `src/prompt.ts` | | 把每个工具的 schema 写进系统提示词 |
| `src/scripted-llm.ts` | `ctx.llm` | 把一句提示变成文本或一次工具调用 |
| `src/builtins.ts` | | `add` 与 `echo` 两个工具 |
| `src/policy.ts` | | 在调用 `next()` 之前返回，从而拒绝列出的工具 |
| `src/agent.ts` | `ctx.agent` | 反复调用模型与工具，直到模型不再调用工具 |
| `src/cli.ts` | | 读取提示并打印过程 |

`cordis.yml` 就是整个应用。`agent.maxSteps` 默认是 4。`policy.deny` 默认是空列表，因此每个已注册的工具都会运行。

## 会话、提示词与工具

日志是模型所见内容的来源。`agent` 追加 `turn/start`、`user/message`、`system/message`、`assistant/message`、`tool/call`、`tool/result` 和 `turn/end`。`session.messages()` 从这份日志重建用户、助手和工具消息。系统提示词文本在这些消息旁边传给模型。日志只留在这一个进程的内存里。

`prompt` 注册一节系统提示词，内容来自 `tools.schemaText()`。读取 `ctx.tools` 的 fiber 在 `inject` 里列出 `tools`。`prompt` 注入 `systemPrompt` 和 `tools`，因此 agent 渲染这一节时读取仍然有效。

`tools.execute` 就是 `tools/execute` waterfall。`policy` 监听它；当工具名在 `deny` 里时，它返回 `Denied tool: <name>`，并且不调用 `next()`。拒绝文本记成工具结果，脚本模型再把这段文本返回。

## 换一个模型

`ctx.agent` 调用 `ctx.llm.complete`。替换用的提供方是另一个注册 `llm` 服务的插件。把 `cordis.yml` 里的 `scripted-llm` 那一行指到那个文件。脚本模型收到系统提示词文本，但不读取它。日志仍然记下这段文本。

## 检查

```sh
node --import tsx --test src/loop.test.ts
```

测试在进程内启动这些插件，并通过 `vendor/cordis/bin.js` 运行 `cordis.yml`。
