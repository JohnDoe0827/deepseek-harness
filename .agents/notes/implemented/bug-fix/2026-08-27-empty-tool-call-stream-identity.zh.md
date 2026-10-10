# Agent Note：跨流式占位符保留工具调用身份

Status: implemented

[English](2026-08-27-empty-tool-call-stream-identity.md) | 中文

## 问题

harness 启动后，凡是会发出工具调用的模型轮次都可能退化成**无名调用循环**：组装出的 assistant 消息携带 `id: ''`、`name: ''` 的 `tool-call` 块，工具运行时以 `unknown tool ""`（`UNKNOWN_TOOL`）拒绝它，模型随后反复重试同一个非法调用——每次重试都以相同方式失败，为永远无法路由的工具持续烧 token。用户看到的症状是"harness 启动后不停触发 tool 为空错误"。

根因是流式路径上三层叠加缺陷：

1. **wire 翻译层**（`dsh-llm-opencode-go` 与 `dsh-llm-deepseek` 两个适配器）：合规的 OpenAI 风格流把 `id`/`name` 放在 `tool_calls` 首帧，后续参数增量帧省略它们。而 OpenCode Go 网关（现场观测）在每一帧都显式回显 `null`/`""` 占位符。两个翻译器用 `!== undefined` 判断后赋值，于是这些占位符以 `null`/`""` **覆盖**了首帧身份。

2. **`BlockAssembler.push`**（`dsh-llm`）：`tool-call-delta` 无条件执行 `partial.toolCallId = chunk.id`，后续空 id 增量会冲掉已捕获的 id；name 路径本来就有 truthy 守卫，id 路径却没有。

3. **`BlockAssembler.push` 的 block-end**：`block-end` 用 provider 组装好的块**整体替换** `partial.block`。由于翻译器经 `closeBlock()` 以 `?? ''` 兜底闭合块，block-end 携带的正是已被清空的 id/name，抹掉了增量已捕获的值。

## 决策

三处改动，各自卡在窄边界：

1. **两个 `translate.ts` 适配器**仅在 wire 值是"存在且非空字符串"时才推进 `block.callId`/`block.name`。`null`/`""` 占位帧不再覆盖首帧身份。

2. **`BlockAssembler.push` 的 tool-call-delta**仅在 `chunk.id` 为真且非空时赋值 `partial.toolCallId`——与 name 路径早已应用的底限一致。

3. **`BlockAssembler.push` 的 block-end**对非 tool-call 类型保留 provider 的块；对 `tool-call`，空的 `id`/`name` 用增量已捕获的值补齐（回退到既有的生成式 `call-{index}` id）。provider 即使以空身份闭合调用，也无法抹掉增量见过的值。

## 备选方案

**只修网关侧的翻译。** 否决：assembler 是全部适配器共享的权威组装算法，同样的无名闭合形态未来可能来自任何 provider；而且无论当前网关的 wire 行为如何，delta 路径的 id 覆盖本身就是一个潜伏 bug。

**整体丢弃无名 tool-call 块。** 否决：身份未知的调用仍然带有参数与回合意图；把它记录为 `UNKNOWN_TOOL` 结果能保持会话日志忠实，而身份保留的修复让调用从一开始就可路由。

## 结果

流式工具调用无论网关如何在后续参数帧措辞，都保留其首帧身份。启动时观测到的无名调用重试循环不再出现；单元测试在翻译层与 assembler 层双重锁定该行为；此前对 `unknown tool ""` 循环的真实 headless 运行现在一次工具调用即完成。先前注册/组装门禁（2026-08-26-empty-tool-name-gate）仍是 schema 的最后防线；本 note 修复的是调用点上击穿该门禁的流式一侧。