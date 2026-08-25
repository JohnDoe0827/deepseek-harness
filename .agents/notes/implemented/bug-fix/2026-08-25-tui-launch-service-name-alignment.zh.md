# Agent Note:服务名与 tuiStartup 对齐后 TUI 启动器可用

Status: implemented

[English](2026-08-25-tui-launch-service-name-alignment.md) | 中文

## 问题

TUI 恢复后,用 `pnpm dsh` 启动组装好的 `tui` profile 时,插件树加载以两种独立方式失败:

1. `@deepseek-ai/dsh-tui` 声明了 `inject: ['userInteraction']`,但当前 core 把 ask-user 队列作为 `userQuestions` 服务(`@deepseek-ai/dsh-user-questions`)发布。条目一直停留在 `pending (waiting for service: userInteraction)`,启动以 "1 entry did not activate" 中止。恢复说明对齐了 import 与服务用法,但插件的 inject 列表仍携带移除前的服务名。

2. 修复上述问题后,`packages/bundle/tui-app/cordis.patch.yml` 的 `tui` 行失败:它在配置插值里读取 `ctx.tuiStartup.sessionId`,却没有声明 `inject: [tuiStartup]`。加载器以 "cannot get property \"tuiStartup\" without inject" 拒绝该表达式。

## 决策

两个单行对齐修复:

- `packages/ui/tui/src/index.ts` 现在注入 `userQuestions`(注释也改为当前服务名);`tests/plugin-shape.spec.ts` 期望同样的列表。
- `packages/bundle/tui-app/cordis.patch.yml` 给 `tui` 行加上 `inject: [tuiStartup]`,与已经读取启动器所有值的 `agent-loop`、`session-query-sqlite` 行一致。

## 验证

- `packages/ui/tui/tests/plugin-shape.spec.ts` 与 `chat-helpers.spec.ts` 通过。
- 在 PTY 下执行 `timeout 10 script -qec "pnpm dsh"` 渲染出 TUI(状态行、`dsh >` 提示符、banner)而非失败;常驻 UI 的 10 秒超时按设计以 124 退出。