# Agent Note: 滑动变阻器插件

Status: implemented

[English](2026-08-14-style-dial-rheostat.md) | 中文

## Problem

用户希望在 harness 中拥有一个有趣的、可持久化的"模式"控制：一个在 0（极简、安静的回答）与 1（饱满、热烈的回答）之间连续滑动的变阻器，按会话切换模型的回答风格。现有树中没有任何功能覆盖连续可调的回答风格：plan mode 是布尔协作状态，persona 是静态部署配置，time-context 注入的是事实而非风格。

## Decision

**新增 `dsh-rheostat` 包（`packages/context/rheostat`），把每会话风格变阻器挂进基础组合包。** 变阻器是 [0, 1] 之间的一个数字，默认 0.5。它：

- **是可持久化的会话状态** —— 以 `rheostat/position` 会话事件落盘（仅日志、非表层、整值替换、最后一次写入生效），因此恢复与派生（fork）都能还原它，会话日志始终是唯一事实来源；invariant 伴生插件拒绝日志中不一致的位置。
- **模型可见** —— `rheostat:style` 提示片段（order 40，位于人格 0 之后、plan-mode 指导 50 之前）渲染折叠位置及其区间的风格指令：≤ 0.25 为极简 0 模式，≥ 0.75 为饱满 1 模式，中间为混合。plan-mode 规则因渲染在后，在计划评审期间仍可覆盖变阻器。
- **模型可控制** —— `rheostat_set(position)` 滑动变阻器（对越界位置响亮拒绝），`rheostat_get()` 供程序化消费者读取；两者都要求拥有 agent 会话。
- **用户可控制** —— `/rheostat [<0..1>]` 命令滑动它（裸 `/rheostat` 读取）。

**用户的回合内选择沿用 plan-mode 的挂起边界。** 回合进行中发起的命令选择先挂起，直到下一个被接受的回合内 pre-step 将其落盘并把变更叙述进该次请求；挂起值对紧随其后的提示组装已可见，因此风格切换不会因边界而延迟。模型的 `rheostat_set` 在工具执行期间直接追加，与 `todo_write` 相同。这个边界之所以存在，是因为回合进行中从任意命令处理器调用 `Session.append` 不是受支持的发布点——与 [plan-mode 协作状态笔记](../simplification/2026-07-22-plan-specific-collaboration-state.md) 的理由相同。

## Alternatives considered

**像 plan mode 那样的布尔"0 或 1"模式。** 拒绝：需求明确是在 0 与 1 之间滑动，连续位置让模型和用户按比例混合风格，而不是二选一。

**对无效位置做钳制而不是拒绝。** 拒绝：模型传入 `1.5` 属于模型错误；响亮失败能教会正确的取值范围，也让 invariant（日志位置始终在 [0, 1]）平凡成立。

**可配置的默认位置与风格文本。** 推迟：默认值（0.5）与区间文本属于产品定义；部署已可在 preset 中通过遮蔽 `rheostat:style` 覆盖整个片段。

**Web UI 滑块。** 推迟：变阻器的控制（命令 + 工具）与片段就是产品；字面意义上的滑块需要一个专门的 Chat 节点渲染器，属于独立的客户端工作。

## Consequences

任何叠加基础组合包的 profile 都会获得变阻器：片段每次请求有固定的小 token 开销，滑动之间前缀稳定；滑动会改变插值文本（KV-cache 复用从新位置首次渲染的请求起失效）。`rheostat/position` 事件已进入生成的持久化 catalog。catalog 的适用范围句子现在覆盖注册工具的非 `tool-*` 包，因为 `rheostat_set`/`rheostat_get` 与其他工具一样被编目。工具、命令与片段各有单元测试覆盖；全循环 mock 模型测试与真实 Loader 组合测试证明组装后的行为。
