# Agent Note: 后置 bundle 添加的模型可见行无法在 Web 上禁用

Status: implemented

[English](2026-09-10-late-bundle-tool-row-web-boot.md) | 中文

## 问题

当 profile 的 `dsh.profile.bundles` 列出 `@deepseek-ai/dsh-observer-loop` 时，`dsh web` 拒绝启动：

```
dsh: plugin tree failed to load: dsh: 1 entry did not activate
@deepseek-ai/dsh-tool-evolve: pending (waiting for service: workflowEngine)
```

该 bundle 把 `tool-evolve` 作为宿主平面行插入，而 Web bundle 禁用了提供 `workflowEngine` 的宿主平面 `workflow-worker-thread` 行，并把每个模型可见行移到按会话挂载的 agent preset 之后（见 [preset 接管 agent 平面后哪些东西留在宿主平面](2026-08-10-host-plane-ownership-after-presets.md)）。该行永远无法激活，而启动审计会拒绝一棵包含 pending 条目的已稳定插件树。

在 Web bundle 中补上对应的 `disabled: true` 无法修复：补丁列表按 `dsh.profile.bundles` 顺序依次应用，按 id 定位的补丁只能命中更早层插入的行，匹配不到任何行的补丁会被跳过并给出警告。用户通过 `dsh plugin --profile <name> add` 追加 bundle，因此模式 bundle 总是先于后加入的 bundle 应用。

## 决定

模型可见的宿主平面行放在 `dsh-base`——每个 profile 最先应用的一层。`tool-evolve` 行从 `dsh-observer-loop` 移入 `dsh-base`，与 `tool-ralph` 相邻；Web bundle 把它与其他 agent 平面行一起禁用；每个随附 preset（`standard`、`code`、`cordis`）在 delegation 组隔离的 `workflowEngine` realm 内挂载自己的 `tool-evolve`。于是该工具在 TUI 与 headless 表面来自宿主，在 Web 会话来自其 preset；`dsh-observer-loop` 恢复为两个韧性行（`observer`、`context-handoff`）。

## 测试

`apps/cli/tests/web-agent-presets.e2e.ts` 在真实 Web 组合上断言两端：全局工具层保持为空，且 `standard` agent 目录携带来自其 preset 的 `evolve`。`packages/bundle/base/tests/base.spec.ts`、`packages/bundle/web-app/tests/` 与 `packages/bundle/observer-loop/tests/observer-loop.spec.ts` 覆盖三个补丁列表。在列出 `@deepseek-ai/dsh-observer-loop` 的 profile 上实际启动 `dsh web`，可到达服务端口且无 pending 条目。

## 考虑过的备选方案

**只加 Web 禁用而不搬移该行。** 不采用：对任何用户追加的 bundle，Web 层都先应用，因此补丁匹配不到行、被跳过，启动失败依旧。

**在 Web 上恢复宿主 `workflow-worker-thread` 使该行能激活。** 不采用：宿主行会把 `evolve` 注册到全局层，而 preset 又会按会话注册一次——同一个工具出现两份组合，违反 Web 组合测试锁定的"全局层为空"不变量。

**只在 preset 中提供该工具。** 不采用：TUI 与 headless 表面在进程级组合其 agent、不挂载 preset 名册，会彻底失去该工具。

## 后果

每个随附表面都保留 `evolve` 工具——TUI 与 headless 上是宿主平面，Web 上按 preset 作用域——且模式 bundle 之后追加的 bundle 再也不会因为携带模型可见行而破坏 Web 启动。Web bundle 的 agent 平面小节记录了以下规则：它所禁用的行必须由更早的层插入。
