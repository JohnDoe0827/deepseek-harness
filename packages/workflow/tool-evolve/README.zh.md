# @deepseek-ai/dsh-tool-evolve

[English](README.md) | 中文

模型可用的 `evolve` 工具通过固定前台工作流，从**种子**经显式迭代成长为成型的**节点**。每一轮开启全新子代理（无父对话、无先前子会话），喂入不可变种子、上一节点、每轮**养料**与当前**突变**；子代理执行具体工作并返回一个结构化节点。`regress` 时本轮改动被丢弃（子代理撤销自己的工作区编辑），下一轮携带该节点的突变以不同方向分支——基于[工作流引擎](../workflow/README.md)与[子代理接缝](../../subagent/subagent/README.md)的 DNA 式进化。

## 契约

`evolve({ seed, iterations, nutrients?, nodeMode?, mutateOnRegress? })` 等待整个运行结束。部署配置的 `maxIterations` 既是默认值也是调用覆盖的上限。每轮经 `subagentProvider` 启动一个子代理；该提供者必须存在、支持结构化输出且声明 `inheritsParentContext: false`。配置的提供者随 `WorkflowStartRequest.subagentProvider` 传递；解析后的迭代上限随 `maxTotalAgents` 传递。

每个子代理获得：种子（不可变）、轮次与迭代数、工作区/报告模式指令、上一节点、本轮养料、当前突变。节点携带 `verdict: continue | complete | blocked | regress`、非空 `summary` 与 `work`、证据字符串、`mutation` 字符串（可为空）。`nodeMode: 'report'` 禁止写工作区；默认 `'workspace'` 执行具体工作，并在 `regress` 时指示子代理在返回节点前用 `git checkout -- .`（或等价命令）撤销其改动。

成功终止的工具结果为 `complete`、`blocked` 或 `budget-limited`，携带最后节点与迭代数。规范信封是 `{ runId, agentsStarted, result }`；渲染器说明是工作人报告的结果而非独立认证。`maxNodeChars` 限制单个节点的序列化长度（在工作流内与消费边界双重校验）；`maxResultChars` 只限制渲染文本。

普通子代理失败产生指出失败轮次的错误，并在存在时保留最后一个成功节点。Evolve 不重试该轮；取消同样是错误，部分输出从不视为成功。

## 生命周期与取消

调用者的代理是每个新子代理的父级。`exec.signal` 进入工作流引擎并桥接到 `run.cancel()`。工具 `await run.result` 并在 `finally` 调用 `run.dispose()`。

## 渲染意图

待处理调用为标题 `evolve` 的 `generic` 卡片；种子作为其 `rawInput`。结果保持 generic 卡片。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 每轮使用的全新结构化输出提供者。 |
| `maxIterations` | `256` | 一次 evolve 运行的默认与部署上限。 |
| `maxNodeChars` | `16384` | 单个节点交接的序列化上限。 |
| `maxResultChars` | `16384` | 面向父级的渲染文本上限。 |
| `nodeMode` | `workspace` | `workspace` 写入共享工作区；`report` 仅结构化。 |

## 已知限制与待办

- **节点持久化由调用方负责**——工具在规范结果中返回节点；持久的逐轮节点台账（如 `.evolve/nodes/`）是后续项，不在本次范围内。
- **回溯依赖子代理的工具**——脚本无文件系统；regress 轮依赖子代理实际撤销其工作区改动（仅提示，不强制）。