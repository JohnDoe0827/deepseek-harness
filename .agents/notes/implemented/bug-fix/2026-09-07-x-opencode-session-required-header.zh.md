# Agent Note: 在 OpenCode Go 请求上发送 x-opencode-session 头

Status: implemented

[English](2026-09-07-x-opencode-session-required-header.md) | 中文

## 问题

OpenCode Go 托管推理 API 运营方要求每个请求都携带 `x-opencode-session` 头——一个用于路由与提示缓存优化的稳定会话级 id——并声明从 2026-09-05 起，缺少该头的请求将报错。其遥测显示 harness 各版本中该头的存在率接近为零，因此 harness 发出的每一个 `opencode-go/*` 模型请求都将走向硬失败。适配器的请求头原本只有 authorization、content type、accept 与 attribution；没有任何东西携带会话身份。

## 决定

`dsh-llm-opencode-go` 适配器在每个 chat-completions 请求上都发送 `x-opencode-session`。其值取请求的 harness 会话 id（`GenerateOptions.sessionId`，agent 循环、压缩摘要器与会话标题 provider 都以持久的会话级 id 标记它），因此同一会话的重复请求——包括续传——向运营方路由与缓存复用所依赖的键呈现同一个稳定 id。位于 harness 会话之外（无会话 id）的请求每次携带一个新 UUID，从而保证必需的头始终存在，又不虚构跨请求共享的身份。这正是 `dsh-llm` 中已文档化的 `sessionId` 映射钩子（"adapters may map it to model-hidden transport metadata"）；核心 llm 契约零改动。

## 考虑过的备选方案

**仅当存在会话 id 时发送该头。** 不采用：运营方的要求是无条件的——截止日后任何缺少该头的请求都会报错，而 `GenerateOptions` 并不保证手工构建的调用一定带有会话 id。

**所有无会话请求共用一个静态回退 id。** 不采用：该头命名的是"会话"；共享值会把互不相关的会话并入同一个 provider 侧路由/缓存命名空间。

**提供配置项来提供或禁用该值。** 不采用：存在性与按会话语义是固定的 provider 契约，不是随部署变化的可选配置，也没有消费者需要覆盖它。

## 后果

每个真实会话请求现在都携带其稳定会话 id：既在运营方截止日后保持请求有效，也让 OpenCode Go 能在同一会话的各轮之间复用提示缓存状态。无会话请求以每次一个新 UUID 保持有效，代价是没有缓存复用（此前本就没有）。单元测试锁定两种行为：同一会话的两次请求携带完全相同的头值，无会话请求发送 UUID。README 的 KV Cache 影响一节记录了该头。细化 [OpenCode Go provider 适配器](../feature/2026-08-14-opencode-go-provider.md) 与其[直连传输](../feature/2026-08-21-opencode-go-direct-connection.md)的请求接线——两者此前均未覆盖请求头。
