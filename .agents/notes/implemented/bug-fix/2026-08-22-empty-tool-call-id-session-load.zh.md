# Agent Note: Accept self-consistent empty tool call ids at session load

Status: implemented

[English](2026-08-22-empty-tool-call-id-session-load.md) | 中文

## Problem

一条线上会话的 provider 输出了无名工具调用（`tool_calls` 携带 `id: ""` 且没有 `function.name`），此后该会话拒绝加载。harness 忠实地记录了这条退化调用——`assistant/message` 块里的工具调用 id 为空、`tool/call` 事件的 `callId` 为空、`tool/result` 的 "unknown tool" 错误结果其 `source.callId` 同样为空——日志内部保持一致（调用 `""` 与结果 `""` 配对）。但加载时的快照校验（[identified immutable message values](../architecture/2026-07-28-identified-immutable-message-values.md)）把任何空的 `callId` 当作损坏拒绝，于是该会话的第一次冷读以 `SessionPersistenceCorruptionError` 失败，历史不可用。观察到的触发点是风格变阻器（滑动变阻器）的 off 状态：`/rheostat off` 之后，模型在调查正是它自己造成的 "unknown tool" 噪音时发出了这条畸形调用。rheostat 插件的 off 路径本身是干净的；畸形调用是 provider 输出，harness 必须对其保持可加载。

## Decision

对 `packages/core/session` 的两处修改。

`assertMessageEventShape` 现在接受 `tool/result` 消息上存在但为空的 `callId`：source 仍必须是 `kind: 'tool'` 且 `callId` 为字符串，且唯一的 `tool-result` 块仍必须恰好引用该 callId，因此撕裂或不匹配的写入仍然失败。自洽的空 callId 可以端到端回放——provider 往返、工具配对、轨迹、统计都把它当作不透明字符串——所以把它当作损坏拒绝，超出了加载器"拒绝无法忠实解读的日志"的职责范围。

`Session.append` 现在在事件进入日志之前，强制执行与加载路径和 seed 路径相同的消息形状不变量。这关闭了最初写入不可加载事件的非对称：此前写路径只校验 JSON 可序列化性和 surface 元数据，而加载路径额外校验消息形状，因此生产者可以持久化任何后续加载都不会接受的事件。append 位点是最早的可解决点，也符合该方法文档化的约定——坏事件应在 append 处失败，而不是在 backend flush 时失败。

## Alternatives considered

**在加载时修复空的 call id。** 被拒：要让结果的 callId 非空，必须同时改写配对的 `tool/call` 事件和 assistant 消息的 tool-call 块，这会改变模型可见历史并破坏该轮 provider 的 `tool_call_id` 关联——这是改写，不是修复。

**在加载时丢弃违规事件。** 被拒：模型看到过那个错误结果；把它从派生 surface 中移除会破坏工具配对与 provider 转录的平衡。

**当模型发出无名工具调用时让整轮失败。** 被拒：优雅的 "unknown tool" 错误结果对用户只是观感问题（"不影响结果但影响观感"），而整轮硬失败会中断长时间运行的 agent 工作；让已记录的事件可加载已经足够。

**保持严格加载校验、只修生产者。** 被拒：已存储的会话仍然不可加载，而这正是本笔记要消除的故障。

## Consequences

包含自洽空 callId 工具结果的会话现在可以加载、回放、恢复；`load`、`readFrom`、`inspect` 返回完整日志。写路径现在拒绝任何加载路径会拒绝的消息形状，两条边界不会再分叉；缺失身份、角色错误、source 无效、或工具结果缺少匹配工具 source 的消息形状 append 现在会在 append 位点抛出。空 callId 仍是模型侧噪音：它会在日志中表现为 "unknown tool" 错误结果，并以空的 `tool_call_id` 原样发送给 provider，按发出内容如实记录。
